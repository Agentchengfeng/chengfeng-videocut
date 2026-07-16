import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  cutVideoByRanges,
  probeMedia,
  readCutRanges,
  type MediaCutRange,
  type MediaCutResult,
  type MediaProbe,
} from "./mediaCut";
import {
  appendKouboEvent,
  atomicWriteJson,
  resolveKouboJobDirectory,
} from "./project";
import { serializeKouboProjectOperation } from "./projectLock";

type JsonObject = Record<string, unknown>;

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_CUT_RELATIVE = "剪口播/3_审核/source_cut.mp4";
const CUT_DONE_RELATIVE = "剪口播/3_审核/cut_done.json";
const FINAL_CONFIG_RELATIVE = "成片配置/config.json";

export type KouboWorkflowErrorCode =
  | "confirmation_required"
  | "invalid_argument"
  | "invalid_config"
  | "invalid_project"
  | "invalid_state"
  | "media_has_no_audio"
  | "missing_artifact"
  | "revision_conflict"
  | "revision_required"
  | "workflow_failed";

export class KouboWorkflowError extends Error {
  readonly code: KouboWorkflowErrorCode;
  readonly details?: JsonObject;

  constructor(code: KouboWorkflowErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "KouboWorkflowError";
    this.code = code;
    this.details = details;
  }
}

export interface KouboProjectDocument extends JsonObject {
  jobId?: string;
  status: string;
  updatedAt?: string;
  inputVideo?: string;
  failedAt?: unknown;
  recoverable?: unknown;
  error?: unknown;
  artifacts?: JsonObject;
  codexContinue?: JsonObject;
  config?: JsonObject;
}

export interface KouboWorkflowSnapshot {
  directory: string;
  projectPath: string;
  jobId: string;
  status: string;
  revision: string;
  project: KouboProjectDocument;
}

export interface KouboMediaCutterInput {
  input: string;
  output: string;
  ranges: readonly MediaCutRange[];
}

export interface KouboWorkflowDependencies {
  mediaCutter: (input: KouboMediaCutterInput) => Promise<MediaCutResult>;
  mediaProbe: (path: string) => Promise<MediaProbe>;
}

export interface ApplyKouboCutOptions {
  confirmed: boolean;
  expectedRevision?: string;
  /**
   * The canonical artifact always stays at 剪口播/3_审核/source_cut.mp4.
   * A root source_cut.mp4 symlink can be materialized for legacy subtitle tools.
   */
  rootSourceCut?: "none" | "symlink";
  now?: () => Date;
  /** Test/embedding seam; production callers should use the built-in FFmpeg implementation. */
  dependencies?: Partial<KouboWorkflowDependencies>;
}

export interface ApplyKouboCutResult extends KouboWorkflowSnapshot {
  previousRevision: string;
  inputPath: string;
  sourceCutPath: string;
  cutDonePath: string;
  cut: MediaCutResult;
  probe: MediaProbe;
}

export type KouboWorkflowAction =
  | "start-final"
  | "confirm-storyboard"
  | "confirm-animation"
  | "confirm-timeline"
  | "request-render";

export interface KouboFinalConfig {
  aspectRatio: "3:4" | "16:9" | "4:3";
  animationStyle: string;
  requirements: string;
}

export interface TransitionKouboWorkflowOptions {
  confirmed: boolean;
  expectedRevision: string;
  config?: Partial<KouboFinalConfig>;
  now?: () => Date;
}

export interface TransitionKouboWorkflowResult extends KouboWorkflowSnapshot {
  action: KouboWorkflowAction;
  previousRevision: string;
  checkedArtifacts: Record<string, string>;
}

interface ArtifactRequirement {
  key: string;
  label: string;
  fallbacks: readonly string[];
}

interface TransitionDefinition {
  allowedStates: readonly string[];
  event: string;
  stage: "storyboard" | "animation" | "timeline" | "render";
  reason: string;
  requiredArtifacts: readonly ArtifactRequirement[];
}

const SOURCE_CUT_ARTIFACT: ArtifactRequirement = {
  key: "sourceCut",
  label: "剪后视频",
  fallbacks: [SOURCE_CUT_RELATIVE, "source_cut.mp4"],
};

