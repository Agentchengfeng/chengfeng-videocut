import { describe, expect, it } from "vitest";
import { buildCaptionModel } from "../captions/parser";
import {
  buildTranscriptDisplayCues,
  buildCutTimeRanges,
  KOU_BO_TRANSCRIPT_COPY,
  mergeCaptionModelIntoCues,
  parseTranscriptPayload,
  sourceTimeToEditedTime,
  totalTimeRangeDuration,
  type TranscriptWord,
} from "./kouboTranscript";

describe("KOU_BO_TRANSCRIPT_COPY", () => {
  it("uses transcription language instead of implying generated captions", () => {
    expect(KOU_BO_TRANSCRIPT_COPY).toEqual({
      sectionLabel: "口播转录",
      loading: "正在载入转录文字",
      empty: "暂无转录文字",
      selectionActionsLabel: "转录文字选中操作",
    });
    expect(Object.values(KOU_BO_TRANSCRIPT_COPY).join(" ")).not.toMatch(
      /口播字幕|语音字幕/,
    );
  });
});

describe("buildTranscriptDisplayCues", () => {
  it("merges adjacent silence across cue boundaries without dropping source word ids", () => {
    const cues = parseTranscriptPayload({
      cues: [
        {
          id: "cue-1",
          words: [{ id: "g1", text: "", start: 0, end: 1, isGap: true }],
        },
        {
          id: "cue-2",
          words: [{ id: "g2", text: "", start: 1, end: 2, isGap: true }],
        },
        {
          id: "cue-3",
          words: [{ id: "g3", text: "", start: 2, end: 2.7, isGap: true }],
        },
      ],
    });

    expect(buildTranscriptDisplayCues(cues)).toEqual([
      {
        id: "cue-1",
        start: 0,
        end: 2.7,
        words: [expect.objectContaining({
          id: "g1",
          start: 0,
          end: 2.7,
          isGap: true,
          sourceWordIds: ["g1", "g2", "g3"],
        })],
      },
    ]);
  });

  it("does not merge silence separated by speech", () => {
    const cues = parseTranscriptPayload({
      cues: [{
        id: "cue-1",
        words: [
          { id: "g1", text: "", start: 0, end: 1, isGap: true },
          { id: "w1", text: "说话", start: 1, end: 2 },
          { id: "g2", text: "", start: 2, end: 3, isGap: true },
        ],
      }],
    });

    const displayWords = buildTranscriptDisplayCues(cues)[0]?.words ?? [];
    expect(displayWords).toHaveLength(3);
    expect(displayWords.map((word) => word.sourceWordIds)).toEqual([
      ["g1"],
      ["w1"],
      ["g2"],
    ]);
  });

  it("keeps deleted and retained parts of one logical silence visually separate", () => {
    const cues = parseTranscriptPayload({
      cues: [{
        id: "cue-1",
        words: [
          { id: "g1", text: "", start: 0, end: 1, isGap: true },
          { id: "g2", text: "", start: 1, end: 1.28, isGap: true },
        ],
      }],
    });

    const displayWords = buildTranscriptDisplayCues(cues, new Set(["g1"]))[0]?.words ?? [];
    expect(displayWords.map((word) => word.sourceWordIds)).toEqual([["g1"], ["g2"]]);
  });
});

describe("parseTranscriptPayload", () => {
  it("keeps explicit cue and word timing", () => {
    const cues = parseTranscriptPayload({
      cues: [
        {
          id: "cue-a",
          start: 1,
          end: 2,
          words: [
            { id: "w1", text: "口播", start: 1, end: 1.5 },
            { id: "w2", text: "剪辑", start: 1.5, end: 2 },
          ],
        },
      ],
    });

    expect(cues).toHaveLength(1);
    expect(cues[0]?.words.map((word) => word.id)).toEqual(["w1", "w2"]);
    expect(cues[0]?.end).toBe(2);
  });

  it("groups raw word arrays at long silence", () => {
    const cues = parseTranscriptPayload([
      { text: "第一句", start: 0, end: 0.5 },
      { text: "", start: 0.5, end: 1.1, isGap: true },
      { text: "第二句", start: 1.1, end: 1.8 },
    ]);

    expect(cues).toHaveLength(2);
    expect(cues[0]?.words[1]?.suggestion).toBe("silence");
    expect(cues[1]?.words[0]?.text).toBe("第二句");
  });
});

describe("mergeCaptionModelIntoCues", () => {
  it("keeps cue identity while applying live caption text and timing by wordId", () => {
    const source = parseTranscriptPayload({
      cues: [
        {
          id: "cue-a",
          start: 0,
          end: 1,
          words: [{ id: "w1", text: "原字幕", start: 0, end: 1 }],
        },
      ],
    });
    const model = buildCaptionModel(
      [{ id: "w1", text: "新字幕", start: 2, end: 3 }],
      { width: 1920, height: 1080, duration: 4 },
    );

    const merged = mergeCaptionModelIntoCues(source, model);

    expect(merged[0]).toMatchObject({
      id: "cue-a",
      start: 2,
      end: 3,
      words: [{ id: "w1", text: "新字幕", start: 2, end: 3 }],
    });
  });
});

describe("buildCutTimeRanges", () => {
  const words: TranscriptWord[] = [
    { id: "w1", text: "第", start: 0, end: 0.3, isGap: false },
    { id: "w2", text: "一", start: 0.3, end: 0.6, isGap: false },
    { id: "w3", text: "段", start: 0.6, end: 0.9, isGap: false },
    { id: "w4", text: "后", start: 1.1, end: 1.4, isGap: false },
  ];

  it("merges consecutive selected words into one playback skip range", () => {
    expect(buildCutTimeRanges(words, new Set(["w1", "w2"]))).toEqual([
      { start: 0, end: 0.6 },
    ]);
  });

  it("keeps separate selections as separate playback skip ranges", () => {
    expect(buildCutTimeRanges(words, new Set(["w1", "w3", "w4"]))).toEqual([
      { start: 0, end: 0.3 },
      { start: 0.6, end: 1.4 },
    ]);
  });

  it("maps original time to the shortened edited timeline", () => {
    const ranges = [
      { start: 1.1, end: 2.2 },
      { start: 7.5, end: 8 },
    ];

    expect(sourceTimeToEditedTime(12, ranges)).toBeCloseTo(10.4);
    expect(totalTimeRangeDuration(ranges)).toBeCloseTo(1.6);
  });
});
