import { describe, expect, it } from "bun:test";
import {
  applyEditListOperation,
  buildEditListFromCuts,
  editListSegmentDuration,
  parseEditListDocument,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
} from "./editList";

const revision = "a".repeat(64);
const transcriptRevision = "b".repeat(64);

function fixture() {
  return buildEditListFromCuts({
    projectId: "demo",
    source: "input/source.mp4",
    sourceDuration: 12,
    cutsRevision: revision,
    transcriptRevision,
    cutRanges: [
      { start: 0, end: 2 },
      { start: 5, end: 7 },
      { start: 10, end: 12 },
    ],
  });
}

describe("edit-list model", () => {
  it("materializes Cuts into one gapless magnetic A-roll", () => {
    const document = fixture();
    expect(document.mode).toBe("cuts-derived");
    expect(document.duration).toBe(6);
    expect(document.segments).toEqual([
      expect.objectContaining({
        id: "a-roll-0001",
        sourceStart: 2,
        sourceEnd: 5,
        timelineStart: 0,
      }),
      expect.objectContaining({
        id: "a-roll-0002",
        sourceStart: 7,
        sourceEnd: 10,
        timelineStart: 3,
      }),
    ]);
  });

  it("maps source and edited time through reordered segments", () => {
    const moved = applyEditListOperation(fixture(), {
      type: "move",
      clipId: "a-roll-0002",
      start: 0,
    });
    expect(moved.segments.map((segment) => segment.id)).toEqual([
      "a-roll-0002",
      "a-roll-0001",
    ]);
    expect(moved.segments.map((segment) => segment.timelineStart)).toEqual([0, 3]);
    expect(sourceTimeToTimelineTime(moved, 8)).toBe(1);
    expect(timelineTimeToSourceTime(moved, 4)).toBe(3);
  });

  it("trims and ripples downstream segments", () => {
    const trimmed = applyEditListOperation(fixture(), {
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart: 3,
      sourceEnd: 5,
    });
    expect(trimmed.mode).toBe("manual");
    expect(trimmed.duration).toBe(5);
    expect(trimmed.segments[1].timelineStart).toBe(2);
  });

  it("refuses a trim that would overlap a neighbour's source range", () => {
    // The fixture keeps source 2-5 and 7-10. Dragging the first segment's tail
    // past 7 would render 7-8 twice: the concatenation repeats it, while the
    // transcript still shows those words once, so the duplicate is inaudible on
    // screen and deleting it from the transcript would remove both copies.
    const document = fixture();
    expect(() => applyEditListOperation(document, {
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart: 2,
      sourceEnd: 8,
    })).toThrow(/overlap/i);

    // Growing up to — but not into — the neighbour stays legal.
    const grown = applyEditListOperation(document, {
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart: 2,
      sourceEnd: 7,
    });
    expect(grown.segments[0]).toMatchObject({ sourceStart: 2, sourceEnd: 7 });
    expect(grown.segments[1].timelineStart).toBe(5);

    // The leading handle is guarded in the same direction.
    expect(() => applyEditListOperation(document, {
      type: "trim",
      clipId: "a-roll-0002",
      sourceStart: 4,
      sourceEnd: 10,
    })).toThrow(/overlap/i);
  });

  it("splits without changing total duration, then deletes with ripple", () => {
    const split = applyEditListOperation(fixture(), {
      type: "split",
      clipId: "a-roll-0001",
      offset: 1,
      newClipId: "a-roll-new",
    });
    expect(split.duration).toBe(6);
    expect(split.segments.map((segment) => segment.id)).toEqual([
      "a-roll-0001",
      "a-roll-new",
      "a-roll-0002",
    ]);
    expect(split.segments.map(editListSegmentDuration)).toEqual([1, 2, 3]);

    const deleted = applyEditListOperation(split, {
      type: "delete",
      clipId: "a-roll-new",
    });
    expect(deleted.duration).toBe(4);
    expect(deleted.segments[1].timelineStart).toBe(1);
  });

  it("deletes one identified source range without reordering or touching another source", () => {
    const middle = applyEditListOperation(fixture(), {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 3,
      sourceEnd: 4,
    });
    expect(middle.mode).toBe("manual");
    expect(middle.segments.map((segment) => [segment.id, segment.sourceStart, segment.sourceEnd])).toEqual([
      ["a-roll-0001", 2, 3],
      ["a-roll-0001__split_4000", 4, 5],
      ["a-roll-0002", 7, 10],
    ]);
    expect(middle.segments.map((segment) => segment.timelineStart)).toEqual([0, 1, 2]);

    const shortResidual = applyEditListOperation(fixture(), {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 2.02,
      sourceEnd: 3,
    });
    expect(shortResidual.segments[0]).toMatchObject({
      id: "a-roll-0001",
      sourceStart: 3,
      sourceEnd: 5,
    });

    const multiSource = structuredClone(fixture());
    multiSource.segments[1].source = "input/secondary.mp4";
    const primaryOnly = applyEditListOperation(multiSource, {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 2.5,
      sourceEnd: 4.5,
    });
    expect(primaryOnly.segments.map((segment) => [segment.source, segment.sourceStart, segment.sourceEnd])).toEqual([
      ["input/source.mp4", 2, 2.5],
      ["input/source.mp4", 4.5, 5],
      ["input/secondary.mp4", 7, 10],
    ]);
    expect(() => applyEditListOperation(multiSource, {
      type: "delete-range",
      source: "input/unknown.mp4",
      sourceStart: 2.5,
      sourceEnd: 4.5,
    })).toThrow("does not overlap");
  });

  it("restores only the exact inverse of one delete-range snapshot", () => {
    const before = applyEditListOperation(fixture(), {
      type: "move",
      clipId: "a-roll-0002",
      start: 0,
    });
    const inverse = {
      type: "delete-range" as const,
      source: "input/source.mp4",
      sourceStart: 4,
      sourceEnd: 8,
    };
    const deleted = applyEditListOperation(before, inverse);
    expect(deleted.segments.map((segment) => segment.id)).toEqual([
      "a-roll-0002",
      "a-roll-0001",
    ]);
    const restored = applyEditListOperation(deleted, {
      type: "restore-snapshot",
      expectedSegments: deleted.segments,
      beforeSegments: before.segments,
      beforeMode: before.mode,
      inverse,
    });
    expect(restored).toEqual(before);

    const stale = structuredClone(deleted);
    expect(() => applyEditListOperation(stale, {
      type: "restore-snapshot",
      expectedSegments: before.segments,
      beforeSegments: before.segments,
      beforeMode: before.mode,
      inverse,
    })).toThrow("no longer matches");
    expect(stale).toEqual(deleted);

    expect(() => applyEditListOperation(deleted, {
      type: "restore-snapshot",
      expectedSegments: deleted.segments,
      beforeSegments: before.segments,
      beforeMode: before.mode,
      inverse: { ...inverse, sourceEnd: 8.1 },
    })).toThrow("does not reproduce");
  });

  it("rejects invalid, non-overlapping, and final-content delete ranges without mutating input", () => {
    const document = fixture();
    const original = structuredClone(document);
    expect(() => applyEditListOperation(document, {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 5,
      sourceEnd: 5,
    })).toThrow("outside the source or empty");
    expect(() => applyEditListOperation(document, {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 5.1,
      sourceEnd: 6.9,
    })).toThrow("does not overlap");

    const one = {
      ...document,
      duration: 3,
      segments: [document.segments[0]!],
    };
    const oneBefore = structuredClone(one);
    expect(() => applyEditListOperation(one, {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 2,
      sourceEnd: 5,
    })).toThrow("cannot delete all retained content");
    expect(one).toEqual(oneBefore);
    expect(document).toEqual(original);
  });

  it("restores a middle, head, and tail source range only through current anchors", () => {
    const middle = applyEditListOperation(fixture(), {
      type: "restore",
      sourceStart: 5,
      sourceEnd: 7,
      previousSegmentId: "a-roll-0001",
      nextSegmentId: "a-roll-0002",
    });
    expect(middle.mode).toBe("manual");
    expect(middle.segments.map((segment) => [segment.sourceStart, segment.sourceEnd])).toEqual([
      [2, 5], [5, 7], [7, 10],
    ]);
    expect(middle.segments.map((segment) => segment.timelineStart)).toEqual([0, 3, 5]);
    expect(middle.segments[1]?.id).toMatch(/^a-roll-restore-5000000-7000000$/);

    const head = applyEditListOperation(fixture(), {
      type: "restore",
      sourceStart: 0,
      sourceEnd: 2,
      nextSegmentId: "a-roll-0001",
    });
    expect(head.segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 2, timelineStart: 0 });

    const tail = applyEditListOperation(fixture(), {
      type: "restore",
      sourceStart: 10,
      sourceEnd: 12,
      previousSegmentId: "a-roll-0002",
    });
    expect(tail.segments.at(-1)).toMatchObject({ sourceStart: 10, sourceEnd: 12, timelineStart: 6 });
  });

  it("fails closed for restore overlap, absent anchors, and non-adjacent anchors", () => {
    const document = fixture();
    expect(() => applyEditListOperation(document, {
      type: "restore",
      sourceStart: 3,
      sourceEnd: 4,
      previousSegmentId: "a-roll-0001",
      nextSegmentId: "a-roll-0002",
    })).toThrow("overlaps");
    expect(() => applyEditListOperation(document, {
      type: "restore",
      sourceStart: 5,
      sourceEnd: 7,
    })).toThrow("requires a previousSegmentId or nextSegmentId");

    const three = applyEditListOperation(document, {
      type: "restore",
      sourceStart: 5,
      sourceEnd: 7,
      previousSegmentId: "a-roll-0001",
      nextSegmentId: "a-roll-0002",
    });
    expect(() => applyEditListOperation(three, {
      type: "restore",
      sourceStart: 10,
      sourceEnd: 12,
      previousSegmentId: "a-roll-0001",
      nextSegmentId: "a-roll-0002",
    })).toThrow("adjacent");
  });

  it("rejects non-magnetic persisted timelines and deleting the final clip", () => {
    const document = fixture();
    const broken = structuredClone(document);
    broken.segments[1].timelineStart = 9;
    expect(() => parseEditListDocument(broken)).toThrow("gapless magnetic A-roll");

    const one = { ...document, duration: 3, segments: [document.segments[0]] };
    expect(() => applyEditListOperation(one, {
      type: "delete",
      clipId: "a-roll-0001",
    })).toThrow("final segment");
  });

  it("rejects playback-rate changes at the canonical EDL boundary", () => {
    const document = fixture();
    document.segments[0].playbackRate = 1.25;

    expect(() => parseEditListDocument(document)).toThrow(
      "playbackRate must be 1 because the current HyperFrames runtime does not support EDL rate changes",
    );
  });
});
