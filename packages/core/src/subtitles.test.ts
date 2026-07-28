import { describe, expect, it } from "bun:test";
import type { EditListDocument } from "@video-workbench/contracts";
import type { TimedWord } from "./cuts";
import {
  assertSubtitleDocument,
  buildSubtitleCues,
  createSubtitleDocument,
  DEFAULT_SUBTITLE_STYLE,
  displayColumns,
  joinWordText,
  matchSubtitleStylePreset,
  normalizeSubtitleStyle,
  subtitleCueTimings,
  subtitleStaleness,
  SUBTITLE_SCHEMA_VERSION,
  SUBTITLE_STYLE_PRESETS,
  type SubtitleDocument,
  type SubtitleStyle,
} from "./subtitles";

/** Everything retained, one segment, timeline time == source time. */
function fullEditList(duration: number): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "p",
    sourceDuration: duration,
    baseCutsRevision: "cuts",
    baseTranscriptRevision: "tr",
    mode: "cuts-derived",
    duration,
    segments: [{
      id: "seg-1",
      source: "input.mp4",
      sourceStart: 0,
      sourceEnd: duration,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    }],
  };
}

/** Two retained stretches with `cutStart..cutEnd` removed between them. */
function editListWithHole(
  duration: number,
  cutStart: number,
  cutEnd: number,
): EditListDocument {
  return {
    ...fullEditList(duration),
    duration: duration - (cutEnd - cutStart),
    segments: [
      {
        id: "seg-1",
        source: "input.mp4",
        sourceStart: 0,
        sourceEnd: cutStart,
        timelineStart: 0,
        trackId: "a-roll",
        playbackRate: 1,
      },
      {
        id: "seg-2",
        source: "input.mp4",
        sourceStart: cutEnd,
        sourceEnd: duration,
        timelineStart: cutStart,
        trackId: "a-roll",
        playbackRate: 1,
      },
    ],
  };
}

/** Consecutive one-character words, 0.2s each, starting at `from`. */
function speech(from: number, text: string, prefix = "w"): TimedWord[] {
  return [...text].map((character, index) => ({
    id: `${prefix}-${index}`,
    text: character,
    start: Number((from + index * 0.2).toFixed(3)),
    end: Number((from + (index + 1) * 0.2).toFixed(3)),
    isGap: false,
  }));
}

function gap(id: string, start: number, end: number): TimedWord {
  return { id, text: "", start, end, isGap: true };
}

describe("displayColumns", () => {
  it("uses the measured width of each character class, not a flat half for Latin", () => {
    expect(displayColumns("今天")).toBe(2);
    // G is a capital (0.7), rok are lowercase (0.55 each).
    expect(displayColumns("Grok")).toBeCloseTo(2.35, 5);
    expect(displayColumns("今天用 Grok")).toBeCloseTo(5.35, 5);
    // Whitespace was never spoken and takes no room on a centred line.
    expect(displayColumns("  今天  ")).toBe(2);
  });
});

describe("joinWordText", () => {
  it("spaces two Latin runs and nothing else", () => {
    const words: TimedWord[] = [
      { id: "a", text: "用", start: 0, end: 1 },
      { id: "b", text: "Grok", start: 1, end: 2 },
      { id: "c", text: "Code", start: 2, end: 3 },
      { id: "d", text: "写", start: 3, end: 4 },
    ];
    expect(joinWordText(words)).toBe("用Grok Code写");
  });
});

