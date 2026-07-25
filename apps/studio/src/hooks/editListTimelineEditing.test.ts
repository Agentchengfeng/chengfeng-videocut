import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../player";
import {
  buildEditListDeleteOperation,
  buildEditListMoveOperation,
  buildEditListSplitOperation,
  buildEditListTrimOperation,
  isEditListManagedElement,
} from "./editListTimelineEditing";

const managed: TimelineElement = {
  id: "segment-dom-1",
  tag: "video",
  start: 5,
  duration: 4,
  track: 1,
  playbackStart: 10,
  playbackRate: 2,
  edlSegmentId: "a-roll-0001",
  edlSourceStart: 10,
  edlSourceEnd: 18,
};

describe("EDL timeline operation compiler", () => {
  it("recognizes only elements carrying a stable EDL segment id", () => {
    expect(isEditListManagedElement(managed)).toBe(true);
    expect(isEditListManagedElement({ ...managed, edlSegmentId: undefined })).toBe(false);
  });

  it("compiles move, split and delete with the segment id", () => {
    expect(buildEditListMoveOperation(managed as TimelineElement & { edlSegmentId: string }, 8.25))
      .toEqual({ type: "move", clipId: "a-roll-0001", start: 8.25 });
    expect(buildEditListSplitOperation(managed as TimelineElement & { edlSegmentId: string }, 6.5))
      .toEqual({ type: "split", clipId: "a-roll-0001", offset: 1.5 });
    expect(buildEditListDeleteOperation(managed as TimelineElement & { edlSegmentId: string }))
      .toEqual({ type: "delete", clipId: "a-roll-0001" });
  });

  it("converts a left trim from timeline seconds into source seconds", () => {
    expect(
      buildEditListTrimOperation(managed as TimelineElement & { edlSegmentId: string }, {
        start: 6,
        duration: 3,
        playbackStart: 12,
      }),
    ).toEqual({
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart: 12,
      sourceEnd: 18,
    });
  });

  it("converts an end trim using playback rate", () => {
    expect(
      buildEditListTrimOperation(managed as TimelineElement & { edlSegmentId: string }, {
        start: 5,
        duration: 2.5,
        playbackStart: 10,
      }),
    ).toMatchObject({ sourceStart: 10, sourceEnd: 15 });
  });
});
