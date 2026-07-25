import {
  parseEditListDocument,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
  type EditListDocument,
  type EditListSegment,
} from "@video-workbench/core";

const TIME_EPSILON = 0.001;

export interface EdlTransportPosition {
  timelineTime: number;
  sourceTime: number;
  segmentIndex: number;
  segmentId: string;
  atTimelineEnd: boolean;
}

export type EdlRevisionTransitionDisposition =
  | "retained"
  | "deleted-next"
  | "deleted-tail";

export interface EdlRevisionTransition {
  fromRevision: string;
  toRevision: string;
  previousSourceTime: number;
  timelineTime: number;
  targetSegmentId: string | null;
  disposition: EdlRevisionTransitionDisposition;
  keepPlaying: boolean;
  atTimelineEnd: boolean;
}

export interface EdlSeekGenerationState {
  generation: number;
  revision: string | null;
}

export interface EdlSeekRequest {
  generation: number;
  revision: string;
  position: EdlTransportPosition;
}

export interface BeginEdlSeekResult {
  state: EdlSeekGenerationState;
  request: EdlSeekRequest;
}

function normalizedRevision(value: string, field: string): string {
  const revision = value.trim();
  if (!revision) throw new TypeError(`${field} must be a non-empty revision`);
  return revision;
}

function clampTimelineTime(document: EditListDocument, timelineTime: number): number {
  if (!Number.isFinite(timelineTime)) {
    throw new TypeError("timelineTime must be a finite number");
  }
  return Math.max(0, Math.min(document.duration, timelineTime));
}

function segmentIndexAtTimelineTime(
  segments: readonly EditListSegment[],
  timelineTime: number,
): number {
  let low = 0;
  let high = segments.length - 1;
  let index = 0;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (segments[middle].timelineStart <= timelineTime) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return index;
}

/**
 * Resolve one magnetic-timeline timestamp onto its retained source frame.
 *
 * Timeline ranges are half-open, so an exact internal boundary belongs to the
 * segment that starts at that boundary. Only the final timeline endpoint maps
 * to a segment end.
 */
export function resolveEdlTimelinePosition(
  input: EditListDocument,
  timelineTime: number,
): EdlTransportPosition {
  const document = parseEditListDocument(input);
  const normalizedTime = clampTimelineTime(document, timelineTime);
  const sourceTime = timelineTimeToSourceTime(document, normalizedTime);
  if (sourceTime === null) {
    throw new RangeError("The edit-list timeline position could not be mapped to source media");
  }
  const segmentIndex = segmentIndexAtTimelineTime(document.segments, normalizedTime);
  const segment = document.segments[segmentIndex];
  return {
    timelineTime: normalizedTime,
    sourceTime,
    segmentIndex,
    segmentId: segment.id,
    atTimelineEnd: normalizedTime >= document.duration - TIME_EPSILON,
  };
}

/** Return the first exact timeline occurrence of a retained source timestamp. */
export function resolveEdlSourcePosition(
  input: EditListDocument,
  sourceTime: number,
): EdlTransportPosition | null {
  if (!Number.isFinite(sourceTime)) {
    throw new TypeError("sourceTime must be a finite number");
  }
  const document = parseEditListDocument(input);
  const timelineTime = sourceTimeToTimelineTime(document, sourceTime);
  return timelineTime === null
    ? null
    : resolveEdlTimelinePosition(document, timelineTime);
}

function nextRetainedSegment(
  document: EditListDocument,
  sourceTime: number,
): EditListSegment | null {
  let next: EditListSegment | null = null;
  for (const segment of document.segments) {
    if (segment.sourceStart < sourceTime - TIME_EPSILON) continue;
    if (
      !next ||
      segment.sourceStart < next.sourceStart ||
      (
        Math.abs(segment.sourceStart - next.sourceStart) <= TIME_EPSILON &&
        segment.timelineStart < next.timelineStart
      )
    ) {
      next = segment;
    }
  }
  return next;
}

/**
 * Preserve content identity while replacing the current EDL revision.
 *
 * The stable migration domain is source time. If that source frame no longer
 * exists, playback lands on the next retained source range. Removing the tail
 * lands on the new timeline endpoint and always stops transport.
 */
export function resolveEdlRevisionTransition(input: {
  oldDocument: EditListDocument;
  oldRevision: string;
  newDocument: EditListDocument;
  newRevision: string;
  currentTimelineTime: number;
  wasPlaying: boolean;
}): EdlRevisionTransition {
  const oldRevision = normalizedRevision(input.oldRevision, "oldRevision");
  const newRevision = normalizedRevision(input.newRevision, "newRevision");
  const oldPosition = resolveEdlTimelinePosition(
    input.oldDocument,
    input.currentTimelineTime,
  );
  const newDocument = parseEditListDocument(input.newDocument);
  const retained = resolveEdlSourcePosition(newDocument, oldPosition.sourceTime);

  if (retained) {
    const atTimelineEnd = retained.timelineTime >= newDocument.duration - TIME_EPSILON;
    return {
      fromRevision: oldRevision,
      toRevision: newRevision,
      previousSourceTime: oldPosition.sourceTime,
      timelineTime: retained.timelineTime,
      targetSegmentId: retained.segmentId,
      disposition: "retained",
      keepPlaying: input.wasPlaying && !atTimelineEnd,
      atTimelineEnd,
    };
  }

  const next = nextRetainedSegment(newDocument, oldPosition.sourceTime);
  if (next) {
    return {
      fromRevision: oldRevision,
      toRevision: newRevision,
      previousSourceTime: oldPosition.sourceTime,
      timelineTime: next.timelineStart,
      targetSegmentId: next.id,
      disposition: "deleted-next",
      keepPlaying: input.wasPlaying,
      atTimelineEnd: false,
    };
  }

  return {
    fromRevision: oldRevision,
    toRevision: newRevision,
    previousSourceTime: oldPosition.sourceTime,
    timelineTime: newDocument.duration,
    targetSegmentId: null,
    disposition: "deleted-tail",
    keepPlaying: false,
    atTimelineEnd: true,
  };
}

export function createEdlSeekGenerationState(): EdlSeekGenerationState {
  return { generation: 0, revision: null };
}

/**
 * Issue an immutable seek token. Every newer request supersedes every older
 * request, including requests that target the same time in a previous EDL.
 */
export function beginEdlSeek(
  state: EdlSeekGenerationState,
  input: {
    revision: string;
    document: EditListDocument;
    timelineTime: number;
  },
): BeginEdlSeekResult {
  const revision = normalizedRevision(input.revision, "revision");
  const generation = state.generation + 1;
  const nextState = { generation, revision };
  return {
    state: nextState,
    request: {
      generation,
      revision,
      position: resolveEdlTimelinePosition(input.document, input.timelineTime),
    },
  };
}

export function isCurrentEdlSeek(
  state: EdlSeekGenerationState,
  request: Pick<EdlSeekRequest, "generation" | "revision">,
): boolean {
  return state.generation === request.generation && state.revision === request.revision;
}
