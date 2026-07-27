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
  resolveCueStyle,
  subtitleCueTimings,
  subtitleStaleness,
  SUBTITLE_SCHEMA_VERSION,
  type SubtitleDocument,
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
  it("counts a Han character as one column and a Latin character as half", () => {
    expect(displayColumns("今天")).toBe(2);
    expect(displayColumns("Grok")).toBe(2);
    expect(displayColumns("今天用 Grok")).toBe(5);
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
      { id: "b", text: "词", start: 1, end: 1.2, isGap: false },
    ];
    const cues = buildSubtitleCues(words, fullEditList(2), { maxColumns: 4 });
    expect(cues.flatMap((cue) => cue.wordIds)).toEqual(["a", "b"]);
  });

  it("breaks where the audience hears a pause", () => {
    const words: TimedWord[] = [
      ...speech(0, "开场白", "a"),
      gap("g-1", 0.6, 1.4),
      ...speech(1.4, "正文", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["开场白", "正文"]);
  });

  it("keeps a sentence together when only a short breath separates the words", () => {
    const words: TimedWord[] = [
      ...speech(0, "开场白", "a"),
      gap("g-1", 0.6, 0.7),
      ...speech(0.7, "正文", "b"),
    ];
    const cues = buildSubtitleCues(words, fullEditList(3), { maxColumns: 40 });
    expect(cues.map((cue) => cue.text)).toEqual(["开场白正文"]);
  });

  it("does not split a sentence just because a pause was trimmed out of it", () => {
    // 0.6-1.4 is silence and it is deleted. The words either side are one
    // sentence and must stay on one screen.
    const words: TimedWord[] = [
      ...speech(0, "开场白", "a"),
      gap("g-1", 0.6, 1.4),
      ...speech(1.4, "正文", "b"),
    ];
    const cues = buildSubtitleCues(
      words,
      editListWithHole(3, 0.6, 1.4),
      { maxColumns: 40 },
    );
    expect(cues.map((cue) => cue.text)).toEqual(["开场白正文"]);
  });

  it("splits where deleted speech used to be", () => {
    // 0.6-1.2 was spoken and is deleted. What is either side of it is now
    // adjacent on the timeline but has nothing to do with each other.
    const words: TimedWord[] = [
      ...speech(0, "开场白", "a"),
      ...speech(0.6, "被删掉", "b"),
      ...speech(1.2, "正文", "c"),
    ];
    const cues = buildSubtitleCues(
      words,
      editListWithHole(3, 0.6, 1.2),
      { maxColumns: 40 },
    );
    expect(cues.map((cue) => cue.text)).toEqual(["开场白", "正文"]);
  });

  it("never puts a deleted word on a screen", () => {
    const words: TimedWord[] = [
      ...speech(0, "留下", "a"),
      ...speech(0.4, "删掉", "b"),
      ...speech(0.8, "留下", "c"),
    ];
    const cues = buildSubtitleCues(words, editListWithHole(3, 0.4, 0.8), {});
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
      ...speech(0.8, "正文", "c"),
    ];
    const document: SubtitleDocument = {
      schemaVersion: SUBTITLE_SCHEMA_VERSION,
      projectId: "p",
      baseTranscriptRevision: "tr",
      style: DEFAULT_SUBTITLE_STYLE,
      cues: [{ id: "sub-0001", wordIds: ["c-0", "c-1"], text: "正文" }],
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
    expect(timing?.tooShort).toBe(true);
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

describe("resolveCueStyle", () => {
  it("layers a screen's overrides on top of the document style", () => {
    const document: SubtitleDocument = {
      schemaVersion: SUBTITLE_SCHEMA_VERSION,
      projectId: "p",
      baseTranscriptRevision: "tr",
      style: { ...DEFAULT_SUBTITLE_STYLE, color: "#ffffff" },
      cues: [{ id: "sub-0001", wordIds: ["w-0"], text: "今", style: { color: "#ffcc00" } }],
    };
    expect(resolveCueStyle(document, document.cues[0]!).color).toBe("#ffcc00");
    expect(resolveCueStyle(document, document.cues[0]!).fontSize)
      .toBe(DEFAULT_SUBTITLE_STYLE.fontSize);
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
