import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  cutVideoBySegments,
  probeMedia,
  readCutRanges,
  type MediaCutRange,
  type MediaCutResult,
  type MediaProbe,
} from "./mediaCut";
import {
  parseEditListDocument,
  type EditListMode,
} from "@video-workbench/core";
import {
  appendKouboEvent,
  atomicWriteJson,
  resolveKouboJobDirectory,
} from "./project";
import { serializeKouboProjectOperation } from "./projectLock";
import { readKouboCutArtifactStatus } from "./cutArtifactState";

type JsonObject = Record<string, unknown>;

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_CUT_RELATIVE = "剪口播/3_审核/source_cut.mp4";
const CUT_DONE_RELATIVE = "剪口播/3_审核/cut_done.json";
const FINAL_CONFIG_RELATIVE = "成片配置/config.json";
const CUT_DURATION_TOLERANCE_SECONDS = 0.15;

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
  source?: JsonObject;
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
  /** Ordered EDL source ranges. When present, order is authored and must be preserved. */
  segments?: readonly MediaCutRange[];
}

export type KouboArtifactPromotionStage =
  | "candidate_media_verified"
  | "candidate_pair_ready"
  | "source_cut_promoted"
  | "cut_done_promoted"
  | "root_source_cut_promoted"
  | "before_final_project_commit"
  | "before_success_events";

export interface KouboWorkflowDependencies {
  mediaCutter: (input: KouboMediaCutterInput) => Promise<MediaCutResult>;
  mediaProbe: (path: string) => Promise<MediaProbe>;
  /** Failure-injection/embedding seam around the current-artifact promotion. */
  artifactPromotionHook?: (stage: KouboArtifactPromotionStage) => Promise<void>;
}

