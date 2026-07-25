import { describe, expect, it } from "vitest";
import type { EditListDocument, EditListSegment } from "@video-workbench/core";
import {
  beginEdlSeek,
  createEdlSeekGenerationState,
  isCurrentEdlSeek,
  resolveEdlRevisionTransition,
  resolveEdlSourcePosition,
  resolveEdlTimelinePosition,
} from "./edlTransport";

const baseRevision = "a".repeat(64);
const nextRevision = "b".repeat(64);

function segment(
  id: string,
  sourceStart: number,
  sourceEnd: number,
  timelineStart: number,
): EditListSegment {
  return {
    id,
    source: "input/source.mp4",
    sourceStart,
    sourceEnd,
    timelineStart,
    trackId: "a-roll",
    playbackRate: 1,
  };
}

function document(
  segments: EditListSegment[],
  options: { sourceDuration?: number; mode?: "cuts-derived" | "manual" } = {},
): EditListDocument {
  const duration = segments.reduce(
    (total, item) => total + item.sourceEnd - item.sourceStart,
    0,
  );
  return {
    schemaVersion: 1,
    projectId: "transport-fixture",
    sourceDuration: options.sourceDuration ?? 20,
    baseCutsRevision: baseRevision,
    baseTranscriptRevision: baseRevision,
    mode: options.mode ?? "cuts-derived",
    duration,
    segments,
  };
}

const cutDocument = document([
  segment("a", 0, 4, 0),
  segment("b", 8, 12, 4),
  segment("c", 15, 20, 8),
]);

describe("EDL transport position mapping", () => {
  it("maps timeline time onto the retained source frame", () => {
    expect(resolveEdlTimelinePosition(cutDocument, 5.25)).toEqual({
      timelineTime: 5.25,
      sourceTime: 9.25,
      segmentIndex: 1,
      segmentId: "b",
      atTimelineEnd: false,
    });
    expect(resolveEdlSourcePosition(cutDocument, 16.5)).toMatchObject({
      timelineTime: 9.5,
      sourceTime: 16.5,
      segmentId: "c",
    });
    expect(resolveEdlSourcePosition(cutDocument, 6)).toBeNull();
  });

  it("uses half-open internal boundaries and accepts the final endpoint", () => {
    expect(resolveEdlTimelinePosition(cutDocument, 4)).toMatchObject({
      segmentId: "b",
      sourceTime: 8,
      atTimelineEnd: false,
    });
    expect(resolveEdlTimelinePosition(cutDocument, cutDocument.duration)).toMatchObject({
      segmentId: "c",
      sourceTime: 20,
      atTimelineEnd: true,
    });
  });

  it("clamps media-facing seeks to the magnetic timeline", () => {
    expect(resolveEdlTimelinePosition(cutDocument, -5).timelineTime).toBe(0);
    expect(resolveEdlTimelinePosition(cutDocument, 99).timelineTime).toBe(
      cutDocument.duration,
    );
  });

  it("maps reordered source ranges through their authored timeline order", () => {
    const reordered = document([
      segment("late", 15, 20, 0),
      segment("early", 0, 4, 5),
      segment("middle", 8, 12, 9),
    ], { mode: "manual" });
    expect(resolveEdlSourcePosition(reordered, 2)).toMatchObject({
      timelineTime: 7,
      segmentId: "early",
    });
    expect(resolveEdlTimelinePosition(reordered, 1)).toMatchObject({
      sourceTime: 16,
      segmentId: "late",
    });
  });
});

describe("EDL revision playhead migration", () => {
  const uncut = document([segment("whole", 0, 20, 0)]);

  it("keeps the same source content when an earlier range was deleted", () => {
    expect(resolveEdlRevisionTransition({
      oldDocument: uncut,
      oldRevision: baseRevision,
      newDocument: cutDocument,
      newRevision: nextRevision,
      currentTimelineTime: 9,
      wasPlaying: true,
    })).toEqual({
      fromRevision: baseRevision,
      toRevision: nextRevision,
      previousSourceTime: 9,
      timelineTime: 5,
      targetSegmentId: "b",
      disposition: "retained",
      keepPlaying: true,
      atTimelineEnd: false,
    });
  });

  it("lands on the next retained source range when the current content was deleted", () => {
    expect(resolveEdlRevisionTransition({
      oldDocument: uncut,
      oldRevision: baseRevision,
      newDocument: cutDocument,
      newRevision: nextRevision,
      currentTimelineTime: 6,
      wasPlaying: true,
    })).toMatchObject({
      previousSourceTime: 6,
      timelineTime: 4,
      targetSegmentId: "b",
      disposition: "deleted-next",
      keepPlaying: true,
      atTimelineEnd: false,
    });
  });

  it("stops at the new endpoint when the retained tail was deleted", () => {
    const withoutTail = document([
      segment("a", 0, 4, 0),
      segment("b", 8, 12, 4),
    ]);
    expect(resolveEdlRevisionTransition({
      oldDocument: uncut,
      oldRevision: baseRevision,
      newDocument: withoutTail,
      newRevision: nextRevision,
      currentTimelineTime: 18,
      wasPlaying: true,
    })).toMatchObject({
      previousSourceTime: 18,
      timelineTime: 8,
      targetSegmentId: null,
      disposition: "deleted-tail",
      keepPlaying: false,
      atTimelineEnd: true,
    });
  });

  it("preserves a paused intent after remapping", () => {
    expect(resolveEdlRevisionTransition({
      oldDocument: uncut,
      oldRevision: baseRevision,
      newDocument: cutDocument,
      newRevision: nextRevision,
      currentTimelineTime: 9,
      wasPlaying: false,
    }).keepPlaying).toBe(false);
  });
});

describe("last-write-wins seek generation", () => {
  it("accepts only the latest seek within one EDL revision", () => {
    const first = beginEdlSeek(createEdlSeekGenerationState(), {
      revision: baseRevision,
      document: cutDocument,
      timelineTime: 1,
    });
    const second = beginEdlSeek(first.state, {
      revision: baseRevision,
      document: cutDocument,
      timelineTime: 5,
    });

    expect(first.request.generation).toBe(1);
    expect(second.request.generation).toBe(2);
    expect(isCurrentEdlSeek(second.state, first.request)).toBe(false);
    expect(isCurrentEdlSeek(second.state, second.request)).toBe(true);
    expect(second.request.position).toMatchObject({ sourceTime: 9, segmentId: "b" });
  });

  it("invalidates an in-flight seek when the EDL revision changes", () => {
    const oldSeek = beginEdlSeek(createEdlSeekGenerationState(), {
      revision: baseRevision,
      document: cutDocument,
      timelineTime: 5,
    });
    const newSeek = beginEdlSeek(oldSeek.state, {
      revision: nextRevision,
      document: cutDocument,
      timelineTime: 5,
    });

    expect(isCurrentEdlSeek(newSeek.state, oldSeek.request)).toBe(false);
    expect(isCurrentEdlSeek(newSeek.state, newSeek.request)).toBe(true);
    expect(newSeek.state).toEqual({ generation: 2, revision: nextRevision });
  });
});