describe("buildSubtitleCues", () => {
  it("ends a screen where a sentence ended: a cue boundary the audience also hears", () => {
    const words: TimedWord[] = [
      // 0 -> 1.2, then 0.15s of silence, then 1.35 -> 2.55.
      ...speech(0, "这是前面一句", "a").map((word) => ({ ...word, cueId: "cue-1" })),
      ...speech(1.35, "这是后面一句", "b").map((word) => ({ ...word, cueId: "cue-2" })),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是前面一句", "这是后面一句"]);
  });

  it("ignores a cue boundary the audience cannot hear", () => {
    // Streaming recognition closes a cue mid-word when it revises a hypothesis.
    // No silence, so it is not a sentence end and must not split anything.
    const words: TimedWord[] = [
      ...speech(0, "他和我现在正", "a").map((word) => ({ ...word, cueId: "cue-1" })),
      ...speech(1.2, "在做的事情", "b").map((word) => ({ ...word, cueId: "cue-2" })),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["他和我现在正在做的事情"]);
  });

  it("absorbs a stub back into the line it came off", () => {
    // The 0.15s cue boundary is a sentence end by the rule above, but taking it
    // would leave a two-character screen. Judging the result overrules it.
    const words: TimedWord[] = [
      ...speech(0, "这是前面一句", "a").map((word) => ({ ...word, cueId: "cue-1" })),
      ...speech(1.35, "结尾", "b").map((word) => ({ ...word, cueId: "cue-2" })),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是前面一句结尾"]);
  });

  it("keeps a stub separate when merging it would cross deleted speech", () => {
    const words: TimedWord[] = [
      ...speech(0, "这是前面一句", "a"),
      ...speech(1.2, "这几个字被删掉", "b"),
      ...speech(2.6, "结尾", "c"),
    ];
    const cues = buildSubtitleCues(words, editListWithHole(3, 1.2, 2.6), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是前面一句", "结尾"]);
  });

  it("ends a screen at a full stop, whatever the timing says", () => {
    // 转录说句子结束了，这比任何时间证据都强：说话人可以两句连着说不喘气，
    // 也可以在一句中间停顿。
    const words: TimedWord[] = [
      ...speech(0, "这是前面一句", "a").map((word, index, all) =>
        index === all.length - 1 ? { ...word, punctuation: "。" } : word),
      ...speech(1.2, "这是后面一句", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是前面一句", "这是后面一句"]);
  });

  it("breaks a too-long run at a comma rather than inside a word", () => {
    // 这一段一个停顿都没有 —— 以前只能靠均摊，于是从词中间下刀。
    const words: TimedWord[] = [...speech(0, "如果你还想继续研究什么也可以试试这个方式")]
      .map((word, index) => (index === 8 ? { ...word, punctuation: "，" } : word));
    const cues = buildSubtitleCues(words, fullEditList(10), { maxColumns: 12 });
    expect(cues.map((cue) => cue.text)).toEqual(["如果你还想继续研究", "什么也可以试试这个方式"]);
  });

  it("ends a screen at a comma, the same rule the transcript pane uses", () => {
    // 剪口播一个逗号一段；字幕同一个粒度，两边断在同一处。
    const words: TimedWord[] = [
      ...speech(0, "这是前半句", "a").map((word, index, all) =>
        index === all.length - 1 ? { ...word, punctuation: "，" } : word),
      ...speech(1.2, "这是后半句", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是前半句", "这是后半句"]);
  });

  it("does not let the paragraph boundary fire where punctuation already decided", () => {
    // 段落边界现在就是标点处，两条规则会重复。带标点时只由标点那条管 ——
    // 真实项目上，让③也在带标点的边界触发，40 屏变 43 屏，切出更多碎屏。
    const words: TimedWord[] = [
      ...speech(0, "这是前半句", "a").map((word, index, all) => ({
        ...word,
        cueId: "cue-1",
        ...(index === all.length - 1 ? { punctuation: "，" } : {}),
      })),
      ...speech(0.75, "这是后半句", "b").map((word) => ({ ...word, cueId: "cue-2" })),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    // 断一次（逗号），不是两次（逗号 + 段落边界）
    expect(cues).toHaveLength(2);
  });

  it("merges a stub into the sentence it belongs to, not across a full stop", () => {
    // 「你看」开启新的一句，不是上一句的尾巴。往前并会得到
    // 「…调用Grok CLI你看」—— 两句话糊在一起。
    const words: TimedWord[] = [
      ...speech(0, "上一句说完了", "a").map((word, index, all) =>
        index === all.length - 1 ? { ...word, punctuation: "。" } : word),
      ...speech(1.4, "你看", "b").map((word, index, all) =>
        index === all.length - 1 ? { ...word, punctuation: "，" } : word),
      ...speech(2.0, "这才是它要说的", "c"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(4), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["上一句说完了", "你看这才是它要说的"]);
  });

  it("spreads a long run evenly instead of leaving a stub at the end", () => {
    // Greedy filling gives 6/6/3 and the last screen flashes past. Fifteen
    // columns over three screens is 5/5/5.
    const words = speech(0, "今天我们来聊一个很有意思的话题");
    const cues = buildSubtitleCues(words, fullEditList(10), { maxColumns: 6 });
    expect(cues.map((cue) => cue.text)).toEqual(["今天我们来", "聊一个很有", "意思的话题"]);
  });

  it("slides a break onto a pause when that costs little balance", () => {
    // Eight columns, limit six: the balanced split is 4/4, but there is a real
    // 0.2s pause after the fifth word and it is only one column away.
    const words: TimedWord[] = [
      ...speech(0, "今天我们来", "a"),
      { id: "g", text: "", start: 1.0, end: 1.2, isGap: true },
      ...speech(1.2, "聊话题", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), {
      maxColumns: 6,
      breakPauseSeconds: 0.32,
    });
    expect(cues.map((cue) => cue.text)).toEqual(["今天我们来", "聊话题"]);
  });

  it("gives a single word wider than the limit its own screen rather than dropping it", () => {
    const words: TimedWord[] = [
      { id: "a", text: "Supercalifragilistic", start: 0, end: 1, isGap: false },
      { id: "b", text: "另一个够长的屏", start: 1, end: 2.4, isGap: false },
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 4 });
    expect(cues.flatMap((cue) => cue.wordIds)).toEqual(["a", "b"]);
  });

  it("breaks where the audience hears a pause", () => {
    const words: TimedWord[] = [
      ...speech(0, "这是开场白", "a"),
      gap("g-1", 1.0, 1.8),
      ...speech(1.8, "这是正文内容", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(4), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是开场白", "这是正文内容"]);
  });

  it("keeps a sentence together when only a short breath separates the words", () => {
    const words: TimedWord[] = [
      ...speech(0, "这是开场白", "a"),
      gap("g-1", 1.0, 1.1),
      ...speech(1.1, "这是正文内容", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(4), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是开场白这是正文内容"]);
  });

  it("does not split a sentence just because a pause was trimmed out of it", () => {
    // 1.0-1.8 is silence and it is deleted. The words either side are one
    // sentence and must stay on one screen.
    const words: TimedWord[] = [
      ...speech(0, "这是开场白", "a"),
      gap("g-1", 1.0, 1.8),
      ...speech(1.8, "这是正文内容", "b"),
    ];
    const cues = buildSubtitleCues(words, editListWithHole(4, 1.0, 1.8), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是开场白这是正文内容"]);
  });

  it("splits where deleted speech used to be", () => {
    // 1.0-2.4 was spoken and is deleted. What is either side of it is now
    // adjacent on the timeline but has nothing to do with each other.
    const words: TimedWord[] = [
      ...speech(0, "这是开场白", "a"),
      ...speech(1.0, "这几个字被删掉", "b"),
      ...speech(2.4, "这是正文内容", "c"),
    ];
    const cues = buildSubtitleCues(words, editListWithHole(4, 1.0, 2.4), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["这是开场白", "这是正文内容"]);
  });

  it("never puts a deleted word on a screen", () => {
    const words: TimedWord[] = [
      ...speech(0, "这几个字留下", "a"),
      ...speech(1.2, "这几个字删掉", "b"),
      ...speech(2.4, "这几个字留下", "c"),
    ];
    const cues = buildSubtitleCues(words, editListWithHole(4, 1.2, 2.4), {});
    const claimed = cues.flatMap((cue) => cue.wordIds);
    expect(claimed.some((id) => id.startsWith("b-"))).toBe(false);
  });

  it("claims each word exactly once", () => {
    const words = speech(0, "今天我们来聊一个很有意思的话题");
    const cues = buildSubtitleCues(words, fullEditList(10), { maxColumns: 6 });
    const claimed = cues.flatMap((cue) => cue.wordIds);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toEqual(words.map((word) => word.id));
  });
});

describe("subtitleCueTimings", () => {
  it("reads timing off the edit list, not off the cue", () => {
    const words = speech(0, "今天我们");
    const document = createSubtitleDocument("p", "tr", words, fullEditList(1), {
      maxColumns: 40,
    });
    const [timing] = subtitleCueTimings(document, words, fullEditList(1));
    expect(timing?.start).toBeCloseTo(0, 5);
    expect(timing?.end).toBeCloseTo(0.8, 5);
  });

  it("moves a screen earlier when the edit removes time before it", () => {
    const words: TimedWord[] = [
      ...speech(0, "开场", "a"),
      ...speech(0.4, "删掉", "b"),
      ...speech(0.8, "这是正文内容", "c"),
    ];
    const document: SubtitleDocument = {
      schemaVersion: SUBTITLE_SCHEMA_VERSION,
      projectId: "p",
      baseTranscriptRevision: "tr",
      style: DEFAULT_SUBTITLE_STYLE,
      cues: [{ id: "sub-0001", wordIds: ["c-0", "c-1"], text: "这是正文内容" }],
    };
    const [timing] = subtitleCueTimings(document, words, editListWithHole(1.2, 0.4, 0.8));
    // Source 0.8 with 0.4s removed before it lands at 0.4 on the timeline.
    expect(timing?.start).toBeCloseTo(0.4, 5);
    expect(timing?.end).toBeCloseTo(0.8, 5);
  });

  it("flags a screen with more text than its time allows", () => {
    const words = speech(0, "今天我们来聊");
    const document: SubtitleDocument = {
      schemaVersion: SUBTITLE_SCHEMA_VERSION,
      projectId: "p",
      baseTranscriptRevision: "tr",
      style: DEFAULT_SUBTITLE_STYLE,
      cues: [{
        id: "sub-0001",
        wordIds: words.slice(0, 2).map((word) => word.id),
        // Six columns over the 0.4s those two words occupy: 15 columns/second.
        text: "今天我们来聊",
      }],
    };
    const [timing] = subtitleCueTimings(document, words, fullEditList(2));
    expect(timing?.tooFast).toBe(true);
  });

  it("reports a screen whose words are all gone rather than placing it at zero", () => {
    const words = speech(0, "删光", "b");
    const document: SubtitleDocument = {
      schemaVersion: SUBTITLE_SCHEMA_VERSION,
      projectId: "p",
      baseTranscriptRevision: "tr",
      style: DEFAULT_SUBTITLE_STYLE,
      cues: [{ id: "sub-0001", wordIds: ["b-0", "b-1"], text: "删光" }],
    };
    const [timing] = subtitleCueTimings(document, words, editListWithHole(1, 0, 0.4));
    expect(timing?.orphaned).toBe(true);
  });
});

describe("subtitleStaleness", () => {
  const words = speech(0, "今天我们来聊");

  function documentOf(...cues: Array<[string, string[], string]>): SubtitleDocument {
    return {
      schemaVersion: SUBTITLE_SCHEMA_VERSION,
      projectId: "p",
      baseTranscriptRevision: "tr",
      style: DEFAULT_SUBTITLE_STYLE,
      cues: cues.map(([id, wordIds, text]) => ({ id, wordIds, text })),
    };
  }

  it("is empty when nothing broke", () => {
    const document = documentOf(["sub-0001", ["w-0", "w-1"], "今天"]);
    expect(subtitleStaleness(document, words, fullEditList(2))).toEqual([]);
  });

  it("names the exact screens the edit broke, and what they lost", () => {
    const document = documentOf(
      ["sub-0001", ["w-0", "w-1"], "今天"],
      ["sub-0002", ["w-2", "w-3"], "我们"],
      ["sub-0003", ["w-4", "w-5"], "来聊"],
    );
    // Delete source 0.4-0.8, which is w-2 and w-3.
    const stale = subtitleStaleness(document, words, editListWithHole(1.2, 0.4, 0.8));
    expect(stale).toHaveLength(1);
    expect(stale[0]?.cueId).toBe("sub-0002");
    expect(stale[0]?.index).toBe(1);
    expect(stale[0]?.cutText).toBe("我们");
    expect(stale[0]?.orphaned).toBe(true);
  });

  it("separates a word the transcript lost from a word the edit cut", () => {
    const document = documentOf(["sub-0001", ["w-0", "ghost"], "今天"]);
    const stale = subtitleStaleness(document, words, fullEditList(2));
    expect(stale[0]?.missingWordIds).toEqual(["ghost"]);
    expect(stale[0]?.cutWordIds).toEqual([]);
    expect(stale[0]?.orphaned).toBe(false);
  });
});

describe("assertSubtitleDocument", () => {
  const base: SubtitleDocument = {
    schemaVersion: SUBTITLE_SCHEMA_VERSION,
    projectId: "p",
    baseTranscriptRevision: "tr",
    style: DEFAULT_SUBTITLE_STYLE,
    cues: [{ id: "sub-0001", wordIds: ["w-0"], text: "今" }],
  };

  it("accepts a well-formed document", () => {
    expect(() => assertSubtitleDocument(base)).not.toThrow();
  });

  it("rejects two screens claiming the same word", () => {
    expect(() => assertSubtitleDocument({
      ...base,
      cues: [
        { id: "sub-0001", wordIds: ["w-0"], text: "今" },
        { id: "sub-0002", wordIds: ["w-0"], text: "今" },
      ],
    })).toThrow(/claimed by two subtitle cues/);
  });

  it("rejects duplicate cue ids", () => {
    expect(() => assertSubtitleDocument({
      ...base,
      cues: [
        { id: "sub-0001", wordIds: ["w-0"], text: "今" },
        { id: "sub-0001", wordIds: ["w-1"], text: "天" },
      ],
    })).toThrow(/not unique/);
  });

  it("rejects an unknown schema version", () => {
    expect(() => assertSubtitleDocument({ ...base, schemaVersion: 2 }))
      .toThrow(/Unsupported subtitle schema/);
  });
});

describe("subtitle styles", () => {
  it("offers looks that differ in more than size", () => {
    // The complaint that started this: four presets that were one look at four
    // volumes. Every preset must differ from 标准 somewhere other than the
    // three fields a volume knob would move.
    const [standard, ...rest] = SUBTITLE_STYLE_PRESETS;
    expect(standard).toBeDefined();
    const volume: Array<keyof SubtitleStyle> = ["fontSize", "fontWeight", "strokeWidth"];
    for (const preset of rest) {
      const different = (Object.keys(preset.style) as Array<keyof SubtitleStyle>)
        .filter((key) => preset.style[key] !== standard!.style[key])
        .filter((key) => !volume.includes(key));
      expect(different.length).toBeGreaterThan(0);
    }
  });

  it("names a real face for export rather than handing libass a font stack", () => {
    for (const preset of SUBTITLE_STYLE_PRESETS) {
      expect(preset.style.fontFamily).toContain(",");
      expect(preset.style.fontPostScriptName).not.toContain(",");
      expect(preset.style.fontPostScriptName.trim()).not.toBe("");
    }
  });

  it("moves a document off a retired preset instead of patching it", () => {
    // 6 meant three percent of visible outline under the old centred stroke.
    // Kept as a number under the outward rule it would be twice the outline the
    // person picked, so the whole look is replaced.
    const old = {
      fontFamily: "PingFang SC, Noto Sans CJK SC, sans-serif",
      fontSize: 5.4,
      fontWeight: 500,
      color: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 6,
      backgroundColor: "",
      anchor: "bottom",
      offsetY: 8,
      lineHeight: 1.3,
      maxLineWidth: 86,
    };
    expect(normalizeSubtitleStyle(old)).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(matchSubtitleStylePreset(normalizeSubtitleStyle(old))?.id).toBe("standard");

    // 干净 was a plate without corners; 胶囊 is the same idea done properly.
    const clean = { ...old, fontSize: 4.6, fontWeight: 400, strokeWidth: 0,
      backgroundColor: "rgba(0, 0, 0, 0.55)", offsetY: 6 };
    expect(matchSubtitleStylePreset(normalizeSubtitleStyle(clean))?.id).toBe("plate");
  });

  it("fills what a document is missing without touching what it has", () => {
    const custom = { ...DEFAULT_SUBTITLE_STYLE, color: "#00ff00", fontSize: 9.1 } as
      Record<string, unknown>;
    delete custom.shadowBlur;
    delete custom.letterSpacing;
    const filled = normalizeSubtitleStyle(custom);
    expect(filled.color).toBe("#00ff00");
    expect(filled.fontSize).toBe(9.1);
    expect(filled.shadowBlur).toBe(DEFAULT_SUBTITLE_STYLE.shadowBlur);
    expect(filled.letterSpacing).toBe(DEFAULT_SUBTITLE_STYLE.letterSpacing);
  });

  it("refuses values that would place the text nowhere", () => {
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, anchor: "botom" }).anchor)
      .toBe("bottom");
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, fontSize: Number.NaN }).fontSize)
      .toBe(DEFAULT_SUBTITLE_STYLE.fontSize);
    expect(normalizeSubtitleStyle(null)).toEqual(DEFAULT_SUBTITLE_STYLE);
  });
});
