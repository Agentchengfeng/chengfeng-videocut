export const WORKBENCH_SCHEMA_VERSION = 1 as const;

export const JOB_SCHEMA_VERSION = 1 as const;

export type JobKind = "transcribe" | "cut" | "export" | "render";

export const RUNTIME_CONTRACT_SCHEMA_VERSION = 1 as const;

export const RUNTIME_SERVICE_OPERATIONS = [
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "ensure",
] as const;

export type RuntimeServiceOperation = (typeof RUNTIME_SERVICE_OPERATIONS)[number];

export const RUNTIME_DURABLE_JOB_KINDS = ["export"] as const satisfies readonly JobKind[];

export type RuntimeDurableJobKind = (typeof RUNTIME_DURABLE_JOB_KINDS)[number];

export const RUNTIME_EDIT_LIST_OPERATIONS = [
  "move",
  "trim",
  "split",
  "delete",
  "restore",
  "delete-range",
  "restore-snapshot",
] as const;

export type RuntimeEditListOperation = (typeof RUNTIME_EDIT_LIST_OPERATIONS)[number];

export const STUDIO_TOP_LEVEL_VIEWS = ["storyboard", "preview", "koubo"] as const;

export type StudioTopLevelView = (typeof STUDIO_TOP_LEVEL_VIEWS)[number];

export const RUNTIME_DOCTOR_CAPABILITIES = {
  runtimeApiVersion: 1,
  serviceApiVersion: 1,
  serviceOperations: RUNTIME_SERVICE_OPERATIONS,
  managedStudioService: true,
  serviceParentProcessIndependent: true,
  serviceCrashRestart: true,
  durableJobsApiVersion: 1,
  durableJobKinds: RUNTIME_DURABLE_JOB_KINDS,
  editListSchemaVersion: 1,
  editListOperations: RUNTIME_EDIT_LIST_OPERATIONS,
  managedArollProjection: true,
  expectedEditListRevision: true,
  projectIngestVersion: 1,
  transcriptPlaybackPagingVersion: 1,
  cloudTranscriptionProvider: "volcengine",
  cloudTranscriptionTaskLocalOnly: true,
} as const;

export type RuntimeDoctorCapabilities = typeof RUNTIME_DOCTOR_CAPABILITIES;

export const STUDIO_CAPABILITY_FEATURES = {
  topLevelViews: STUDIO_TOP_LEVEL_VIEWS,
  legacyWorkbenchPanel: false,
  managedTimelineEditing: true,
  projectIngestVersion: RUNTIME_DOCTOR_CAPABILITIES.projectIngestVersion,
  transcriptPlaybackPagingVersion: RUNTIME_DOCTOR_CAPABILITIES.transcriptPlaybackPagingVersion,
  durableJobsApiVersion: RUNTIME_DOCTOR_CAPABILITIES.durableJobsApiVersion,
  durableJobKinds: RUNTIME_DURABLE_JOB_KINDS,
  managedTimelineOperations: RUNTIME_EDIT_LIST_OPERATIONS,
} as const;

export type StudioCapabilityFeatures = typeof STUDIO_CAPABILITY_FEATURES;

export interface RuntimeStudioCapabilityManifest {
  schemaVersion: typeof RUNTIME_CONTRACT_SCHEMA_VERSION;
  product: "chengfeng-videocut";
  studioVersion: string;
  features: {
    topLevelViews: readonly StudioTopLevelView[];
    legacyWorkbenchPanel: false;
    managedTimelineEditing: true;
    projectIngestVersion: 1;
    transcriptPlaybackPagingVersion: 1;
    durableJobsApiVersion: 1;
    durableJobKinds: readonly RuntimeDurableJobKind[];
    managedTimelineOperations: readonly RuntimeEditListOperation[];
  };
}

export function createStudioCapabilityManifest(
  studioVersion: string,
): RuntimeStudioCapabilityManifest {
  return {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    product: "chengfeng-videocut",
    studioVersion,
    features: {
      topLevelViews: [...STUDIO_CAPABILITY_FEATURES.topLevelViews],
      legacyWorkbenchPanel: STUDIO_CAPABILITY_FEATURES.legacyWorkbenchPanel,
      managedTimelineEditing: STUDIO_CAPABILITY_FEATURES.managedTimelineEditing,
      projectIngestVersion: STUDIO_CAPABILITY_FEATURES.projectIngestVersion,
      transcriptPlaybackPagingVersion: STUDIO_CAPABILITY_FEATURES.transcriptPlaybackPagingVersion,
      durableJobsApiVersion: STUDIO_CAPABILITY_FEATURES.durableJobsApiVersion,
      durableJobKinds: [...STUDIO_CAPABILITY_FEATURES.durableJobKinds],
      managedTimelineOperations: [...STUDIO_CAPABILITY_FEATURES.managedTimelineOperations],
    },
  };
}