const SUBTITLES_ARTIFACT: ArtifactRequirement = {
  key: "subtitles",
  label: "剪后字幕",
  fallbacks: ["subtitles.srt", "字幕/subtitles.srt", "字幕/3_输出/video.srt"],
};

const STORYBOARD_ARTIFACT: ArtifactRequirement = {
  key: "visualPlan",
  label: "分镜方案",
  fallbacks: ["visual-plan.json"],
};

const ANIMATION_MANIFEST_ARTIFACT: ArtifactRequirement = {
  key: "animationManifest",
  label: "动画清单",
  fallbacks: ["动画/manifest.json"],
};

const TIMELINE_ARTIFACT: ArtifactRequirement = {
  key: "timeline",
  label: "成片时间线",
  fallbacks: ["timeline.json"],
};

const FINAL_PLAYER_ARTIFACT: ArtifactRequirement = {
  key: "finalPlayer",
  label: "成片播放器",
  fallbacks: ["final-player.html"],
};

const TRANSITIONS: Record<KouboWorkflowAction, TransitionDefinition> = {
  "start-final": {
    allowedStates: ["final_config_ready"],
    event: "final_config_confirmed",
    stage: "storyboard",
    reason: "成片配置已确认，需要 Codex 执行分镜小步。",
    requiredArtifacts: [SOURCE_CUT_ARTIFACT, SUBTITLES_ARTIFACT],
  },
  "confirm-storyboard": {
    allowedStates: ["storyboard_review_ready"],
    event: "storyboard_confirmed",
    stage: "animation",
    reason: "分镜已确认，需要 Codex 生成动画资产。",
    requiredArtifacts: [STORYBOARD_ARTIFACT],
  },
  "confirm-animation": {
    allowedStates: ["animation_review_ready"],
    event: "animation_confirmed",
    stage: "timeline",
    reason: "动画已确认，需要 Codex 生成时间线预览。",
    requiredArtifacts: [ANIMATION_MANIFEST_ARTIFACT],
  },
  "confirm-timeline": {
    allowedStates: ["timeline_review_ready"],
    event: "render_requested",
    stage: "render",
    reason: "时间线已确认，需要 Codex 导出最终成片。",
    requiredArtifacts: [TIMELINE_ARTIFACT, FINAL_PLAYER_ARTIFACT],
  },
  // Compatibility entry for automation/CLI callers. Product UI should call
  // confirm-timeline once and must not introduce a second confirmation click.
  "request-render": {
    allowedStates: ["timeline_review_ready", "render_requested"],
    event: "render_requested",
    stage: "render",
    reason: "已请求导出，需要 Codex 导出最终成片。",
    requiredArtifacts: [TIMELINE_ARTIFACT, FINAL_PLAYER_ARTIFACT],
  },
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new KouboWorkflowError(
      "confirmation_required",
      "This workflow action requires explicit user confirmation",
    );
  }
}

function assertExpectedRevision(expectedRevision: string | undefined, required: boolean): void {
  if (!expectedRevision) {
    if (required) {
      throw new KouboWorkflowError(
        "revision_required",
        "This workflow action requires expectedRevision",
      );
    }
    return;
  }
  if (!REVISION_PATTERN.test(expectedRevision)) {
    throw new KouboWorkflowError(
      "invalid_argument",
      "expectedRevision must be a lowercase SHA-256 revision",
      { expectedRevision },
    );
  }
}

function assertRevision(snapshot: KouboWorkflowSnapshot, expectedRevision?: string): void {
  if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) {
    throw new KouboWorkflowError(
      "revision_conflict",
      "project.json changed after it was inspected",
      { expectedRevision, currentRevision: snapshot.revision },
    );
  }
}

function assertInsideProject(jobDir: string, path: string): void {
  const value = relative(jobDir, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new KouboWorkflowError(
      "invalid_project",
      `Workflow artifacts must stay inside the job directory: ${path}`,
    );
  }
}

