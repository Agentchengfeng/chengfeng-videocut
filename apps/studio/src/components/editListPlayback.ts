import {
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
  type EditListDocument,
} from "@video-workbench/core";
import type { TranscriptWord } from "./kouboTranscript";

export interface ManagedTimelineSegment {
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  playbackRate: number;
}

export interface EditListPlaybackTransition {
  /** Seek target in the newly materialized magnetic timeline. */
  timelineTime: number;
  /** Whether transport should resume after the new EDL has mounted. */
  keepPlaying: boolean;
}

function fallbackTimelineTimeToSourceTime(
  segments: readonly ManagedTimelineSegment[],
  timelineTime: number,
): number | null {
  for (const [index, segment] of segments.entries()) {
    const duration = (segment.sourceEnd - segment.sourceStart) / segment.playbackRate;
    const timelineEnd = segment.timelineStart + duration;
    const includesEnd = index === segments.length - 1;
    if (
      timelineTime >= segment.timelineStart &&
      (timelineTime < timelineEnd || (includesEnd && timelineTime <= timelineEnd))
    ) {
      return segment.sourceStart + (timelineTime - segment.timelineStart) * segment.playbackRate;
    }
  }
  return null;
}

function fallbackSourceTimeToTimelineTime(
  segments: readonly ManagedTimelineSegment[],
  sourceTime: number,
): number | null {
  for (const [index, segment] of segments.entries()) {
    const includesEnd = index === segments.length - 1;
    if (
      sourceTime >= segment.sourceStart &&
      (sourceTime < segment.sourceEnd || (includesEnd && sourceTime <= segment.sourceEnd))
    ) {
      return segment.timelineStart + (sourceTime - segment.sourceStart) / segment.playbackRate;
    }
  }
  return null;
}

export function resolveSourcePlayheadTime(
  document: EditListDocument | null,
  timelineTime: number,
  fallbackSegments: readonly ManagedTimelineSegment[] = [],
): number {
  if (document) return timelineTimeToSourceTime(document, timelineTime) ?? timelineTime;
  return fallbackTimelineTimeToSourceTime(fallbackSegments, timelineTime) ?? timelineTime;
}

/**
 * Resolve a transcript/source timestamp into the editable timeline domain.
 * Deleted source words snap to the nearest retained boundary so every transcript
 * click still produces a deterministic seek.
 */
export function resolveTranscriptSeekTime(
  document: EditListDocument | null,
  sourceTime: number,
  fallbackSegments: readonly ManagedTimelineSegment[] = [],
): number {
  if (!document && fallbackSegments.length === 0) return sourceTime;
  const direct = document
    ? sourceTimeToTimelineTime(document, sourceTime)
    : fallbackSourceTimeToTimelineTime(fallbackSegments, sourceTime);
  if (direct != null) return direct;

  const segments = document?.segments ?? fallbackSegments;
  const next = segments.reduce<(typeof segments)[number] | null>((nearest, segment) => {
    if (segment.sourceStart < sourceTime) return nearest;
    if (!nearest || segment.sourceStart < nearest.sourceStart) return segment;
    if (segment.sourceStart === nearest.sourceStart && segment.timelineStart < nearest.timelineStart) {
      return segment;
    }
    return nearest;
  }, null);
  if (next) return next.timelineStart;

  const previous = segments.reduce<(typeof segments)[number] | null>((nearest, segment) => {
    if (segment.sourceEnd > sourceTime) return nearest;
    if (!nearest || segment.sourceEnd > nearest.sourceEnd) return segment;
    if (segment.sourceEnd === nearest.sourceEnd && segment.timelineStart < nearest.timelineStart) {
      return segment;
    }
    return nearest;
  }, null);
  if (previous) {
    const duration = (previous.sourceEnd - previous.sourceStart) / previous.playbackRate;
    return previous.timelineStart + duration;
  }
  return 0;
}

/**
 * Preserve playback intent across an edit-list replacement.
 *
 * A magnetic delete changes the meaning of every timeline timestamp after the
 * removed range. Reusing the old timeline seconds therefore jumps to the wrong
 * source content. Translate through the stable source domain instead:
 *
 * old timeline -> old source -> new timeline -> new source
 *
 * `resolveTranscriptSeekTime` also gives deleted source positions a deterministic
 * landing point: the next retained segment boundary (or the previous end when
 * the deletion removed the tail).
 */
export function resolveEditListPlaybackTransition(input: {
  oldEditList: EditListDocument | null;
  newEditList: EditListDocument | null;
  managedSegments?: readonly ManagedTimelineSegment[];
  currentTimelineTime: number;
  wasPlaying: boolean;
}): EditListPlaybackTransition {
  const previousSourceTime = resolveSourcePlayheadTime(
    input.oldEditList,
    input.currentTimelineTime,
    input.managedSegments,
  );
  const timelineTime = resolveTranscriptSeekTime(
    input.newEditList,
    previousSourceTime,
    input.managedSegments,
  );

  const nextDuration = input.newEditList?.duration ?? (() => {
    const segments = input.managedSegments ?? [];
    return segments.reduce((duration, segment) => Math.max(
      duration,
      segment.timelineStart +
        (segment.sourceEnd - segment.sourceStart) / segment.playbackRate,
    ), 0);
  })();
  const hasForwardContent = nextDuration <= 0 || timelineTime < nextDuration;

  return {
    timelineTime,
    keepPlaying: input.wasPlaying && hasForwardContent,
  };
}

export function requestEditListPlaybackTransition(
  input: Parameters<typeof resolveEditListPlaybackTransition>[0],
  requestSeek: (time: number, options: { keepPlaying: boolean }) => void,
): EditListPlaybackTransition {
  const transition = resolveEditListPlaybackTransition(input);
  requestSeek(transition.timelineTime, { keepPlaying: transition.keepPlaying });
  return transition;
}

export function deriveActualCutWordIds(
  words: readonly TranscriptWord[],
  semanticCutWordIds: ReadonlySet<string>,
  document: EditListDocument | null,
  fallbackSegments: readonly ManagedTimelineSegment[] = [],
): Set<string> {
  const segments = document?.segments ?? fallbackSegments;
  if (segments.length === 0) return new Set(semanticCutWordIds);
  const actualCuts = new Set<string>();
  for (const word of words) {
    const midpoint = word.start + (word.end - word.start) / 2;
    const covered = segments.some(
      (segment) => midpoint >= segment.sourceStart && midpoint < segment.sourceEnd,
    );
    if (!covered) actualCuts.add(word.id);
  }
  return actualCuts;
}

export function shouldUseLegacyCutPlayback(input: {
  document: EditListDocument | null;
  loading: boolean;
  hasManagedTimelineElements: boolean;
}): boolean {
  return !input.document && !input.loading && !input.hasManagedTimelineElements;
}
