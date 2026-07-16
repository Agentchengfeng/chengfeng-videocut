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

