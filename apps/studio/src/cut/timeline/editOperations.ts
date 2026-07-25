import {
  EDIT_LIST_MIN_SEGMENT_SECONDS,
  editListSegmentDuration,
  type EditListOperation,
  type EditListSegment,
} from "@video-workbench/core";

const TIME_PRECISION = 1_000_000;

export type TrimEdge = "start" | "end";

function roundTime(value: number): number {
  return Math.round(value * TIME_PRECISION) / TIME_PRECISION;
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function requireClipId(clipId: string): string {
  if (clipId.trim().length === 0) throw new TypeError("clipId must not be empty");
  return clipId;
}

function timelineDuration(segments: readonly EditListSegment[]): number {
  return segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.timelineStart + editListSegmentDuration(segment)),
    0,
  );
}

function findSegment(
  segments: readonly EditListSegment[],
  clipId: string,
): EditListSegment {
  const segment = segments.find((candidate) => candidate.id === clipId);
  if (!segment) throw new RangeError(`Unknown edit-list clip id: ${clipId}`);
  return segment;
}

/** Clamp a timeline time to the finite range `[0, duration]`. */
export function clampTimelineTime(time: number, duration: number): number {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  if (!Number.isFinite(time)) return 0;
  return Math.min(safeDuration, Math.max(0, time));
}

/** Clamp a horizontal coordinate to the finite range `[0, width]`. */
export function clampTimelinePixel(pixel: number, width: number): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  if (!Number.isFinite(pixel)) return 0;
  return Math.min(safeWidth, Math.max(0, pixel));
}

/** Map an x coordinate onto edited timeline time, clamping both ends. */
export function pixelToTimelineTime(
  pixel: number,
  width: number,
  duration: number,
): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  if (safeWidth === 0 || safeDuration === 0) return 0;
  return roundTime((clampTimelinePixel(pixel, safeWidth) / safeWidth) * safeDuration);
}

/** Map edited timeline time onto an x coordinate, clamping both ends. */
export function timelineTimeToPixel(
  time: number,
  duration: number,
  width: number,
): number {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  if (safeDuration === 0 || safeWidth === 0) return 0;
  return (clampTimelineTime(time, safeDuration) / safeDuration) * safeWidth;
}

/**
 * Resolve a magnetic-track insertion index after removing the dragged clip.
 * Midpoints match Product Core's move semantics: equality inserts after a clip.
 */
export function calculateMoveTargetIndex(
  segments: readonly EditListSegment[],
  clipId: string,
  dropTimelineTime: number,
): number {
  requireClipId(clipId);
  findSegment(segments, clipId);
  const remaining = segments.filter((segment) => segment.id !== clipId);
  const dropTime = clampTimelineTime(dropTimelineTime, timelineDuration(segments));
  const insertion = remaining.findIndex(
    (segment) => dropTime < segment.timelineStart + editListSegmentDuration(segment) / 2,
  );
  return insertion < 0 ? remaining.length : insertion;
}

/** Build the Core move payload for an insertion index returned above. */
export function buildMoveOperation(
  segments: readonly EditListSegment[],
  clipId: string,
  targetIndex: number,
): EditListOperation {
  requireClipId(clipId);
  findSegment(segments, clipId);
  requireFinite(targetIndex, "targetIndex");

  const remaining = segments.filter((segment) => segment.id !== clipId);
  const insertion = Math.min(remaining.length, Math.max(0, Math.trunc(targetIndex)));
  const nextSegment = remaining[insertion];
  const start = nextSegment
    ? nextSegment.timelineStart
    : timelineDuration(remaining);

  return { type: "move", clipId, start: roundTime(Math.max(0, start)) };
}

/**
 * Build a one-edge trim from an absolute timeline position. The current v1 EDL
 * uses playbackRate=1, but the mapping remains explicit for forward safety.
 */
export function buildTrimOperation(
  segment: EditListSegment,
  edge: TrimEdge,
  timelineTime: number,
  sourceDuration: number,
): EditListOperation {
  requireClipId(segment.id);
  if (edge !== "start" && edge !== "end") {
    throw new TypeError("edge must be start or end");
  }
  requireFinite(timelineTime, "timelineTime");
  const safeSourceDuration = requireFinite(sourceDuration, "sourceDuration");
  if (safeSourceDuration < 0) throw new RangeError("sourceDuration must be non-negative");

  const playbackRate = requireFinite(segment.playbackRate, "segment.playbackRate");
  if (playbackRate <= 0) throw new RangeError("segment.playbackRate must be positive");
  const minimumSourceDuration = EDIT_LIST_MIN_SEGMENT_SECONDS * playbackRate;
  const sourceAtPointer =
    segment.sourceStart + (timelineTime - segment.timelineStart) * playbackRate;

  if (edge === "start") {
    const sourceStart = Math.min(
      segment.sourceEnd - minimumSourceDuration,
      Math.max(0, sourceAtPointer),
    );
    return {
      type: "trim",
      clipId: segment.id,
      sourceStart: roundTime(sourceStart),
      sourceEnd: roundTime(segment.sourceEnd),
    };
  }

  const sourceEnd = Math.min(
    safeSourceDuration,
    Math.max(segment.sourceStart + minimumSourceDuration, sourceAtPointer),
  );
  return {
    type: "trim",
    clipId: segment.id,
    sourceStart: roundTime(segment.sourceStart),
    sourceEnd: roundTime(sourceEnd),
  };
}

/** Build a split payload from an absolute timeline position. */
export function buildSplitOperation(
  segment: EditListSegment,
  timelineTime: number,
  newClipId?: string,
): EditListOperation {
  requireClipId(segment.id);
  requireFinite(timelineTime, "timelineTime");
  const duration = editListSegmentDuration(segment);
  if (duration < EDIT_LIST_MIN_SEGMENT_SECONDS * 2) {
    throw new RangeError(
      `Clip must be at least ${EDIT_LIST_MIN_SEGMENT_SECONDS * 2}s to split`,
    );
  }
  if (newClipId !== undefined) requireClipId(newClipId);

  const offset = Math.min(
    duration - EDIT_LIST_MIN_SEGMENT_SECONDS,
    Math.max(EDIT_LIST_MIN_SEGMENT_SECONDS, timelineTime - segment.timelineStart),
  );
  return {
    type: "split",
    clipId: segment.id,
    offset: roundTime(offset),
    ...(newClipId === undefined ? {} : { newClipId }),
  };
}

export function buildDeleteOperation(
  segment: Pick<EditListSegment, "id"> | string,
): EditListOperation {
  const clipId = requireClipId(typeof segment === "string" ? segment : segment.id);
  return { type: "delete", clipId };
}