export function serializeRuntimeContractJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const RUNTIME_CLI_COMMAND_CONTRACT_SCHEMA_VERSION = 1 as const;

export type RuntimeCapabilityKey = keyof RuntimeDoctorCapabilities;

export type RuntimeCliCommandFeature =
  | { kind: "capability"; capability: RuntimeCapabilityKey }
  | { kind: "service"; operation: RuntimeServiceOperation }
  | { kind: "durable-job"; jobKind: RuntimeDurableJobKind };

export interface RuntimeCliCommandSpec {
  public: boolean;
  features: readonly RuntimeCliCommandFeature[];
}

export const RUNTIME_CLI_COMMANDS = {
  help: { public: true, features: [] },
  version: { public: true, features: [] },
  start: { public: true, features: [] },
  "service.install": {
    public: true,
    features: [{ kind: "service", operation: "install" }],
  },
  "service.start": {
    public: true,
    features: [{ kind: "service", operation: "start" }],
  },
  "service.stop": {
    public: true,
    features: [{ kind: "service", operation: "stop" }],
  },
  "service.restart": {
    public: true,
    features: [{ kind: "service", operation: "restart" }],
  },
  "service.status": {
    public: true,
    features: [{ kind: "service", operation: "status" }],
  },
  "service.logs": {
    public: true,
    features: [{ kind: "service", operation: "logs" }],
  },
  "service.ensure": {
    public: true,
    features: [{ kind: "service", operation: "ensure" }],
  },
  "service.supervise": { public: false, features: [] },
  doctor: { public: true, features: [] },
  "config.get": { public: true, features: [] },
  "config.set": { public: true, features: [] },
  inspect: { public: true, features: [] },
  open: { public: true, features: [] },
  transcribe: {
    public: true,
    features: [
      { kind: "capability", capability: "cloudTranscriptionProvider" },
      { kind: "capability", capability: "cloudTranscriptionTaskLocalOnly" },
    ],
  },
  "project.ingest": {
    public: true,
    features: [{ kind: "capability", capability: "projectIngestVersion" }],
  },
  "project.create": { public: true, features: [] },
  "project.prepare": { public: true, features: [] },
  "artifact.put": { public: true, features: [] },
  "cuts.get": { public: true, features: [] },
  "transcript.playback": {
    public: true,
    features: [{ kind: "capability", capability: "transcriptPlaybackPagingVersion" }],
  },
  "transcript.retranscribe": {
    public: true,
    features: [
      { kind: "capability", capability: "cloudTranscriptionProvider" },
      { kind: "capability", capability: "cloudTranscriptionTaskLocalOnly" },
    ],
  },
  "transcript.align": { public: true, features: [] },
  "transcript.dictionary": { public: true, features: [] },
  "transcript.regroup": { public: true, features: [] },
  "transcript.correct": { public: true, features: [] },
  "cuts.set": { public: true, features: [] },
  "cuts.apply": {
    public: true,
    features: [
      { kind: "capability", capability: "expectedEditListRevision" },
      { kind: "capability", capability: "editListSchemaVersion" },
    ],
  },
  "editList.get": {
    public: true,
    features: [{ kind: "capability", capability: "editListSchemaVersion" }],
  },
  "editList.patch": {
    public: true,
    features: [{ kind: "capability", capability: "editListSchemaVersion" }],
  },
  "subtitle.get": { public: true, features: [] },
  "subtitle.build": { public: true, features: [] },
  "subtitle.set": { public: true, features: [] },
  "visual.get": { public: true, features: [] },
  "visual.add": { public: true, features: [] },
  "visual.remove": { public: true, features: [] },
  "visual.frame": { public: true, features: [] },
  "workflow.get": { public: true, features: [] },
  "workflow.transition": { public: true, features: [] },
  "render.run": { public: true, features: [] },
  export: {
    public: true,
    features: [{ kind: "durable-job", jobKind: "export" }],
  },
  "job.start": {
    public: true,
    features: [
      { kind: "capability", capability: "durableJobsApiVersion" },
      { kind: "durable-job", jobKind: "export" },
    ],
  },
  "job.get": {
    public: true,
    features: [{ kind: "capability", capability: "durableJobsApiVersion" }],
  },
  "job.list": {
    public: true,
    features: [{ kind: "capability", capability: "durableJobsApiVersion" }],
  },
  "job.cancel": {
    public: true,
    features: [{ kind: "capability", capability: "durableJobsApiVersion" }],
  },
} as const satisfies Record<string, RuntimeCliCommandSpec>;

export const RUNTIME_CLI_COMMAND_CONTRACT = {
  schemaVersion: RUNTIME_CLI_COMMAND_CONTRACT_SCHEMA_VERSION,
  envelopeSchemaVersion: 1,
  commands: RUNTIME_CLI_COMMANDS,
} as const;