async function existingProjectPath(jobDir: string, value: string): Promise<string | null> {
  if (!value.trim()) return null;
  const candidate = isAbsolute(value) ? value : resolve(jobDir, value);
  assertInsideProject(jobDir, candidate);
  try {
    const resolved = await realpath(candidate);
    assertInsideProject(jobDir, resolved);
    const info = await lstat(resolved);
    return info.isFile() ? resolved : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function requireProjectFile(
  jobDir: string,
  candidates: readonly string[],
  label: string,
): Promise<string> {
  const uniqueCandidates = [...new Set(candidates.filter((value) => value.trim()))];
  for (const candidate of uniqueCandidates) {
    const path = await existingProjectPath(jobDir, candidate);
    if (path) return path;
  }
  throw new KouboWorkflowError(
    "missing_artifact",
    `${label} does not exist in this project`,
    { label, candidates: uniqueCandidates },
  );
}

function artifactCandidates(
  project: KouboProjectDocument,
  requirement: ArtifactRequirement,
): string[] {
  const artifacts = isObject(project.artifacts) ? project.artifacts : {};
  const configured = typeof artifacts[requirement.key] === "string"
    ? String(artifacts[requirement.key]).trim()
    : "";
  return [configured, ...requirement.fallbacks].filter(Boolean);
}

async function requireArtifact(
  jobDir: string,
  project: KouboProjectDocument,
  requirement: ArtifactRequirement,
): Promise<string> {
  return requireProjectFile(
    jobDir,
    artifactCandidates(project, requirement),
    requirement.label,
  );
}

async function readSnapshotFromDirectory(directory: string): Promise<KouboWorkflowSnapshot> {
  const projectPath = join(directory, "project.json");
  let raw: string;
  let payload: unknown;
  try {
    raw = await readFile(projectPath, "utf8");
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new KouboWorkflowError(
      "invalid_project",
      `Could not read project.json: ${errorMessage(error)}`,
      { projectPath },
    );
  }
  if (!isObject(payload) || typeof payload.status !== "string" || !payload.status.trim()) {
    throw new KouboWorkflowError(
      "invalid_project",
      "project.json must be an object with a non-empty status",
      { projectPath },
    );
  }
  const project = payload as KouboProjectDocument;
  const jobId = typeof project.jobId === "string" && project.jobId.trim()
    ? project.jobId
    : basename(directory);
  return {
    directory,
    projectPath,
    jobId,
    status: project.status,
    revision: sha256(raw),
    project,
  };
}

/** Reads the project status truth source together with its raw-file CAS revision. */
export async function readKouboWorkflow(jobDir: string): Promise<KouboWorkflowSnapshot> {
  let directory: string;
  try {
    directory = await resolveKouboJobDirectory(jobDir);
  } catch (error) {
    throw new KouboWorkflowError(
      "invalid_project",
      errorMessage(error),
      { jobDir: resolve(jobDir) },
    );
  }
  return readSnapshotFromDirectory(directory);
}

function nowIso(now: (() => Date) | undefined): { date: Date; iso: string } {
  const date = (now ?? (() => new Date()))();
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new KouboWorkflowError("invalid_argument", "now() must return a valid Date");
  }
  return { date, iso: date.toISOString() };
}

function clearFailure(project: KouboProjectDocument): KouboProjectDocument {
  return {
    ...project,
    failedAt: null,
    error: null,
    recoverable: null,
  };
}

function artifactsFor(project: KouboProjectDocument): JsonObject {
  return isObject(project.artifacts) ? { ...project.artifacts } : {};
}

function continueProject(
  project: KouboProjectDocument,
  jobId: string,
  stage: TransitionDefinition["stage"] | "subtitle_rebuild",
  reason: string,
  updatedAt: string,
): KouboProjectDocument {
  return {
    ...clearFailure(project),
    status: "codex_continue_required",
    updatedAt,
    codexContinue: {
      required: true,
      stage,
      prompt: `继续 ${jobId}`,
      reason,
    },
  };
}

async function writeStatusEvent(input: {
  directory: string;
  from: string;
  status: string;
  source: string;
  date: Date;
}): Promise<void> {
  await appendKouboEvent(input.directory, "status_changed", {
    from: input.from,
    status: input.status,
    source: input.source,
  }, input.date);
}

async function resolveCutInput(
  directory: string,
  project: KouboProjectDocument,
): Promise<string> {
  const configured = typeof project.inputVideo === "string" ? project.inputVideo : "";
  return requireProjectFile(
    directory,
    [configured, "input/source.mp4"].filter(Boolean),
    "口播源视频",
  );
}

async function resolveCutSelection(
  directory: string,
  project: KouboProjectDocument,
): Promise<string> {
  const artifacts = isObject(project.artifacts) ? project.artifacts : {};
  const configured = typeof artifacts.workbenchCutSelection === "string"
    ? artifacts.workbenchCutSelection
    : "";
  return requireProjectFile(
    directory,
    [configured, "cut-selection.json", "剪口播/3_审核/cut-selection.json"].filter(Boolean),
    "删词选择",
  );
}

function assertCutRanges(ranges: readonly MediaCutRange[]): void {
  ranges.forEach((range, index) => {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
      throw new KouboWorkflowError(
        "invalid_argument",
        `cut-selection.json contains an invalid range at index ${index}`,
        { index, start: range.start, end: range.end },
      );
    }
  });
}

