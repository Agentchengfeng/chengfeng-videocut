import type { EditListOperation } from "@video-workbench/core";
import type { TimelineElement } from "../player";

const roundTime = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function isEditListManagedElement(
  element: Pick<TimelineElement, "edlSegmentId">,
): element is TimelineElement & { edlSegmentId: string } {
  return typeof element.edlSegmentId === "string" && element.edlSegmentId.length > 0;
}

export function buildEditListMoveOperation(
  element: TimelineElement & { edlSegmentId: string },
  start: number,
): EditListOperation {
  return { type: "move", clipId: element.edlSegmentId, start: roundTime(start) };
}

export function buildEditListTrimOperation(
  element: TimelineElement & { edlSegmentId: string },
  updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
): EditListOperation {
  const originalSourceStart = element.edlSourceStart;
  const originalSourceEnd = element.edlSourceEnd;
  if (!Number.isFinite(originalSourceStart) || !Number.isFinite(originalSourceEnd)) {
    throw new Error("Managed clip is missing its source range");
  }
  const playbackRate = Math.max(element.playbackRate ?? 1, 0.000001);
  const sourceStart =
    updates.playbackStart != null && Number.isFinite(updates.playbackStart)
      ? updates.playbackStart
      : (originalSourceStart as number) + (updates.start - element.start) * playbackRate;
  const sourceEnd = sourceStart + updates.duration * playbackRate;
  return {
    type: "trim",
    clipId: element.edlSegmentId,
    sourceStart: roundTime(sourceStart),
    sourceEnd: roundTime(sourceEnd),
  };
}

export function buildEditListSplitOperation(
  element: TimelineElement & { edlSegmentId: string },
  splitTime: number,
): EditListOperation {
  return {
    type: "split",
    clipId: element.edlSegmentId,
    offset: roundTime(splitTime - element.start),
  };
}

export function buildEditListDeleteOperation(
  element: TimelineElement & { edlSegmentId: string },
): EditListOperation {
  return { type: "delete", clipId: element.edlSegmentId };
}