export interface RuntimePluginContractSnapshot {
  schemaVersion: typeof RUNTIME_CONTRACT_SCHEMA_VERSION;
  product: "chengfeng-videocut";
  runtimeVersion: string;
  minimumRuntimeVersion: string;
  capabilities: RuntimeDoctorCapabilities;
  studioCapabilities: {
    topLevelViews: readonly StudioTopLevelView[];
    legacyWorkbenchPanel: false;
    managedTimelineEditing: true;
    managedTimelineOperations: readonly RuntimeEditListOperation[];
  };
  cli: typeof RUNTIME_CLI_COMMAND_CONTRACT;
}

export function createRuntimePluginContractSnapshot(
  runtimeVersion: string,
): RuntimePluginContractSnapshot {
  return {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    product: "chengfeng-videocut",
    runtimeVersion,
    minimumRuntimeVersion: runtimeVersion,
    capabilities: RUNTIME_DOCTOR_CAPABILITIES,
    studioCapabilities: {
      topLevelViews: [...STUDIO_CAPABILITY_FEATURES.topLevelViews],
      legacyWorkbenchPanel: STUDIO_CAPABILITY_FEATURES.legacyWorkbenchPanel,
      managedTimelineEditing: STUDIO_CAPABILITY_FEATURES.managedTimelineEditing,
      managedTimelineOperations: [...STUDIO_CAPABILITY_FEATURES.managedTimelineOperations],
    },
    cli: RUNTIME_CLI_COMMAND_CONTRACT,
  };
}

export type RuntimeCliCommand = keyof typeof RUNTIME_CLI_COMMANDS;

export const RUNTIME_CLI_COMMAND_IDS = Object.keys(
  RUNTIME_CLI_COMMANDS,
) as RuntimeCliCommand[];

export function isRuntimeCliCommand(value: string): value is RuntimeCliCommand {
  return Object.hasOwn(RUNTIME_CLI_COMMANDS, value);
}

export function runtimeCliCommand(value: string): RuntimeCliCommand {
  if (!isRuntimeCliCommand(value)) {
    throw new TypeError(`Unknown Runtime CLI command contract entry: ${value}`);
  }
  return value;
}

export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "recovery_blocked";

export interface JobError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface JobOwner {
  pid: number;
  /** Runtime process that minted this worker attempt. */
  managerPid?: number;
  /** HMAC proof for the manager-only, non-persisted worker secret. */
  secretProof?: string;
  token: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface PublicJobOwner {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface DurableJob {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  jobId: string;
  kind: JobKind;
  targetKey: string;
  projectId?: string;
  target: string;
  params: Record<string, unknown>;
  frozen: Record<string, unknown>;
  state: JobState;
  phase: string;
  progress: { done: number; total: number } | null;
  attempt: number;
  owner: JobOwner | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  error: JobError | null;
}

export type PublicDurableJob = Omit<DurableJob, "owner"> & {
  owner: PublicJobOwner | null;
};

export interface StartJobRequest {
  kind: JobKind;
  target: string;
  params?: Record<string, unknown>;
}

export interface JobListResponse {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  jobs: PublicDurableJob[];
}

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

export interface EditListRestoreSnapshotOperation {
  type: "restore-snapshot";
  expectedSegments: EditListSegment[];
  beforeSegments: EditListSegment[];
  beforeMode: EditListMode;
  inverse: EditListDeleteRangeOperation;
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
  | EditListRestoreOperation;

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

/**
 * Natural-pause policy versions that Product has ever written into
 * `cut-selection.json` at `initialization.naturalPausePolicy`.
 *
 * This list is the single source of truth for two sides that must agree:
 * the writer (koubo-adapter's natural pause planner) and the reader
 * (core's semantic-overlay baseline gate). Before this existed the gate
 * compared against a hardcoded "natural-pause-v2" while the writer had
 * moved on to v3 and then v4, so every semantic-overlay write silently
 * discarded the entire pause baseline and the cut collapsed back to
 * roughly the unedited source.
 *
 * Adding a new policy version means adding it here. A version that is not
 * listed is treated as untrusted and its baseline is not merged.
 */
export const NATURAL_PAUSE_POLICY_VERSIONS = [
  "natural-pause-v2",
  "natural-pause-v3-direct-delete",
  "natural-pause-v4-delete-all-gaps",
] as const;

export type NaturalPausePolicyVersion = (typeof NATURAL_PAUSE_POLICY_VERSIONS)[number];

/** The version a fresh plan is written with. Writers must use this. */
export const CURRENT_NATURAL_PAUSE_POLICY_VERSION: NaturalPausePolicyVersion =
  "natural-pause-v4-delete-all-gaps";

/** True when a persisted policy string is one Product itself wrote. */
export function isKnownNaturalPausePolicyVersion(
  value: unknown,
): value is NaturalPausePolicyVersion {
  return typeof value === "string"
    && (NATURAL_PAUSE_POLICY_VERSIONS as readonly string[]).includes(value);
}