async function ensureRootSourceCutSymlink(directory: string, target: string): Promise<void> {
  const linkPath = join(directory, "source_cut.mp4");
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(linkPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new KouboWorkflowError(
      "invalid_project",
      "Cannot create the optional source_cut.mp4 symlink over a regular project file",
      { linkPath },
    );
  }
  const temporary = join(directory, `.source_cut.${process.pid}.${randomUUID()}.tmp`);
  try {
    await symlink(relative(directory, target), temporary);
    await rename(temporary, linkPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function asWorkflowFailure(error: unknown): KouboWorkflowError {
  if (error instanceof KouboWorkflowError) return error;
  return new KouboWorkflowError("workflow_failed", errorMessage(error));
}

async function markCutFailure(input: {
  directory: string;
  projectPath: string;
  project: KouboProjectDocument;
  error: unknown;
  now?: () => Date;
}): Promise<void> {
  const timestamp = nowIso(input.now);
  const failure = asWorkflowFailure(input.error);
  const failedProject: KouboProjectDocument = {
    ...input.project,
    status: "failed",
    updatedAt: timestamp.iso,
    failedAt: "cutting",
    error: failure.message,
    recoverable: true,
    codexContinue: {
      required: false,
      stage: "",
      prompt: "",
      reason: "",
    },
  };
  await atomicWriteJson(input.projectPath, failedProject);
  await appendKouboEvent(input.directory, "failed", {
    failedAt: "cutting",
    error: failure.message,
    errorCode: failure.code,
    recoverable: true,
  }, timestamp.date);
}

/**
 * Applies a confirmed cut selection through the product-owned media cutter.
 * Precondition checks are read-only; once cutting is written, every failure is
 * persisted as a recoverable `failed` state at `failedAt=cutting`.
 */
export async function applyKouboCut(
  jobDir: string,
  options: ApplyKouboCutOptions,
): Promise<ApplyKouboCutResult> {
  assertConfirmed(options.confirmed);
  assertExpectedRevision(options.expectedRevision, false);
  const directory = (await readKouboWorkflow(jobDir)).directory;
  return serializeKouboProjectOperation(directory, async () => {
    const snapshot = await readSnapshotFromDirectory(directory);
    assertRevision(snapshot, options.expectedRevision);
    const canStart = snapshot.status === "cut_review_ready" || (
      snapshot.status === "failed" && snapshot.project.failedAt === "cutting"
    );
    if (!canStart) {
      throw new KouboWorkflowError(
        "invalid_state",
        "Cutting can start only from cut_review_ready or a cutting failure",
        { status: snapshot.status, failedAt: snapshot.project.failedAt ?? null },
      );
    }

    const inputPath = await resolveCutInput(directory, snapshot.project);
    const selectionPath = await resolveCutSelection(directory, snapshot.project);
    const ranges = await readCutRanges(selectionPath);
    assertCutRanges(ranges);

    const sourceCutPath = join(directory, SOURCE_CUT_RELATIVE);
    const cutDonePath = join(directory, CUT_DONE_RELATIVE);
    const started = nowIso(options.now);
    const cuttingProject: KouboProjectDocument = {
      ...clearFailure(snapshot.project),
      status: "cutting",
      updatedAt: started.iso,
      codexContinue: {
        required: false,
        stage: "",
        prompt: "",
        reason: "",
      },
    };
    await atomicWriteJson(snapshot.projectPath, cuttingProject);
    const dependencies: KouboWorkflowDependencies = {
      mediaCutter: options.dependencies?.mediaCutter ?? cutVideoByRanges,
      mediaProbe: options.dependencies?.mediaProbe ?? probeMedia,
    };
    try {
      await writeStatusEvent({
        directory,
        from: snapshot.status,
        status: "cutting",
        source: "chengfeng-videocut",
        date: started.date,
      });
      await mkdir(dirname(sourceCutPath), { recursive: true });
      await rm(cutDonePath, { force: true });
      const cut = await dependencies.mediaCutter({
        input: inputPath,
        output: sourceCutPath,
        ranges,
      });
      const outputProbe = await dependencies.mediaProbe(sourceCutPath);
      if (!outputProbe.hasVideo || !(outputProbe.duration > 0)) {
        throw new KouboWorkflowError(
          "workflow_failed",
          "The cut output is not a readable video",
          { sourceCutPath },
        );
      }
      if (!outputProbe.hasAudio) {
        throw new KouboWorkflowError(
          "media_has_no_audio",
          "The cut output has no audio stream",
          { sourceCutPath },
        );
      }
      if ((options.rootSourceCut ?? "none") === "symlink") {
        await ensureRootSourceCutSymlink(directory, sourceCutPath);
      }

      const completed = nowIso(options.now);
      await atomicWriteJson(cutDonePath, {
        schemaVersion: 1,
        success: true,
        source: "chengfeng-videocut",
        input: inputPath,
        output: sourceCutPath,
        outputRelative: SOURCE_CUT_RELATIVE,
        originalDuration: cut.originalDuration,
        newDuration: outputProbe.duration,
        deletedDuration: cut.deletedDuration,
        savedPercent: cut.savedPercent,
        cutRanges: cut.cutRanges,
        keepSegments: cut.keepSegments,
        hasAudio: true,
        width: outputProbe.width,
        height: outputProbe.height,
        completedAt: completed.iso,
        nextStep: "subtitle_rebuild",
      });

      const artifacts = artifactsFor(cuttingProject);
      Object.assign(artifacts, {
        sourceCut: SOURCE_CUT_RELATIVE,
        cutDone: CUT_DONE_RELATIVE,
      });
      const finalProject = continueProject(
        { ...cuttingProject, artifacts },
        snapshot.jobId,
        "subtitle_rebuild",
        "剪辑完成，需要 Codex 基于剪后视频重新转写并校对字幕。",
        completed.iso,
      );
      await atomicWriteJson(snapshot.projectPath, finalProject);
      await appendKouboEvent(directory, "cut_done", {
        sourceCut: SOURCE_CUT_RELATIVE,
        cutDone: CUT_DONE_RELATIVE,
        hasAudio: true,
        cutRangeCount: cut.cutRanges.length,
      }, completed.date);
      await writeStatusEvent({
        directory,
        from: "cutting",
        status: "codex_continue_required",
        source: "chengfeng-videocut",
        date: completed.date,
      });
      await appendKouboEvent(directory, "codex_continue_required", {
        stage: "subtitle_rebuild",
        prompt: `继续 ${snapshot.jobId}`,
        reason: "剪辑完成，需要 Codex 基于剪后视频重新转写并校对字幕。",
      }, completed.date);
      const finalSnapshot = await readSnapshotFromDirectory(directory);
      return {
        ...finalSnapshot,
        previousRevision: snapshot.revision,
        inputPath,
        sourceCutPath,
        cutDonePath,
        cut,
        probe: outputProbe,
      };
    } catch (error) {
      try {
        await markCutFailure({
          directory,
          projectPath: snapshot.projectPath,
          project: cuttingProject,
          error,
          now: options.now,
        });
      } catch (markError) {
        throw new KouboWorkflowError(
          "workflow_failed",
          `${errorMessage(error)}; additionally failed to persist recovery state: ${errorMessage(markError)}`,
        );
      }
      throw asWorkflowFailure(error);
    }
  });
}

function normalizeFinalConfig(value: unknown): KouboFinalConfig {
  if (!isObject(value)) {
    throw new KouboWorkflowError(
      "invalid_config",
      "start-final requires a final-video config",
    );
  }
  const aspectRatio = String(value.aspectRatio ?? "").trim();
  const animationStyle = String(value.animationStyle ?? "").trim();
  if (aspectRatio !== "3:4" && aspectRatio !== "16:9" && aspectRatio !== "4:3") {
    throw new KouboWorkflowError(
      "invalid_config",
      "aspectRatio must be one of 3:4, 16:9, or 4:3",
      { aspectRatio },
    );
  }
  if (!animationStyle) {
    throw new KouboWorkflowError(
      "invalid_config",
      "animationStyle must be a non-empty string",
    );
  }
  return {
    aspectRatio,
    animationStyle,
    requirements: typeof value.requirements === "string" ? value.requirements : "",
  };
}

async function finalConfigForTransition(
  directory: string,
  project: KouboProjectDocument,
  provided: TransitionKouboWorkflowOptions["config"],
): Promise<KouboFinalConfig> {
  if (provided) return normalizeFinalConfig(provided);
  if (isObject(project.config)) {
    try {
      return normalizeFinalConfig(project.config);
    } catch {
      // Fall through to a previously written task-local config file.
    }
  }
  const configPath = await existingProjectPath(directory, FINAL_CONFIG_RELATIVE);
  if (configPath) {
    try {
      return normalizeFinalConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error instanceof KouboWorkflowError) throw error;
      throw new KouboWorkflowError(
        "invalid_config",
        `Could not read final-video config: ${errorMessage(error)}`,
      );
    }
  }
  throw new KouboWorkflowError(
    "invalid_config",
    "start-final requires config or 成片配置/config.json",
  );
}

/**
 * Advances only the deterministic user-confirmation edges in the Koubo state
 * machine. Every action is confirmation-gated, revision-CAS protected, and
 * artifact-checked before the first write.
 */
export async function transitionKouboWorkflow(
  jobDir: string,
  action: KouboWorkflowAction,
  options: TransitionKouboWorkflowOptions,
): Promise<TransitionKouboWorkflowResult> {
  assertConfirmed(options.confirmed);
  assertExpectedRevision(options.expectedRevision, true);
  const definition = TRANSITIONS[action];
  if (!definition) {
    throw new KouboWorkflowError(
      "invalid_argument",
      `Unsupported Koubo workflow action: ${String(action)}`,
    );
  }
  const directory = (await readKouboWorkflow(jobDir)).directory;
  return serializeKouboProjectOperation(directory, async () => {
    const snapshot = await readSnapshotFromDirectory(directory);
    assertRevision(snapshot, options.expectedRevision);
    if (!definition.allowedStates.includes(snapshot.status)) {
      throw new KouboWorkflowError(
        "invalid_state",
        `${action} cannot run from ${snapshot.status}`,
        { action, status: snapshot.status, allowedStates: [...definition.allowedStates] },
      );
    }

    const checkedArtifacts: Record<string, string> = {};
    for (const requirement of definition.requiredArtifacts) {
      checkedArtifacts[requirement.key] = await requireArtifact(
        directory,
        snapshot.project,
        requirement,
      );
    }
    const finalConfig = action === "start-final"
      ? await finalConfigForTransition(directory, snapshot.project, options.config)
      : null;

    const timestamp = nowIso(options.now);
    let transitionBase = snapshot.project;
    if (finalConfig) {
      await atomicWriteJson(join(directory, FINAL_CONFIG_RELATIVE), finalConfig);
      checkedArtifacts.finalConfig = join(directory, FINAL_CONFIG_RELATIVE);
      const artifacts = artifactsFor(snapshot.project);
      artifacts.finalConfig = FINAL_CONFIG_RELATIVE;
      transitionBase = { ...snapshot.project, artifacts, config: { ...finalConfig } };
    }
    const nextProject = continueProject(
      transitionBase,
      snapshot.jobId,
      definition.stage,
      definition.reason,
      timestamp.iso,
    );
    await atomicWriteJson(snapshot.projectPath, nextProject);
    await appendKouboEvent(directory, definition.event, {
      action,
      ...(finalConfig ? finalConfig : {}),
      checkedArtifacts,
    }, timestamp.date);
    await writeStatusEvent({
      directory,
      from: snapshot.status,
      status: "codex_continue_required",
      source: "chengfeng-videocut",
      date: timestamp.date,
    });
    await appendKouboEvent(directory, "codex_continue_required", {
      stage: definition.stage,
      prompt: `继续 ${snapshot.jobId}`,
      reason: definition.reason,
      action,
    }, timestamp.date);
    const nextSnapshot = await readSnapshotFromDirectory(directory);
    return {
      ...nextSnapshot,
      action,
      previousRevision: snapshot.revision,
      checkedArtifacts,
    };
  });
}
