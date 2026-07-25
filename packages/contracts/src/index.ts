export const WORKBENCH_SCHEMA_VERSION = 1 as const;

export type WorkbenchTrackKind =
  | "a-roll"
  | "b-roll"
  | "caption"
  | "audio"
  | "overlay";

export interface WorkbenchTrack {
  id: string;
  kind: WorkbenchTrackKind;
  label: string;
  order: number;
  locked?: boolean;
  hidden?: boolean;
}

export interface WorkbenchClip {
  id: string;
  trackId: string;
  label: string;
  start: number;
  duration: number;
  source?: string;
  sourceStart?: number;
  metadata?: Record<string, unknown>;
}

export const EDIT_LIST_SCHEMA_VERSION = 1 as const;

export type EditListMode = "cuts-derived" | "manual";

/**
 * One linked audio/video segment on the magnetic primary A-roll track.
 * `playbackRate` is reserved for a future schema and MUST be `1` in v1. The
 * current HyperFrames runtime does not provide deterministic EDL rate changes.
 * Timeline duration is therefore `sourceEnd - sourceStart` in this schema.
 */
export interface EditListSegment {
  id: string;
  source: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  trackId: "a-roll";
  playbackRate: number;
}

/** Product-owned, non-destructive edit decision list. */
export interface EditListDocument {
  schemaVersion: typeof EDIT_LIST_SCHEMA_VERSION;
  projectId: string;
  sourceDuration: number;
  baseCutsRevision: string;
  baseTranscriptRevision: string;
  mode: EditListMode;
  duration: number;
  segments: EditListSegment[];
}

export interface EditListDeleteRangeOperation {
  type: "delete-range";
  /** Required media identity: source times are only meaningful within it. */
  source: string;
  sourceStart: number;
  sourceEnd: number;
}

/** Restore one deleted source range at verified current timeline anchors. */
export interface EditListRestoreOperation {
  type: "restore";
  sourceStart: number;
  sourceEnd: number;
  previousSegmentId?: string;
  nextSegmentId?: string;
}

/**
 * Restore one complete retained sentence while atomically removing the later,
 * exact duplicate ranges selected by the transcript surface. Core validates
 * geometry and current EDL retention; transcript text comparison stays in the
 * transcript owner.
 */
export interface EditListRestoreDeduplicateOperation {
  type: "restore-deduplicate";
  sourceStart: number;
  sourceEnd: number;
  previousSegmentId?: string;
  nextSegmentId?: string;
  duplicateRanges: EditListDeleteRangeOperation[];
}

export interface EditListRestoreSnapshotOperation {
  type: "restore-snapshot";
  expectedSegments: EditListSegment[];
  beforeSegments: EditListSegment[];
  beforeMode: EditListMode;
  inverse: EditListDeleteRangeOperation | EditListRestoreDeduplicateOperation;
}

export type EditListOperation =
  | { type: "move"; clipId: string; start: number }
  | { type: "trim"; clipId: string; sourceStart: number; sourceEnd: number }
  | { type: "split"; clipId: string; offset: number; newClipId?: string }
  | { type: "delete"; clipId: string }
  /**
   * Remove one source-time range from the current magnetic timeline in one
   * transaction. This is intentionally independent from semantic Cuts so a
   * manual EditList can keep its current segment order.
   */
  | EditListDeleteRangeOperation
  /**
   * History-only exact restoration of a previously committed EditList shape.
   * Core requires this to prove it is the exact inverse of `inverse`: it
   * replays inverse from beforeSegments and requires that result to equal the
   * current segments. This is deliberately not a general document-replace API.
   */
  | EditListRestoreSnapshotOperation
  /**
   * Restore one source range into the current magnetic A-roll without asking
   * the reducer to infer a source-order insertion point. Both anchors are
   * optional only at the outer boundary; Core verifies their current order.
   */
  | EditListRestoreOperation
  | EditListRestoreDeduplicateOperation;

export interface WorkbenchSubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
  sourceId?: string;
}

export interface HyperframesEngineConfig {
  kind: "hyperframes";
  projectId: string;
  entry: string;
}

export interface WorkbenchWorkflowRef {
  kind: string;
  jobId?: string;
  apiBase?: string;
}

export interface WorkbenchProjectManifest {
  schemaVersion: typeof WORKBENCH_SCHEMA_VERSION;
  id: string;
  title: string;
  duration: number;
  aspectRatio?: string;
  engine: HyperframesEngineConfig;
  workflow?: WorkbenchWorkflowRef;
  tracks?: WorkbenchTrack[];
  clips?: WorkbenchClip[];
  subtitles?: {
    source: string;
    editableSource?: string;
    cues?: WorkbenchSubtitleCue[];
  };
  artifacts?: Record<string, string>;
}

export interface WorkbenchOpenState {
  time?: number;
  tab?: "design" | "variables" | "code";
  timelineVisible?: boolean;
}

export interface WorkbenchEngineAdapter {
  readonly kind: string;
  canOpen(manifest: WorkbenchProjectManifest): boolean;
  buildPreviewUrl(
    manifest: WorkbenchProjectManifest,
    state?: WorkbenchOpenState,
  ): string;
}

export interface WorkbenchWorkflowAdapter {
  readonly kind: string;
  loadProject(jobId: string): Promise<WorkbenchProjectManifest>;
  saveSubtitles?(
    jobId: string,
    cues: WorkbenchSubtitleCue[],
  ): Promise<void>;
  appendEvent?(
    jobId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<void>;
}

export function assertWorkbenchProjectManifest(
  value: unknown,
): asserts value is WorkbenchProjectManifest {
  if (!value || typeof value !== "object") {
    throw new TypeError("Workbench manifest must be an object");
  }
  const manifest = value as Partial<WorkbenchProjectManifest>;
  if (manifest.schemaVersion !== WORKBENCH_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported workbench schema: ${String(manifest.schemaVersion)}`);
  }
  if (!manifest.id || !manifest.title) {
    throw new TypeError("Workbench manifest requires id and title");
  }
  if (!Number.isFinite(manifest.duration) || Number(manifest.duration) < 0) {
    throw new TypeError("Workbench manifest duration must be a non-negative number");
  }
  if (!manifest.engine || manifest.engine.kind !== "hyperframes") {
    throw new TypeError("Workbench manifest requires a HyperFrames engine config");
  }
  if (!manifest.engine.projectId || !manifest.engine.entry) {
    throw new TypeError("HyperFrames engine config requires projectId and entry");
  }
}
