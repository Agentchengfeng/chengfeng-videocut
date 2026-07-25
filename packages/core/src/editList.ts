import {
  EDIT_LIST_SCHEMA_VERSION,
  type EditListDocument,
  type EditListOperation,
  type EditListSegment,
} from "@video-workbench/contracts";
import type { CutTimeRange } from "./cuts";
import { VideocutError } from "./errors";

export type {
  EditListDocument,
  EditListMode,
  EditListOperation,
  EditListSegment,
} from "@video-workbench/contracts";

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
export const EDIT_LIST_MIN_SEGMENT_SECONDS = 0.03;
const TIME_EPSILON = 0.001;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new VideocutError("invalid_edit_list", message, details);
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(`${field} must be a finite number`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return invalid(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function revision(value: unknown, field: string): string {
  const normalized = nonEmptyString(value, field);
  if (!REVISION_PATTERN.test(normalized)) {
    return invalid(`${field} must be a lowercase SHA-256 revision`);
  }
  return normalized;
}

function roundTime(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function editListSegmentDuration(segment: EditListSegment): number {
  return roundTime((segment.sourceEnd - segment.sourceStart) / segment.playbackRate);
}

function parseSegment(
  value: unknown,
  index: number,
  sourceDuration: number,
): EditListSegment {
  if (!isObject(value)) return invalid(`segments[${index}] must be an object`);
  const id = nonEmptyString(value.id, `segments[${index}].id`);
  const source = nonEmptyString(value.source, `segments[${index}].source`);
  const sourceStart = finite(value.sourceStart, `segments[${index}].sourceStart`);
  const sourceEnd = finite(value.sourceEnd, `segments[${index}].sourceEnd`);
  const timelineStart = finite(value.timelineStart, `segments[${index}].timelineStart`);
  const playbackRate = finite(value.playbackRate, `segments[${index}].playbackRate`);
  if (value.trackId !== "a-roll") {
    return invalid(`segments[${index}].trackId must be 'a-roll'`);
  }
  if (sourceStart < 0 || sourceEnd > sourceDuration + TIME_EPSILON) {
    return invalid(`segments[${index}] exceeds the source duration`, {
      sourceStart,
      sourceEnd,
      sourceDuration,
    });
  }
  if (sourceEnd - sourceStart < EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON) {
    return invalid(
      `segments[${index}] must retain at least ${EDIT_LIST_MIN_SEGMENT_SECONDS}s`,
    );
  }
  if (timelineStart < 0) return invalid(`segments[${index}].timelineStart must be non-negative`);
  if (playbackRate !== 1) {
    return invalid(
      `segments[${index}].playbackRate must be 1 because the current HyperFrames runtime does not support EDL rate changes`,
      { playbackRate, supportedPlaybackRate: 1 },
    );
  }
  return {
    id,
    source,
    sourceStart: roundTime(sourceStart),
    sourceEnd: roundTime(Math.min(sourceDuration, sourceEnd)),
    timelineStart: roundTime(timelineStart),
    trackId: "a-roll",
    playbackRate,
  };
}

function rippleSegments(segments: readonly EditListSegment[]): {
  segments: EditListSegment[];
  duration: number;
} {
  let cursor = 0;
  const rippled = segments.map((segment) => {
    const next = { ...segment, timelineStart: roundTime(cursor) };
    cursor = roundTime(cursor + editListSegmentDuration(next));
    return next;
  });
  return { segments: rippled, duration: roundTime(cursor) };
}

function documentWithSegments(
  document: Omit<EditListDocument, "segments" | "duration">,
  segments: readonly EditListSegment[],
): EditListDocument {
  const rippled = rippleSegments(segments);
  return {
    ...document,
    duration: rippled.duration,
    segments: rippled.segments,
  };
}

export function parseEditListDocument(payload: unknown): EditListDocument {
  if (!isObject(payload)) return invalid("edit-list.json must contain a JSON object");
  if (payload.schemaVersion !== EDIT_LIST_SCHEMA_VERSION) {
    return invalid(`edit-list.json schemaVersion must be ${EDIT_LIST_SCHEMA_VERSION}`);
  }
  const projectId = nonEmptyString(payload.projectId, "projectId");
  const sourceDuration = finite(payload.sourceDuration, "sourceDuration");
  if (!(sourceDuration > 0)) return invalid("sourceDuration must be positive");
  const baseCutsRevision = revision(payload.baseCutsRevision, "baseCutsRevision");
  const baseTranscriptRevision = revision(
    payload.baseTranscriptRevision,
    "baseTranscriptRevision",
  );
  if (payload.mode !== "cuts-derived" && payload.mode !== "manual") {
    return invalid("mode must be 'cuts-derived' or 'manual'");
  }
  if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
    return invalid("segments must contain at least one A-roll segment");
  }
  const parsed = payload.segments.map((segment, index) =>
    parseSegment(segment, index, sourceDuration));
  const seen = new Set<string>();
  for (const segment of parsed) {
    if (seen.has(segment.id)) return invalid(`Segment id is not unique: ${segment.id}`);
    seen.add(segment.id);
  }

  const ordered = [...parsed].sort(
    (left, right) => left.timelineStart - right.timelineStart || left.id.localeCompare(right.id),
  );
  const normalized = documentWithSegments(
    {
      schemaVersion: EDIT_LIST_SCHEMA_VERSION,
      projectId,
      sourceDuration: roundTime(sourceDuration),
      baseCutsRevision,
      baseTranscriptRevision,
      mode: payload.mode,
    },
    ordered,
  );
  const claimedDuration = finite(payload.duration, "duration");
  if (Math.abs(claimedDuration - normalized.duration) > TIME_EPSILON) {
    return invalid("duration does not match the magnetic A-roll segments", {
      claimedDuration,
      derivedDuration: normalized.duration,
    });
  }
  parsed.forEach((segment, index) => {
    const expected = normalized.segments[index]?.timelineStart;
    if (expected === undefined || Math.abs(segment.timelineStart - expected) > TIME_EPSILON) {
      invalid("timelineStart values must form one gapless magnetic A-roll", {
        segmentId: segment.id,
        timelineStart: segment.timelineStart,
        expected,
      });
    }
  });
  return normalized;
}

function mergeCutRanges(
  ranges: readonly CutTimeRange[],
  sourceDuration: number,
): CutTimeRange[] {
  const normalized = ranges.map((range, index) => {
    const start = finite(range.start, `cutRanges[${index}].start`);
    const end = finite(range.end, `cutRanges[${index}].end`);
    if (start < 0 || end <= start || start > sourceDuration + TIME_EPSILON) {
      return invalid(`cutRanges[${index}] is invalid`, { start, end, sourceDuration });
    }
    return {
      start: roundTime(Math.min(sourceDuration, start)),
      end: roundTime(Math.min(sourceDuration, end)),
    };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CutTimeRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + TIME_EPSILON) {
      previous.end = roundTime(Math.max(previous.end, range.end));
    } else if (range.end - range.start >= TIME_EPSILON) {
      merged.push({ ...range });
    }
  }
  return merged;
}

export interface BuildEditListFromCutsInput {
  projectId: string;
  source: string;
  sourceDuration: number;
  cutsRevision: string;
  transcriptRevision: string;
  cutRanges: readonly CutTimeRange[];
}

export function buildEditListFromCuts(input: BuildEditListFromCutsInput): EditListDocument {
  const projectId = nonEmptyString(input.projectId, "projectId");
  const source = nonEmptyString(input.source, "source");
  const sourceDuration = finite(input.sourceDuration, "sourceDuration");
  if (!(sourceDuration > 0)) return invalid("sourceDuration must be positive");
  const cuts = mergeCutRanges(input.cutRanges, sourceDuration);
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start - cursor >= EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON) {
      keep.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (sourceDuration - cursor >= EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON) {
    keep.push({ start: cursor, end: sourceDuration });
  }
  if (keep.length === 0) return invalid("Cuts would remove the entire source video");
  const segments: EditListSegment[] = keep.map((range, index) => ({
    id: `a-roll-${String(index + 1).padStart(4, "0")}`,
    source,
    sourceStart: roundTime(range.start),
    sourceEnd: roundTime(range.end),
    timelineStart: 0,
    trackId: "a-roll",
    playbackRate: 1,
  }));
  return documentWithSegments(
    {
      schemaVersion: EDIT_LIST_SCHEMA_VERSION,
      projectId,
      sourceDuration: roundTime(sourceDuration),
      baseCutsRevision: revision(input.cutsRevision, "cutsRevision"),
      baseTranscriptRevision: revision(input.transcriptRevision, "transcriptRevision"),
      mode: "cuts-derived",
    },
    segments,
  );
}

function operationObject(value: unknown): JsonObject {
  if (!isObject(value)) return invalid("operation must be a JSON object");
  return value;
}

function operationClipId(value: JsonObject): string {
  return nonEmptyString(value.clipId, "operation.clipId");
}

function parseDeleteRangeFields(
  value: JsonObject,
  fieldPrefix = "operation",
): Extract<EditListOperation, { type: "delete-range" }> {
  return {
    type: "delete-range",
    source: nonEmptyString(value.source, `${fieldPrefix}.source`),
    sourceStart: finite(value.sourceStart, `${fieldPrefix}.sourceStart`),
    sourceEnd: finite(value.sourceEnd, `${fieldPrefix}.sourceEnd`),
  };
}

function parseRestoreFields(value: JsonObject): Omit<Extract<EditListOperation, { type: "restore" }>, "type"> {
  const sourceStart = finite(value.sourceStart, "operation.sourceStart");
  const sourceEnd = finite(value.sourceEnd, "operation.sourceEnd");
  const previousSegmentId = value.previousSegmentId === undefined
    ? undefined
    : nonEmptyString(value.previousSegmentId, "operation.previousSegmentId");
  const nextSegmentId = value.nextSegmentId === undefined
    ? undefined
    : nonEmptyString(value.nextSegmentId, "operation.nextSegmentId");
  if (!previousSegmentId && !nextSegmentId) {
    return invalid("Restore requires a previousSegmentId or nextSegmentId anchor");
  }
  return {
    sourceStart,
    sourceEnd,
    ...(previousSegmentId ? { previousSegmentId } : {}),
    ...(nextSegmentId ? { nextSegmentId } : {}),
  };
}

export function parseEditListOperation(payload: unknown): EditListOperation {
  const value = operationObject(payload);
  const type = nonEmptyString(value.type, "operation.type");
  if (type === "restore-snapshot") {
    if (
      !Array.isArray(value.expectedSegments) ||
      !Array.isArray(value.beforeSegments) ||
      !isObject(value.inverse)
    ) {
      return invalid("Restore snapshot requires expectedSegments, beforeSegments, and inverse");
    }
    const inverse = parseEditListOperation(value.inverse);
    if (inverse.type !== "delete-range" && inverse.type !== "restore-deduplicate") {
      return invalid("Restore snapshot inverse must be delete-range or restore-deduplicate");
    }
    return {
      type,
      expectedSegments: value.expectedSegments as EditListSegment[],
      beforeSegments: value.beforeSegments as EditListSegment[],
      beforeMode: value.beforeMode === "cuts-derived" || value.beforeMode === "manual"
        ? value.beforeMode
        : invalid("Restore snapshot beforeMode must be cuts-derived or manual"),
      inverse,
    };
  }
  if (type === "delete-range") {
    return parseDeleteRangeFields(value);
  }
  if (type === "restore-deduplicate") {
    if (!Array.isArray(value.duplicateRanges) || value.duplicateRanges.length === 0) {
      return invalid("Restore deduplicate requires at least one duplicate range");
    }
    return {
      type,
      ...parseRestoreFields(value),
      duplicateRanges: value.duplicateRanges.map((candidate, index) => {
        if (!isObject(candidate)) {
          return invalid(`operation.duplicateRanges[${index}] must be an object`);
        }
        return parseDeleteRangeFields(candidate, `operation.duplicateRanges[${index}]`);
      }),
    };
  }
  if (type === "restore") {
    return { type, ...parseRestoreFields(value) };
  }
  const clipId = operationClipId(value);
  if (type === "move") {
    const start = finite(value.start, "operation.start");
    if (start < 0) return invalid("operation.start must be non-negative");
    return { type, clipId, start };
  }
  if (type === "trim") {
    const sourceStart = finite(value.sourceStart, "operation.sourceStart");
    const sourceEnd = finite(value.sourceEnd, "operation.sourceEnd");
    return { type, clipId, sourceStart, sourceEnd };
  }
  if (type === "split") {
    const offset = finite(value.offset, "operation.offset");
    const newClipId = value.newClipId === undefined
      ? undefined
      : nonEmptyString(value.newClipId, "operation.newClipId");
    return { type, clipId, offset, ...(newClipId ? { newClipId } : {}) };
  }
  if (type === "delete") return { type, clipId };
  return invalid(`Unsupported edit-list operation: ${type}`);
}

function nextSplitId(document: EditListDocument, segment: EditListSegment, sourceSplit: number): string {
  const base = `${segment.id}__split_${Math.round(sourceSplit * 1000)}`;
  const ids = new Set(document.segments.map((candidate) => candidate.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function nextDeleteRangeSplitId(
  segment: EditListSegment,
  sourceSplit: number,
  ids: Set<string>,
): string {
  const base = `${segment.id}__split_${Math.round(sourceSplit * 1000)}`;
  if (!ids.has(base)) {
    ids.add(base);
    return base;
  }
  let suffix = 2;
  while (ids.has(`${base}_${suffix}`)) suffix += 1;
  const id = `${base}_${suffix}`;
  ids.add(id);
  return id;
}

function sameSegmentOrder(left: readonly EditListSegment[], right: readonly EditListSegment[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment.id === right[index]?.id);
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd - TIME_EPSILON && leftEnd > rightStart + TIME_EPSILON;
}

function nextRestoreId(document: EditListDocument, sourceStart: number, sourceEnd: number): string {
  const base = `a-roll-restore-${Math.round(sourceStart * 1_000_000)}-${Math.round(sourceEnd * 1_000_000)}`;
  const ids = new Set(document.segments.map((candidate) => candidate.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function restoreInsertion(
  document: EditListDocument,
  operation: Extract<EditListOperation, { type: "restore" | "restore-deduplicate" }>,
): { index: number; source: string } {
  const sourceStart = roundTime(operation.sourceStart);
  const sourceEnd = roundTime(operation.sourceEnd);
  if (
    sourceStart < 0 ||
    sourceEnd > document.sourceDuration + TIME_EPSILON ||
    sourceEnd - sourceStart < EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON
  ) {
    return invalid("Restore range is outside the source or below the minimum segment duration", {
      sourceStart,
      sourceEnd,
      sourceDuration: document.sourceDuration,
    });
  }
  if (document.segments.some((segment) => rangesOverlap(
    sourceStart,
    sourceEnd,
    segment.sourceStart,
    segment.sourceEnd,
  ))) {
    return invalid("Restore range overlaps a retained edit-list segment", { sourceStart, sourceEnd });
  }

  const previousIndex = operation.previousSegmentId === undefined
    ? -1
    : document.segments.findIndex((segment) => segment.id === operation.previousSegmentId);
  const nextIndex = operation.nextSegmentId === undefined
    ? -1
    : document.segments.findIndex((segment) => segment.id === operation.nextSegmentId);
  if (operation.previousSegmentId && previousIndex < 0) {
    return invalid("Restore previousSegmentId is not present in the current edit list", {
      previousSegmentId: operation.previousSegmentId,
    });
  }
  if (operation.nextSegmentId && nextIndex < 0) {
    return invalid("Restore nextSegmentId is not present in the current edit list", {
      nextSegmentId: operation.nextSegmentId,
    });
  }

  const previous = previousIndex >= 0 ? document.segments[previousIndex] : undefined;
  const next = nextIndex >= 0 ? document.segments[nextIndex] : undefined;
  if (previous && next) {
    if (nextIndex !== previousIndex + 1) {
      return invalid("Restore anchors must be adjacent in the current timeline", {
        previousSegmentId: previous.id,
        nextSegmentId: next.id,
      });
    }
    if (sourceStart < previous.sourceEnd - TIME_EPSILON || sourceEnd > next.sourceStart + TIME_EPSILON) {
      return invalid("Restore range no longer fits between its current source anchors", {
        sourceStart,
        sourceEnd,
        previousSourceEnd: previous.sourceEnd,
        nextSourceStart: next.sourceStart,
      });
    }
    if (previous.source !== next.source) {
      return invalid("Restore anchors must reference the same source media");
    }
    return { index: nextIndex, source: previous.source };
  }
  if (previous) {
    if (previousIndex !== document.segments.length - 1 || sourceStart < previous.sourceEnd - TIME_EPSILON) {
      return invalid("A previous-only restore anchor is valid only at the current timeline tail");
    }
    return { index: document.segments.length, source: previous.source };
  }
  if (next) {
    if (nextIndex !== 0 || sourceEnd > next.sourceStart + TIME_EPSILON) {
      return invalid("A next-only restore anchor is valid only at the current timeline head");
    }
    return { index: 0, source: next.source };
  }
  return invalid("Restore requires current timeline anchors");
}

function restoreSegments(
  document: EditListDocument,
  operation: Extract<EditListOperation, { type: "restore" | "restore-deduplicate" }>,
): { segments: EditListSegment[]; source: string; sourceStart: number; sourceEnd: number } {
  const insertion = restoreInsertion(document, operation);
  const sourceStart = roundTime(operation.sourceStart);
  const sourceEnd = roundTime(operation.sourceEnd);
  const segments = [...document.segments];
  segments.splice(insertion.index, 0, {
    id: nextRestoreId(document, sourceStart, sourceEnd),
    source: insertion.source,
    sourceStart,
    sourceEnd,
    timelineStart: 0,
    trackId: "a-roll",
    playbackRate: 1,
  });
  return { segments, source: insertion.source, sourceStart, sourceEnd };
}

function manualDocumentWithSegments(
  document: EditListDocument,
  segments: readonly EditListSegment[],
): EditListDocument {
  return documentWithSegments(
    {
      schemaVersion: document.schemaVersion,
      projectId: document.projectId,
      sourceDuration: document.sourceDuration,
      baseCutsRevision: document.baseCutsRevision,
      baseTranscriptRevision: document.baseTranscriptRevision,
      mode: "manual",
    },
    segments,
  );
}

function deleteRangeSegments(
  document: EditListDocument,
  operation: Extract<EditListOperation, { type: "delete-range" }>,
): EditListSegment[] {
  const sourceStart = roundTime(operation.sourceStart);
  const sourceEnd = roundTime(operation.sourceEnd);
  if (
    sourceStart < 0 ||
    sourceEnd > document.sourceDuration + TIME_EPSILON ||
    sourceEnd - sourceStart <= TIME_EPSILON
  ) {
    return invalid("Delete range is outside the source or empty", {
      sourceStart,
      sourceEnd,
      sourceDuration: document.sourceDuration,
    });
  }

  let overlaps = false;
  const ids = new Set(document.segments.map((segment) => segment.id));
  const segments: EditListSegment[] = [];
  for (const segment of document.segments) {
    if (segment.source !== operation.source) {
      segments.push(segment);
      continue;
    }
    const overlapStart = Math.max(segment.sourceStart, sourceStart);
    const overlapEnd = Math.min(segment.sourceEnd, sourceEnd);
    if (overlapEnd - overlapStart <= TIME_EPSILON) {
      segments.push(segment);
      continue;
    }
    overlaps = true;
    const keepLeft = overlapStart - segment.sourceStart >= EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON;
    const keepRight = segment.sourceEnd - overlapEnd >= EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON;
    if (keepLeft && keepRight) {
      segments.push(
        { ...segment, sourceEnd: overlapStart },
        {
          ...segment,
          id: nextDeleteRangeSplitId(segment, overlapEnd, ids),
          sourceStart: overlapEnd,
        },
      );
    } else if (keepLeft) {
      segments.push({ ...segment, sourceEnd: overlapStart });
    } else if (keepRight) {
      // The segment was only head-trimmed (or its tiny left residual was
      // absorbed), so retain its identity instead of inventing a split.
      segments.push({ ...segment, sourceStart: overlapEnd });
    }
    // A short residual is intentionally absorbed into this range. Never
    // emit a sub-minimum segment just to preserve an exact word boundary.
  }
  if (!overlaps) {
    return invalid("Delete range does not overlap a retained edit-list segment", {
      sourceStart,
      sourceEnd,
    });
  }
  if (segments.length === 0) {
    return invalid("The edit list cannot delete all retained content");
  }
  return segments;
}

function snapshotDocument(
  document: EditListDocument,
  rawSegments: readonly EditListSegment[],
  mode: EditListDocument["mode"],
): EditListDocument {
  if (rawSegments.length === 0) return invalid("Restore snapshot must retain at least one segment");
  const parsed = rawSegments.map((segment, index) =>
    parseSegment(segment, index, document.sourceDuration));
  const ids = new Set<string>();
  for (const segment of parsed) {
    if (ids.has(segment.id)) return invalid(`Segment id is not unique: ${segment.id}`);
    ids.add(segment.id);
  }
  const next = documentWithSegments(
    {
      schemaVersion: document.schemaVersion,
      projectId: document.projectId,
      sourceDuration: document.sourceDuration,
      baseCutsRevision: document.baseCutsRevision,
      baseTranscriptRevision: document.baseTranscriptRevision,
      mode,
    },
    parsed,
  );
  parsed.forEach((segment, index) => {
    const expected = next.segments[index]?.timelineStart;
    if (expected === undefined || Math.abs(segment.timelineStart - expected) > TIME_EPSILON) {
      return invalid("Restore snapshot segments must form one gapless magnetic A-roll", {
        segmentId: segment.id,
        timelineStart: segment.timelineStart,
        expected,
      });
    }
  });
  return next;
}

export function applyEditListOperation(
  input: EditListDocument,
  rawOperation: EditListOperation | unknown,
): EditListDocument {
  const document = parseEditListDocument(input);
  const operation = parseEditListOperation(rawOperation);
  if (operation.type === "restore" || operation.type === "restore-deduplicate") {
    const restored = restoreSegments(document, operation);
    if (operation.type === "restore") {
      return manualDocumentWithSegments(document, restored.segments);
    }
    const ranges = [...operation.duplicateRanges].sort((left, right) =>
      left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd,
    );
    let previousRangeEnd = restored.sourceEnd;
    let next = manualDocumentWithSegments(document, restored.segments);
    for (const range of ranges) {
      const duplicateStart = roundTime(range.sourceStart);
      const duplicateEnd = roundTime(range.sourceEnd);
      if (range.source !== restored.source) {
        return invalid("Restore duplicate ranges must reference the restored source media");
      }
      if (duplicateStart < restored.sourceEnd - TIME_EPSILON) {
        return invalid("Restore duplicate ranges must be later than the restored source range");
      }
      if (duplicateStart < previousRangeEnd - TIME_EPSILON) {
        return invalid("Restore duplicate ranges must not overlap each other");
      }
      next = manualDocumentWithSegments(next, deleteRangeSegments(next, range));
      previousRangeEnd = duplicateEnd;
    }
    return next;
  }
  if (operation.type === "delete-range") {
    return manualDocumentWithSegments(document, deleteRangeSegments(document, operation));
  }
  if (operation.type === "restore-snapshot") {
    const expected = snapshotDocument(document, operation.expectedSegments, document.mode);
    if (JSON.stringify(expected.segments) !== JSON.stringify(document.segments)) {
      return invalid("Restore snapshot no longer matches the current edit-list segments");
    }
    const before = snapshotDocument(document, operation.beforeSegments, operation.beforeMode);
    const replay = applyEditListOperation(before, operation.inverse);
    if (JSON.stringify(replay.segments) !== JSON.stringify(document.segments)) {
      return invalid("Restore snapshot inverse does not reproduce the current edit-list segments");
    }
    return before;
  }
  const index = document.segments.findIndex((segment) => segment.id === operation.clipId);
  if (index < 0) return invalid(`Unknown edit-list clip id: ${operation.clipId}`);
  const segment = document.segments[index];
  let segments = [...document.segments];

  if (operation.type === "move") {
    const remaining = segments.filter((candidate) => candidate.id !== segment.id);
    const insertion = remaining.findIndex(
      (candidate) => operation.start < candidate.timelineStart + editListSegmentDuration(candidate) / 2,
    );
    remaining.splice(insertion < 0 ? remaining.length : insertion, 0, segment);
    if (sameSegmentOrder(segments, remaining)) return document;
    segments = remaining;
  } else if (operation.type === "trim") {
    const sourceStart = roundTime(operation.sourceStart);
    const sourceEnd = roundTime(operation.sourceEnd);
    if (sourceStart < 0 || sourceEnd > document.sourceDuration + TIME_EPSILON) {
      return invalid("Trim exceeds the source duration", {
        sourceStart,
        sourceEnd,
        sourceDuration: document.sourceDuration,
      });
    }
    if (sourceEnd - sourceStart < EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON) {
      return invalid(`Trim must retain at least ${EDIT_LIST_MIN_SEGMENT_SECONDS}s`);
    }
    if (
      Math.abs(sourceStart - segment.sourceStart) <= TIME_EPSILON &&
      Math.abs(sourceEnd - segment.sourceEnd) <= TIME_EPSILON
    ) return document;
    segments[index] = { ...segment, sourceStart, sourceEnd };
  } else if (operation.type === "split") {
    const duration = editListSegmentDuration(segment);
    if (
      operation.offset < EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON ||
      duration - operation.offset < EDIT_LIST_MIN_SEGMENT_SECONDS - TIME_EPSILON
    ) {
      return invalid(
        `Split must leave at least ${EDIT_LIST_MIN_SEGMENT_SECONDS}s on both sides`,
        {
        offset: operation.offset,
        duration,
        },
      );
    }
    const sourceSplit = roundTime(segment.sourceStart + operation.offset * segment.playbackRate);
    const rightId = operation.newClipId ?? nextSplitId(document, segment, sourceSplit);
    if (document.segments.some((candidate) => candidate.id === rightId)) {
      return invalid(`Segment id is not unique: ${rightId}`);
    }
    segments.splice(
      index,
      1,
      { ...segment, sourceEnd: sourceSplit },
      { ...segment, id: rightId, sourceStart: sourceSplit },
    );
  } else {
    if (segments.length === 1) return invalid("The edit list cannot delete its final segment");
    segments.splice(index, 1);
  }

  return documentWithSegments(
    {
      schemaVersion: document.schemaVersion,
      projectId: document.projectId,
      sourceDuration: document.sourceDuration,
      baseCutsRevision: document.baseCutsRevision,
      baseTranscriptRevision: document.baseTranscriptRevision,
      mode: "manual",
    },
    segments,
  );
}

export function timelineTimeToSourceTime(
  input: EditListDocument,
  timelineTime: number,
): number | null {
  const document = parseEditListDocument(input);
  if (!Number.isFinite(timelineTime) || timelineTime < 0 || timelineTime > document.duration) {
    return null;
  }
  for (const [index, segment] of document.segments.entries()) {
    const duration = editListSegmentDuration(segment);
    const end = segment.timelineStart + duration;
    if (timelineTime < end || (index === document.segments.length - 1 && timelineTime <= end)) {
      return roundTime(
        segment.sourceStart + Math.max(0, timelineTime - segment.timelineStart) * segment.playbackRate,
      );
    }
  }
  return null;
}

export function sourceTimeToTimelineTime(
  input: EditListDocument,
  sourceTime: number,
): number | null {
  const document = parseEditListDocument(input);
  if (!Number.isFinite(sourceTime) || sourceTime < 0 || sourceTime > document.sourceDuration) {
    return null;
  }
  for (const [index, segment] of document.segments.entries()) {
    const includesEnd = index === document.segments.length - 1;
    if (
      sourceTime >= segment.sourceStart - TIME_EPSILON &&
      (sourceTime < segment.sourceEnd || (includesEnd && sourceTime <= segment.sourceEnd))
    ) {
      return roundTime(
        segment.timelineStart + (sourceTime - segment.sourceStart) / segment.playbackRate,
      );
    }
  }
  return null;
}

export function hasSameEditListMeaning(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(parseEditListDocument(left)) === JSON.stringify(parseEditListDocument(right));
  } catch {
    return false;
  }
}
