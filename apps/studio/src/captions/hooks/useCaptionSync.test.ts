import { describe, expect, it } from "vitest";
import {
  applyCaptionOverrides,
  buildCaptionOverrides,
  type CaptionOverrideEntry,
} from "./useCaptionSync";

const segment = {
  wordId: "w-1",
  text: "原文",
  start: 1,
  end: 2,
  style: { fontSize: 42 },
};

function model() {
  return {
    groupOrder: ["group-1"],
    groups: new Map([["group-1", { segmentIds: ["segment-1"] }]]),
    segments: new Map([["segment-1", { ...segment }]]),
  };
}

describe("caption override persistence", () => {
  it("stores text and timing even when a segment has no style-only change", () => {
    const value = model();
    value.segments.set("segment-1", {
      ...segment,
      text: "校对后",
      start: 1.25,
      end: 2.4,
      style: {},
    });
    expect(buildCaptionOverrides(value)).toEqual([{
      wordId: "w-1",
      wordIndex: 0,
      text: "校对后",
      start: 1.25,
      end: 2.4,
    }]);
  });

  it("restores text, timing, and style by stable word id", () => {
    const overrides: CaptionOverrideEntry[] = [{
      wordId: "w-1",
      wordIndex: 99,
      text: "校对后",
      start: 1.2,
      end: 2.6,
      fontSize: 58,
      activeColor: "#ff5500",
    }];
    const restored = applyCaptionOverrides(model(), overrides).get("segment-1");
    expect(restored).toMatchObject({
      text: "校对后",
      start: 1.2,
      end: 2.6,
      style: { fontSize: 58, activeColor: "#ff5500" },
    });
  });
});