export interface ApplyKouboCutOptions {
  confirmed: boolean;
  expectedRevision?: string;
  /** Exact 64-hex EDL revision shown at confirmation time. */
  expectedEditListRevision?: string;
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
  aspectRatio: string;
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
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

function assertExpectedEditListRevision(
  expectedRevision: string | undefined,
): asserts expectedRevision is string {
  if (expectedRevision === undefined) {
    throw new KouboWorkflowError(
      "revision_required",
      "Cut confirmation requires expectedEditListRevision",
      { reason: "missing_confirmed_edit_list_revision" },
    );
  }
  if (expectedRevision === "none") {
    throw new KouboWorkflowError(
      "revision_required",
      "Cutting requires a prepared edit-list.json revision",
      { reason: "edit_list_required" },
    );
  }
  if (!REVISION_PATTERN.test(expectedRevision)) {
    throw new KouboWorkflowError(
      "invalid_argument",
      "expectedEditListRevision must be a lowercase SHA-256 revision",
      { expectedEditListRevision: expectedRevision },
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

async function currentEditListRevision(directory: string): Promise<string | null> {
  try {
    return sha256(await readFile(join(directory, "edit-list.json"), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
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

async function appendKouboEventBlock(
  directory: string,
  events: ReadonlyArray<{ type: string; payload: JsonObject }>,
  date: Date,
): Promise<void> {
  const content = events.map((event) => JSON.stringify({
    ts: date.toISOString(),
    type: event.type,
    payload: event.payload,
  })).join("\n");
  if (!content) return;
  await appendFile(join(directory, "events.jsonl"), `${content}\n`, "utf8");
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

interface CanonicalSourceLineage {
  path: string;
  sha256: string;
}

async function requireCanonicalSourceLineage(
  directory: string,
  project: KouboProjectDocument,
  inputPath: string,
): Promise<CanonicalSourceLineage> {
  const source = isObject(project.source) ? project.source : {};
  const sourcePath = typeof source.path === "string" ? source.path.trim() : "";
  const expectedSha256 = typeof source.sha256 === "string" ? source.sha256.trim() : "";
  if (!sourcePath || !REVISION_PATTERN.test(expectedSha256) || source.immutable !== true) {
    throw new KouboWorkflowError(
      "invalid_project",
      "Physical cutting requires project prepare to pin an immutable canonical source",
      { reason: "missing_source_lineage" },
    );
  }
  const actualSourcePath = relative(directory, inputPath).split(sep).join("/");
  if (actualSourcePath !== sourcePath) {
    throw new KouboWorkflowError(
      "invalid_project",
      "The cut input does not match project.source.path",
      {
        reason: "source_path_mismatch",
        expectedSourcePath: sourcePath,
        actualSourcePath,
      },
    );
  }
  const actualSha256 = await sha256File(inputPath);
  if (actualSha256 !== expectedSha256) {
    throw new KouboWorkflowError(
      "revision_conflict",
      "The immutable source changed after project prepare",
      {
        reason: "source_changed_after_prepare",
        sourcePath,
        expectedSourceSha256: expectedSha256,
        actualSourceSha256: actualSha256,
      },
    );
  }
  return { path: sourcePath, sha256: actualSha256 };
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

interface EditListCutPlan {
  revision: string;
  mode: EditListMode;
  segments: MediaCutRange[];
}

async function resolveEditListCutPlan(input: {
  directory: string;
  jobId: string;
  inputPath: string;
  selectionPath: string;
}): Promise<EditListCutPlan> {
  const editListPath = join(input.directory, "edit-list.json");
  let editListRaw: string;
  try {
    editListRaw = await readFile(editListPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new KouboWorkflowError(
        "revision_required",
        "Cutting requires project prepare to create edit-list.json",
        { reason: "edit_list_required", editListPath },
      );
    }
    throw error;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(editListRaw) as unknown;
  } catch {
    throw new KouboWorkflowError(
      "invalid_project",
      "edit-list.json is not valid JSON",
      { editListPath },
    );
  }
  if (isObject(payload) && Array.isArray(payload.segments)) {
    for (const [index, candidate] of payload.segments.entries()) {
      if (
        isObject(candidate) &&
        typeof candidate.playbackRate === "number" &&
        candidate.playbackRate !== 1
      ) {
        throw new KouboWorkflowError(
          "invalid_state",
          "Physical export does not support EDL playback-rate changes",
          {
            reason: "unsupported_playback_rate",
            segmentId: typeof candidate.id === "string" ? candidate.id : `segments[${index}]`,
            playbackRate: candidate.playbackRate,
          },
        );
      }
    }
  }
  const editList = parseEditListDocument(payload);
  if (editList.projectId !== input.jobId) {
    throw new KouboWorkflowError(
      "invalid_project",
      "edit-list.json belongs to another project",
      { editListProjectId: editList.projectId, projectId: input.jobId },
    );
  }
  const [selectionRaw, transcriptPath] = await Promise.all([
    readFile(input.selectionPath, "utf8"),
    requireProjectFile(input.directory, ["transcript.json"], "工作台逐词稿"),
  ]);
  const transcriptRaw = await readFile(transcriptPath, "utf8");
  const cutsRevision = sha256(selectionRaw);
  const transcriptRevision = sha256(transcriptRaw);
  if (
    editList.baseCutsRevision !== cutsRevision ||
    editList.baseTranscriptRevision !== transcriptRevision
  ) {
    throw new KouboWorkflowError(
      "revision_conflict",
      "edit-list.json is not based on the current Cuts/transcript",
      {
        reason: "stale_edit_list",
        editListRevision: sha256(editListRaw),
        expectedCutsRevision: cutsRevision,
        actualCutsRevision: editList.baseCutsRevision,
        expectedTranscriptRevision: transcriptRevision,
        actualTranscriptRevision: editList.baseTranscriptRevision,
      },
    );
  }

  const segments: MediaCutRange[] = [];
  for (const segment of editList.segments) {
    if (Math.abs(segment.playbackRate - 1) > 0.001) {
      throw new KouboWorkflowError(
        "invalid_state",
        "Physical export does not support EDL playback-rate changes yet",
        {
          reason: "unsupported_playback_rate",
          segmentId: segment.id,
          playbackRate: segment.playbackRate,
        },
      );
    }
    const sourcePath = await existingProjectPath(input.directory, segment.source);
    if (!sourcePath || sourcePath !== input.inputPath) {
      throw new KouboWorkflowError(
        "invalid_project",
        "Every A-roll EDL segment must use the current source video",
        { segmentId: segment.id, source: segment.source },
      );
    }
    segments.push({ start: segment.sourceStart, end: segment.sourceEnd });
  }
  return {
    revision: sha256(editListRaw),
    mode: editList.mode,
    segments,
  };
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

interface ArtifactPairPromotion {
  rollback: () => Promise<void>;
  finalize: () => Promise<void>;
}

async function removeTransactionDirectory(transactionDirectory: string): Promise<void> {
  await rm(transactionDirectory, { recursive: true, force: true });
  // Do not remove another operation's transaction. The shared parent is removed
  // only when it is empty.
  await rmdir(dirname(transactionDirectory)).catch((error) => {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
  });
}

/**
 * Promotes a validated media/provenance pair while retaining the previous pair
 * until the rest of the workflow has committed. Every caught exception can be
 * rolled back to the exact previous paths. This deliberately does not claim
 * power-loss atomicity: two filesystem names require two renames, so durable
 * crash recovery still needs a journal/current-pointer protocol.
 */
async function promoteArtifactPair(input: {
  sourceCandidate: string;
  cutDoneCandidate: string;
  sourceCurrent: string;
  cutDoneCurrent: string;
  transactionDirectory: string;
  rootSourceCut?: {
    linkPath: string;
    targetPath: string;
  };
  hook?: KouboWorkflowDependencies["artifactPromotionHook"];
}): Promise<ArtifactPairPromotion> {
  const previousDirectory = join(input.transactionDirectory, "previous");
  const sourcePrevious = join(previousDirectory, "source_cut.mp4");
  const cutDonePrevious = join(previousDirectory, "cut_done.json");
  const rootSourceCutPrevious = join(previousDirectory, "root_source_cut.mp4");
  const rootSourceCutCandidate = join(input.transactionDirectory, "candidate", "root_source_cut.mp4");
  await mkdir(previousDirectory, { recursive: true });

  if (input.rootSourceCut) {
    let existing: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      existing = await lstat(input.rootSourceCut.linkPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (existing && !existing.isSymbolicLink()) {
      throw new KouboWorkflowError(
        "invalid_project",
        "Cannot create the optional source_cut.mp4 symlink over a regular project file",
        { linkPath: input.rootSourceCut.linkPath },
      );
    }
    await symlink(
      relative(dirname(input.rootSourceCut.linkPath), input.rootSourceCut.targetPath),
      rootSourceCutCandidate,
    );
  }

  let sourceBackedUp = false;
  let cutDoneBackedUp = false;
  let rootSourceCutBackedUp = false;
  let sourcePromoted = false;
  let cutDonePromoted = false;
  let rootSourceCutPromoted = false;
  let settled = false;

  const rollback = async (): Promise<void> => {
    if (settled) return;
    const failures: string[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(errorMessage(error));
      }
    };
    if (rootSourceCutPromoted && input.rootSourceCut) {
      await attempt(() => rm(input.rootSourceCut!.linkPath, { force: true }));
      rootSourceCutPromoted = false;
    }
    if (cutDonePromoted) {
      await attempt(() => rm(input.cutDoneCurrent, { force: true }));
      cutDonePromoted = false;
    }
    if (sourcePromoted) {
      await attempt(() => rm(input.sourceCurrent, { force: true }));
      sourcePromoted = false;
    }
    if (sourceBackedUp) {
      await attempt(() => rename(sourcePrevious, input.sourceCurrent));
      sourceBackedUp = false;
    }
    if (cutDoneBackedUp) {
      await attempt(() => rename(cutDonePrevious, input.cutDoneCurrent));
      cutDoneBackedUp = false;
    }
    if (rootSourceCutBackedUp && input.rootSourceCut) {
      await attempt(() => rename(rootSourceCutPrevious, input.rootSourceCut!.linkPath));
      rootSourceCutBackedUp = false;
    }
    if (failures.length > 0) {
      throw new Error(`Artifact pair rollback failed: ${failures.join("; ")}`);
    }
    settled = true;
  };

  try {
    if (await pathExists(input.sourceCurrent)) {
      await rename(input.sourceCurrent, sourcePrevious);
      sourceBackedUp = true;
    }
    if (await pathExists(input.cutDoneCurrent)) {
      await rename(input.cutDoneCurrent, cutDonePrevious);
      cutDoneBackedUp = true;
    }
    if (input.rootSourceCut && await pathExists(input.rootSourceCut.linkPath)) {
      await rename(input.rootSourceCut.linkPath, rootSourceCutPrevious);
      rootSourceCutBackedUp = true;
    }
    await rename(input.sourceCandidate, input.sourceCurrent);
    sourcePromoted = true;
    await input.hook?.("source_cut_promoted");
    await rename(input.cutDoneCandidate, input.cutDoneCurrent);
    cutDonePromoted = true;
    await input.hook?.("cut_done_promoted");
    if (input.rootSourceCut) {
      await rename(rootSourceCutCandidate, input.rootSourceCut.linkPath);
      rootSourceCutPromoted = true;
      await input.hook?.("root_source_cut_promoted");
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new KouboWorkflowError(
        "workflow_failed",
        `${errorMessage(error)}; additionally failed to restore the previous artifact pair: ${errorMessage(rollbackError)}`,
        {
          reason: "artifact_pair_rollback_failed",
          transactionDirectory: input.transactionDirectory,
        },
      );
    }
    throw error;
  }

  return {
    rollback,
    finalize: async () => {
      settled = true;
      await removeTransactionDirectory(input.transactionDirectory);
    },
  };
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
  const confirmedEditListRevision = options.expectedEditListRevision;
  assertExpectedEditListRevision(confirmedEditListRevision);
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
    const sourceLineage = await requireCanonicalSourceLineage(
      directory,
      snapshot.project,
      inputPath,
    );
    const selectionPath = await resolveCutSelection(directory, snapshot.project);
    const ranges = await readCutRanges(selectionPath);
    assertCutRanges(ranges);
    const editListPlan = await resolveEditListCutPlan({
      directory,
      jobId: snapshot.jobId,
      inputPath,
      selectionPath,
    });
    const currentEditListRevision = editListPlan.revision;
    if (confirmedEditListRevision !== currentEditListRevision) {
      throw new KouboWorkflowError(
        "revision_conflict",
        "edit-list.json changed after the cut was confirmed",
        {
          reason: "edit_list_changed_after_confirmation",
          expectedEditListRevision: confirmedEditListRevision,
          currentEditListRevision,
        },
      );
    }
    const expectedOutputDuration = editListPlan.segments.reduce(
      (total, segment) => total + segment.end - segment.start,
      0,
    );

    const sourceCutPath = join(directory, SOURCE_CUT_RELATIVE);
    const cutDonePath = join(directory, CUT_DONE_RELATIVE);
    const transactionDirectory = join(
      dirname(sourceCutPath),
      ".cut-transactions",
      `${confirmedEditListRevision}-${randomUUID()}`,
    );
    const candidateDirectory = join(transactionDirectory, "candidate");
    const candidateSourceCutPath = join(candidateDirectory, "source_cut.mp4");
    const candidateCutDonePath = join(candidateDirectory, "cut_done.json");
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
      mediaCutter: options.dependencies?.mediaCutter ?? (async (cutInput) =>
        cutVideoBySegments({
          input: cutInput.input,
          output: cutInput.output,
          segments: cutInput.segments ?? [],
          cutRanges: cutInput.ranges,
        })),
      mediaProbe: options.dependencies?.mediaProbe ?? probeMedia,
      artifactPromotionHook: options.dependencies?.artifactPromotionHook,
    };
    let promotion: ArtifactPairPromotion | null = null;
    try {
      await writeStatusEvent({
        directory,
        from: snapshot.status,
        status: "cutting",
        source: "chengfeng-videocut",
        date: started.date,
      });
      await mkdir(candidateDirectory, { recursive: true });
      const candidateCut = await dependencies.mediaCutter({
        input: inputPath,
        output: candidateSourceCutPath,
        ranges,
        segments: editListPlan.segments,
      });
      const outputProbe = await dependencies.mediaProbe(candidateSourceCutPath);
      if (!outputProbe.hasVideo || !(outputProbe.duration > 0)) {
        throw new KouboWorkflowError(
          "workflow_failed",
          "The cut output is not a readable video",
          { candidateSourceCutPath },
        );
      }
      if (!outputProbe.hasAudio) {
        throw new KouboWorkflowError(
          "media_has_no_audio",
          "The cut output has no audio stream",
          { candidateSourceCutPath },
        );
      }
      const durationDeltaSeconds = Math.abs(outputProbe.duration - expectedOutputDuration);
      if (durationDeltaSeconds > CUT_DURATION_TOLERANCE_SECONDS) {
        throw new KouboWorkflowError(
          "workflow_failed",
          "The cut output duration does not match the confirmed EDL",
          {
            reason: "cut_duration_mismatch",
            expectedDuration: expectedOutputDuration,
            actualDuration: outputProbe.duration,
            deltaSeconds: durationDeltaSeconds,
            toleranceSeconds: CUT_DURATION_TOLERANCE_SECONDS,
          },
        );
      }
      const sourceSha256AfterCut = await sha256File(inputPath);
      if (sourceSha256AfterCut !== sourceLineage.sha256) {
        throw new KouboWorkflowError(
          "revision_conflict",
          "The immutable source changed while the physical cut was running",
          {
            reason: "source_changed_during_cut",
            sourcePath: sourceLineage.path,
            expectedSourceSha256: sourceLineage.sha256,
            actualSourceSha256: sourceSha256AfterCut,
          },
        );
      }
      const outputSha256 = await sha256File(candidateSourceCutPath);
      await dependencies.artifactPromotionHook?.("candidate_media_verified");

      const completed = nowIso(options.now);
      const cut: MediaCutResult = {
        ...candidateCut,
        output: sourceCutPath,
      };
      await atomicWriteJson(candidateCutDonePath, {
        schemaVersion: 1,
        success: true,
        source: "chengfeng-videocut",
        artifactRevision: confirmedEditListRevision,
        confirmedEditListRevision,
        input: inputPath,
        sourcePath: sourceLineage.path,
        sourceSha256: sourceLineage.sha256,
        output: sourceCutPath,
        outputRelative: SOURCE_CUT_RELATIVE,
        outputSha256,
        originalDuration: cut.originalDuration,
        newDuration: outputProbe.duration,
        deletedDuration: cut.deletedDuration,
        savedPercent: cut.savedPercent,
        cutRanges: ranges,
        keepSegments: editListPlan.segments,
        editListRevision: editListPlan.revision,
        editListMode: editListPlan.mode,
        expectedDuration: expectedOutputDuration,
        durationDeltaSeconds,
        durationToleranceSeconds: CUT_DURATION_TOLERANCE_SECONDS,
        hasAudio: true,
        width: outputProbe.width,
        height: outputProbe.height,
        completedAt: completed.iso,
        nextStep: "subtitle_rebuild",
      });
      await dependencies.artifactPromotionHook?.("candidate_pair_ready");
      promotion = await promoteArtifactPair({
        sourceCandidate: candidateSourceCutPath,
        cutDoneCandidate: candidateCutDonePath,
        sourceCurrent: sourceCutPath,
        cutDoneCurrent: cutDonePath,
        transactionDirectory,
        rootSourceCut: (options.rootSourceCut ?? "none") === "symlink"
          ? {
              linkPath: join(directory, "source_cut.mp4"),
              targetPath: sourceCutPath,
            }
          : undefined,
        hook: dependencies.artifactPromotionHook,
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
      await dependencies.artifactPromotionHook?.("before_final_project_commit");
      await atomicWriteJson(snapshot.projectPath, finalProject);
      const finalSnapshot = await readSnapshotFromDirectory(directory);
      await promotion.finalize().catch(() => undefined);
      promotion = null;
      // These entries are notifications, not the workflow truth source. Once the
      // validated pair and project.json are committed, an event-log failure must
      // not roll them back and thereby turn an already-written success event into
      // a false claim. A single append keeps the success notification contiguous;
      // any failure is best-effort and the current pair remains authoritative.
      await (async () => {
        await dependencies.artifactPromotionHook?.("before_success_events");
        await appendKouboEventBlock(directory, [
          {
            type: "cut_done",
            payload: {
              sourceCut: SOURCE_CUT_RELATIVE,
              cutDone: CUT_DONE_RELATIVE,
              hasAudio: true,
              cutRangeCount: ranges.length,
              editListRevision: editListPlan.revision,
              sourceSha256: sourceLineage.sha256,
              outputSha256,
            },
          },
          {
            type: "status_changed",
            payload: {
              from: "cutting",
              status: "codex_continue_required",
              source: "chengfeng-videocut",
            },
          },
          {
            type: "codex_continue_required",
            payload: {
              stage: "subtitle_rebuild",
              prompt: `继续 ${snapshot.jobId}`,
              reason: "剪辑完成，需要 Codex 基于剪后视频重新转写并校对字幕。",
            },
          },
        ], completed.date);
      })().catch(() => undefined);
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
      let failure: unknown = error;
      let artifactRollbackFailed = error instanceof KouboWorkflowError &&
        error.details?.reason === "artifact_pair_rollback_failed";
      if (promotion) {
        try {
          await promotion.rollback();
        } catch (rollbackError) {
          artifactRollbackFailed = true;
          failure = new KouboWorkflowError(
            "workflow_failed",
            `${errorMessage(error)}; additionally failed to restore the previous artifact pair: ${errorMessage(rollbackError)}`,
            {
              reason: "artifact_pair_rollback_failed",
              transactionDirectory,
            },
          );
        }
      }
      if (!artifactRollbackFailed) {
        await removeTransactionDirectory(transactionDirectory).catch(() => undefined);
      }
      try {
        await markCutFailure({
          directory,
          projectPath: snapshot.projectPath,
          project: cuttingProject,
          error: failure,
          now: options.now,
        });
      } catch (markError) {
        throw new KouboWorkflowError(
          "workflow_failed",
          `${errorMessage(failure)}; additionally failed to persist recovery state: ${errorMessage(markError)}`,
        );
      }
      throw asWorkflowFailure(failure);
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
  if (!/^\d+[:：]\d+$/.test(aspectRatio)) {
    throw new KouboWorkflowError(
      "invalid_config",
      "aspectRatio must be a W:H ratio (e.g. 3:4, 16:9, 1:1)",
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

    if (action === "start-final") {
      const editListRevision = await currentEditListRevision(directory);
      const artifact = await readKouboCutArtifactStatus(directory, editListRevision);
      if (artifact.state !== "current") {
        throw new KouboWorkflowError(
          "invalid_state",
          "start-final requires a verified cut artifact for the current edit list",
          {
            reason: "cut_artifact_not_current",
            artifactState: artifact.state,
            artifactEditListRevision: artifact.editListRevision,
            currentEditListRevision: editListRevision,
            artifactPath: artifact.path,
          },
        );
      }
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
