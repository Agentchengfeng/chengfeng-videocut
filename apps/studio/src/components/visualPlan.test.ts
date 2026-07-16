import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../player";
import type { TranscriptCue } from "./kouboTranscript";
import {
  buildVisualPlanSegments,
  visualPlanMatchesCutSelection,
  withVisualPlanCutSync,
} from "./visualPlan";

const cues: TranscriptCue[] = [
  {
    id: "cue-1",
    start: 0,
    end: 3,
    words: [
      { id: "w1", text: "第一段口播", start: 0, end: 3, isGap: false },
    ],
  },
];

const elements: TimelineElement[] = [
  {
    id: "clip-01-title",
    tag: "section",
    start: 0,
    duration: 3,
    track: 1,
    timelineRole: "b-roll",
  },
];

describe("buildVisualPlanSegments", () => {
  it("joins an authored visual plan with its transcript cue", () => {
    const segments = buildVisualPlanSegments(
      {
        segments: [
          {
            id: "scene-1",
            cueId: "cue-1",
            title: "标题入场",
            description: "四张卡片依次出现",
            clipIds: ["clip-01-title"],
          },
        ],
      },
      cues,
      elements,
    );

    expect(segments[0]).toMatchObject({
      transcript: "第一段口播",
      title: "标题入场",
      start: 0,
      end: 3,
    });
  });

  it("derives a usable card from transcript and overlapping B-roll", () => {
    const segments = buildVisualPlanSegments(null, cues, elements);

    expect(segments[0]).toMatchObject({
      cueId: "cue-1",
      transcript: "第一段口播",
      title: "title",
      clipIds: ["clip-01-title"],
    });
  });

  it("follows stable word anchors when subtitle text, timing, or cue grouping changes", () => {
    const changedCues: TranscriptCue[] = [
      {
        id: "new-cue-id",
        start: 4,
        end: 5,
        words: [
          { id: "w1", text: "改过的字幕", start: 4, end: 5, isGap: false },
        ],
      },
    ];
    const segments = buildVisualPlanSegments(
      {
        segments: [
          {
            id: "scene-1",
            cueId: "old-cue-id",
            wordIds: ["w1"],
            start: 0,
            end: 3,
            title: "标题入场",
            clipIds: ["clip-01-title"],
          },
        ],
      },
      changedCues,
      elements,
    );

    expect(segments[0]).toMatchObject({
      transcript: "改过的字幕",
      start: 4,
      end: 5,
      wordIds: ["w1"],
      syncState: "linked",
    });
  });

  it("marks a segment for review when every stable subtitle anchor disappears", () => {
    const segments = buildVisualPlanSegments(
      {
        segments: [
          {
            id: "scene-missing",
            cueId: "missing-cue",
            wordIds: ["missing-word"],
            title: "待重绑画面",
          },
        ],
      },
      cues,
      elements,
    );

    expect(segments[0]?.syncState).toBe("fallback");
  });

  it("derives edited timing and removes a visual whose entire speech anchor is cut", () => {
    const segments = buildVisualPlanSegments(
      null,
      cues,
      elements,
      new Set(["w1"]),
    );

    expect(segments[0]).toMatchObject({
      editedStart: 0,
      editedEnd: 0,
      editedTranscript: "",
      fullyCut: true,
    });
  });

  it("requires repair when cut selection changes and accepts the repaired revision", () => {
    const cutWordIds = new Set(["w1"]);

    expect(visualPlanMatchesCutSelection(null, cutWordIds)).toBe(false);
    const repaired = withVisualPlanCutSync(null, cutWordIds, "2026-07-15T00:00:00.000Z");
    expect(visualPlanMatchesCutSelection(repaired, cutWordIds)).toBe(true);
    expect(visualPlanMatchesCutSelection(repaired, new Set())).toBe(false);
  });
});
