import { describe, expect, it } from "vitest";
import {
  applyEditListOperation,
  type EditListDocument,
  type EditListSegment,
} from "@video-workbench/core";
import {
  buildDeleteOperation,
  buildMoveOperation,
  buildSplitOperation,
  buildTrimOperation,
  calculateMoveTargetIndex,
  clampTimelinePixel,
  clampTimelineTime,
  pixelToTimelineTime,
  timelineTimeToPixel,
} from "./editOperations";

const segments: EditListSegment[] = [
  {
    id: "a",
    source: "input/source.mp4",
    sourceStart: 10,
    sourceEnd: 12,
    timelineStart: 0,
    trackId: "a-roll",
    playbackRate: 1,
  },
  {
    id: "b",
    source: "input/source.mp4",
    sourceStart: 20,
    sourceEnd: 23,
    timelineStart: 2,
    trackId: "a-roll",
    playbackRate: 1,
  },
  {
    id: "c",
    source: "input/source.mp4",
    sourceStart: 30,
    sourceEnd: 31,
    timelineStart: 5,
    trackId: "a-roll",
    playbackRate: 1,
  },
];

const document: EditListDocument = {
  schemaVersion: 1,
  projectId: "demo",
  sourceDuration: 40,
  baseCutsRevision: "a".repeat(64),
  baseTranscriptRevision: "b".repeat(64),
  mode: "cuts-derived",
  duration: 6,
  segments,
};

describe("timeline coordinate helpers", () => {
  it("clamps invalid and out-of-range values", () => {
    expect(clampTimelineTime(Number.NaN, 6)).toBe(0);
    expect(clampTimelineTime(-1, 6)).toBe(0);
    expect(clampTimelineTime(9, 6)).toBe(6);
    expect(clampTimelinePixel(Number.POSITIVE_INFINITY, 800)).toBe(0);
    expect(clampTimelinePixel(-20, 800)).toBe(0);
    expect(clampTimelinePixel(900, 800)).toBe(800);
  });

  it("maps pixels and timeline time in both directions", () => {
    expect(pixelToTimelineTime(250, 1000, 6)).toBe(1.5);
    expect(pixelToTimelineTime(1200, 1000, 6)).toBe(6);
    expect(pixelToTimelineTime(20, 0, 6)).toBe(0);
    expect(timelineTimeToPixel(1.5, 6, 1000)).toBe(250);
    expect(timelineTimeToPixel(9, 6, 1000)).toBe(1000);
    expect(timelineTimeToPixel(2, 0, 1000)).toBe(0);
  });
});

describe("magnetic move operations", () => {
  it("calculates insertion indices from the remaining clips' midpoints", () => {
    expect(calculateMoveTargetIndex(segments, "b", 0)).toBe(0);
    expect(calculateMoveTargetIndex(segments, "b", 0.999)).toBe(0);
    expect(calculateMoveTargetIndex(segments, "b", 1)).toBe(1);
    expect(calculateMoveTargetIndex(segments, "b", 5.499)).toBe(1);
    expect(calculateMoveTargetIndex(segments, "b", 5.5)).toBe(2);
    expect(calculateMoveTargetIndex(segments, "b", 99)).toBe(2);
  });

  it("builds starts that reproduce before, middle, and end insertion", () => {
    expect(buildMoveOperation(segments, "b", 0)).toEqual({
      type: "move",
      clipId: "b",
      start: 0,
    });
    expect(buildMoveOperation(segments, "b", 1)).toEqual({
      type: "move",
      clipId: "b",
      start: 5,
    });
    expect(buildMoveOperation(segments, "b", 20)).toEqual({
      type: "move",
      clipId: "b",
      start: 6,
    });

    const movedFirst = applyEditListOperation(
      document,
      buildMoveOperation(segments, "b", 0),
    );
    expect(movedFirst.segments.map((segment) => segment.id)).toEqual(["b", "a", "c"]);

    const movedLast = applyEditListOperation(
      document,
      buildMoveOperation(segments, "b", 2),
    );
    expect(movedLast.segments.map((segment) => segment.id)).toEqual(["a", "c", "b"]);
  });

  it("fails closed for unknown clips and non-finite indices", () => {
    expect(() => calculateMoveTargetIndex(segments, "missing", 1)).toThrow("Unknown");
    expect(() => buildMoveOperation(segments, "b", Number.NaN)).toThrow("finite");
  });
});

describe("trim, split, and delete operation builders", () => {
  it("maps timeline trim positions to source ranges and clamps both edges", () => {
    expect(buildTrimOperation(segments[1], "start", 3.25, 40)).toEqual({
      type: "trim",
      clipId: "b",
      sourceStart: 21.25,
      sourceEnd: 23,
    });
    expect(buildTrimOperation(segments[1], "start", 99, 40)).toEqual({
      type: "trim",
      clipId: "b",
      sourceStart: 22.97,
      sourceEnd: 23,
    });
    expect(buildTrimOperation(segments[1], "end", -99, 40)).toEqual({
      type: "trim",
      clipId: "b",
      sourceStart: 20,
      sourceEnd: 20.03,
    });
    expect(buildTrimOperation(segments[1], "end", 50, 24)).toEqual({
      type: "trim",
      clipId: "b",
      sourceStart: 20,
      sourceEnd: 24,
    });
  });

  it("builds a clamped split offset and optional stable right-hand id", () => {
    expect(buildSplitOperation(segments[1], 3.23456789, "b-right")).toEqual({
      type: "split",
      clipId: "b",
      offset: 1.234568,
      newClipId: "b-right",
    });
    expect(buildSplitOperation(segments[1], -10)).toEqual({
      type: "split",
      clipId: "b",
      offset: 0.03,
    });
    expect(buildSplitOperation(segments[1], 99)).toEqual({
      type: "split",
      clipId: "b",
      offset: 2.97,
    });
  });

  it("rejects clips too short to split and builds delete by segment or id", () => {
    expect(() => buildSplitOperation({ ...segments[0], sourceEnd: 10.05 }, 0.02)).toThrow(
      "at least 0.06s",
    );
    expect(buildDeleteOperation(segments[0])).toEqual({ type: "delete", clipId: "a" });
    expect(buildDeleteOperation("b")).toEqual({ type: "delete", clipId: "b" });
  });

  it("produces operations accepted by Product Core", () => {
    const trimmed = applyEditListOperation(
      document,
      buildTrimOperation(segments[1], "start", 3, document.sourceDuration),
    );
    expect(trimmed.segments[1]).toMatchObject({ sourceStart: 21, sourceEnd: 23 });

    const split = applyEditListOperation(
      document,
      buildSplitOperation(segments[1], 3, "b-right"),
    );
    expect(split.segments.map((segment) => segment.id)).toEqual(["a", "b", "b-right", "c"]);

    const deleted = applyEditListOperation(document, buildDeleteOperation("b"));
    expect(deleted.segments.map((segment) => segment.id)).toEqual(["a", "c"]);
  });
});
