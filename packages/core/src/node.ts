import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  chmod,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_DOCTOR_CAPABILITIES,
  isKnownNaturalPausePolicyVersion,
  type RuntimeDoctorCapabilities,
} from "@video-workbench/contracts";
import {
  buildCutSelectionDocument,
  buildCutSelectionFromProposal,
  buildCutTimeRanges,
  expandCutWordIdsAcrossEnclosedGaps,
  hasSameCutSelectionMeaning,
  parseTranscriptWords,
  totalCutDuration,
  type CutSelectionDocument,
  type JsonObject,
} from "./cuts";
import {
  applyEditListOperation,
  buildEditListFromCuts,
  hasSameEditListMeaning,
  parseEditListDocument,
  type EditListDocument,
  type EditListOperation,
} from "./editList";
import {
  CONFIG_FIELDS,
  PRODUCT_CONFIG_FILE,
  configField,
  maskSecret,
  parseProductConfig,
  resolveSetting,
  withSetting,
  type ConfigFieldPath,
  type ProductConfig,
  type ResolvedSetting,
} from "./config";
import { VideocutError } from "./errors";
import {
  assertSubtitleDocument,
  createSubtitleDocument,
  normalizeSubtitleStyle,
  respellSubtitles,
  subtitleStaleness,
  type SubtitleDocument,
  type SubtitleRespellResult,
} from "./subtitles";
import { assertVisualDocument, type VisualDocument } from "./visuals";
import { serializeProjectOperation } from "./projectLock";
export {
  OPERATION_ADMISSION_VERSION,
  OPERATION_AUDIT_SCHEMA_VERSION,
  OPERATION_IDEMPOTENCY_VERSION,
  OperationAuditStore,
  generatedOperationId,
  operationInputHash,
  type OperationAdmission,
  type OperationAdmissionInput,
  type OperationAuditFields,
  type OperationAuditKind,
  type OperationAuditRecord,
  type OperationAuditTerminalStatus,
} from "./operationAudit";
export {
  PROJECT_OPERATION_LOCK_NAME,
  projectOperationLockPath,
  serializeProjectOperation,
  type ProjectOperationLockOptions,
} from "./projectLock";

export const PROJECT_DOCUMENT_NAMES = [
  "project.json",
  "transcript.json",
  "cut-selection.json",
  "edit-list.json",
  "subtitles.json",
  // The layers drawn over the footage. Not to be confused with `visual-plan.json`
  // below, which is the retired pipeline's storyboard artifact — nothing has
  // ever parsed that one's contents, and it is on the way out.
  "visuals.json",
  "visual-plan.json",
  "workbench.json",
] as const;

export type ProjectDocumentName = (typeof PROJECT_DOCUMENT_NAMES)[number];

export interface ProjectResolutionOptions {
  cwd?: string;
  projectsDir?: string;
  outputDir?: string;
}

export interface ResolvedProject {
  directory: string;
  projectId: string;
  project: JsonObject;
  projectRevision: string;
}

export interface JsonDocument<T = unknown> {
  value: T;
  revision: string;
  raw: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The product's own home: `~/.chengfeng-videocut` unless told otherwise.
 *
 * `projects/`, `app/`, `logs/` and the config file all live here. It is not the
 * code repository and not a video project — both of those are shared or
 * packaged, and a credential in either leaves the machine with them.
 */
export function productHomeDir(): string {
  return resolve(
    process.env.CHENGFENG_VIDEOCUT_DATA_DIR
      ?? process.env.CHENGFENG_VIDEOCUT_HOME
      ?? join(homedir(), ".chengfeng-videocut"),
  );
}

export function productConfigPath(): string {
  return join(productHomeDir(), PRODUCT_CONFIG_FILE);
}

/** Read the config file, or an empty config when there is not one yet. */
export async function readProductConfig(): Promise<ProductConfig> {
  const snapshot = await readOptionalJsonAt(productConfigPath());
  return snapshot ? parseProductConfig(snapshot.value) : {};
}

/**
 * Store one setting, creating the file at `0600` if needed.
 *
 * The mode is set on every write, not only on creation: a file that was once
 * world-readable stays world-readable, and the one thing this file exists to
 * hold is a secret.
 */
export async function writeProductSetting(
  path: ConfigFieldPath,
  value: string,
): Promise<{ path: string; field: ConfigFieldPath; stored: string }> {
  const field = configField(path);
  if (!field) {
    throw new VideocutError("invalid_argument", `Unknown setting: ${path}`, {
      known: CONFIG_FIELDS.map((item) => item.path),
    });
  }
  const trimmed = value.trim();
  if (!trimmed) throw new VideocutError("invalid_argument", `${path} cannot be empty`);
  const target = productConfigPath();
  await mkdir(dirname(target), { recursive: true });
  const next = withSetting(await readProductConfig(), path, trimmed);
  await atomicWriteText(target, serializeJson(next));
  await chmod(target, 0o600);
  return {
    path: target,
    field: path,
    stored: field.secret ? maskSecret(trimmed) : trimmed,
  };
}

/** Every setting, where its value came from, and what it is — secrets masked. */
export async function inspectProductConfig(): Promise<Array<{
  field: ConfigFieldPath;
  describe: string;
  env: string;
  required: boolean;
  source: ResolvedSetting["source"];
  value: string | null;
}>> {
  const config = await readProductConfig();
  return CONFIG_FIELDS.map((field) => {
    const resolved = resolveSetting(field.path, config, process.env);
    return {
      field: field.path,
      describe: field.describe,
      env: field.env,
      required: field.required,
      source: resolved.source,
      value: resolved.value === undefined
        ? null
        : field.secret ? maskSecret(resolved.value) : resolved.value,
    };
  });
}

/**
 * The credentials a cloud transcription needs, from wherever they are set.
 *
 * Callers pass this straight through instead of reading `process.env`
 * themselves, so there is one answer to "where does the key come from" rather
 * than one per call site.
 */
export async function resolveTranscriptionCredentials(): Promise<{
  apiKey?: string;
  resourceId?: string;
  modelName?: string;
}> {
  const config = await readProductConfig();
  const pick = (path: ConfigFieldPath) => resolveSetting(path, config, process.env).value;
  const apiKey = pick("transcription.apiKey");
  const resourceId = pick("transcription.resourceId");
  const modelName = pick("transcription.modelName");
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(modelName ? { modelName } : {}),
  };
}

export function defaultProjectsDir(): string {
  return resolve(
    process.env.CHENGFENG_VIDEOCUT_PROJECTS_DIR ??
      process.env.VIDEO_WORKBENCH_PROJECTS_DIR ??
      join(homedir(), ".chengfeng-videocut", "projects"),
  );
}

function configuredOutputDir(options: ProjectResolutionOptions): string | undefined {
  const value = options.outputDir ?? process.env.CHENGFENG_VIDEOCUT_OUTPUT_DIR;
  return value ? resolve(value) : undefined;
}

async function existingDirectory(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? await realpath(path) : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertSafeProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("\0")
  ) {
    throw new VideocutError("invalid_project", `Invalid project id: ${projectId}`);
  }
}

async function readJsonAt<T = unknown>(path: string): Promise<JsonDocument<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new VideocutError("project_not_found", `Missing file: ${path}`, { path });
    }
    throw error;
  }
  try {
    return {
      value: JSON.parse(raw) as T,
      revision: sha256(raw),
      raw,
    };
  } catch {
    throw new VideocutError("invalid_json", `Invalid JSON: ${path}`, { path });
  }
}

async function readOptionalJsonAt<T = unknown>(
  path: string,
): Promise<JsonDocument<T> | null> {
  try {
    return await readJsonAt<T>(path);
  } catch (error) {
    if (error instanceof VideocutError && error.code === "project_not_found") return null;
    throw error;
  }
}

function documentPath(project: ResolvedProject, name: ProjectDocumentName): string {
  return join(project.directory, name);
}

export async function readProjectDocument<T = unknown>(
  project: ResolvedProject,
  name: ProjectDocumentName,
): Promise<JsonDocument<T>> {
  return readJsonAt<T>(documentPath(project, name));
}

export async function readOptionalProjectDocument<T = unknown>(
  project: ResolvedProject,
  name: ProjectDocumentName,
): Promise<JsonDocument<T> | null> {
  return readOptionalJsonAt<T>(documentPath(project, name));
}

export async function resolveProject(
  input: string,
  options: ProjectResolutionOptions = {},
): Promise<ResolvedProject> {
  const projectInput = input.trim();
  if (!projectInput) {
    throw new VideocutError("invalid_argument", "Project path or id is required");
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const looksLikePath =
    isAbsolute(projectInput) ||
    projectInput.startsWith(".") ||
    projectInput.includes("/") ||
    projectInput.includes("\\");
  let directory: string | null = null;

  if (looksLikePath) {
    directory = await existingDirectory(resolve(cwd, projectInput));
  } else {
    assertSafeProjectId(projectInput);
    const projectsDir = resolve(options.projectsDir ?? defaultProjectsDir());
    directory = await existingDirectory(join(projectsDir, projectInput));
    const outputDir = configuredOutputDir(options);
    if (!directory && outputDir) {
      directory = await existingDirectory(join(outputDir, projectInput));
    }
  }

  if (!directory) {
    throw new VideocutError("project_not_found", `Project not found: ${projectInput}`, {
      project: projectInput,
    });
  }

  const manifest = await readJsonAt<unknown>(join(directory, "project.json"));
  if (!isObject(manifest.value)) {
    throw new VideocutError(
      "invalid_project",
      `project.json must contain an object: ${directory}`,
    );
  }
  const projectId =
    typeof manifest.value.jobId === "string" && manifest.value.jobId.trim()
      ? manifest.value.jobId.trim()
      : basename(directory);
  assertSafeProjectId(projectId);

  return {
    directory,
    projectId,
    project: manifest.value,
    projectRevision: manifest.revision,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function stringField(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function nestedString(object: JsonObject, objectKey: string, key: string): string | null {
  const nested = object[objectKey];
  return isObject(nested) ? stringField(nested, key) : null;
}

function documentSummary(document: JsonDocument | null): {
  exists: boolean;
  revision: string | null;
  bytes: number;
} {
  return document
    ? { exists: true, revision: document.revision, bytes: Buffer.byteLength(document.raw) }
    : { exists: false, revision: null, bytes: 0 };
}

export async function inspectProject(project: ResolvedProject): Promise<JsonObject> {
  const [transcript, cuts, editList, visualPlan, workbench] = await Promise.all([
    readOptionalProjectDocument(project, "transcript.json"),
    readOptionalProjectDocument(project, "cut-selection.json"),
    readOptionalProjectDocument(project, "edit-list.json"),
    readOptionalProjectDocument(project, "visual-plan.json"),
    readOptionalProjectDocument(project, "workbench.json"),
  ]);

  const warnings: string[] = [];
  let words: ReturnType<typeof parseTranscriptWords> = [];
  if (transcript) words = parseTranscriptWords(transcript.value);

  let cutWordIds: string[] = [];
  let storedRanges: unknown = null;
  if (cuts) {
    if (!isObject(cuts.value) || !Array.isArray(cuts.value.cutWordIds)) {
      throw new VideocutError(
        "invalid_cut_selection",
        "cut-selection.json must contain cutWordIds as an array",
      );
    }
    cutWordIds = cuts.value.cutWordIds.map((value, index) => {
      if (typeof value !== "string") {
        throw new VideocutError(
          "invalid_cut_selection",
          `cut-selection.json cutWordIds[${index}] must be a string`,
        );
      }
      return value;
    });
    if (new Set(cutWordIds).size !== cutWordIds.length) {
      throw new VideocutError(
        "invalid_cut_selection",
        "cut-selection.json cutWordIds must not contain duplicates",
      );
    }
    storedRanges = cuts.value.cutRanges;
  }

  const knownWordIds = new Set(words.map((word) => word.id));
  const unknownCutWordIds = cutWordIds.filter((id) => !knownWordIds.has(id));
  if (cuts && !transcript) warnings.push("cut-selection.json exists without transcript.json");
  if (unknownCutWordIds.length > 0) {
    warnings.push(`${unknownCutWordIds.length} cut word id(s) are missing from transcript.json`);
  }
  const derivedRanges = words.length
    ? buildCutTimeRanges(words, new Set(cutWordIds))
    : [];
  const rangesMatchTranscript = cuts
    ? JSON.stringify(storedRanges) === JSON.stringify(derivedRanges)
    : null;
  if (rangesMatchTranscript === false) {
    warnings.push("cutRanges does not match transcript.json + cutWordIds");
  }

  const inputVideo = stringField(project.project, "inputVideo");
  const inputVideoPath = inputVideo ? resolve(project.directory, inputVideo) : null;
  const hasIndex = await pathExists(join(project.directory, "index.html"));
  if (!hasIndex) warnings.push("index.html is missing");

  return {
    projectId: project.projectId,
    directory: project.directory,
    status: stringField(project.project, "status"),
    projectRevision: project.projectRevision,
    config: {
      aspectRatio: nestedString(project.project, "config", "aspectRatio"),
    },
    sourceMedia: {
      path: inputVideo,
      exists: inputVideoPath ? await pathExists(inputVideoPath) : false,
    },
    workbenchUrl: nestedString(project.project, "workbench", "url"),
    entry: {
      path: "index.html",
      exists: hasIndex,
    },
    documents: {
      project: {
        exists: true,
        revision: project.projectRevision,
      },
      transcript: {
        ...documentSummary(transcript),
        wordCount: words.length,
      },
      cuts: {
        ...documentSummary(cuts),
        cutWordCount: cutWordIds.length,
        cutRangeCount: derivedRanges.length,
        cutDuration: totalCutDuration(derivedRanges),
        rangesMatchTranscript,
      },
      editList: editList
        ? {
            ...documentSummary(editList),
            duration: parseEditListDocument(editList.value).duration,
            segmentCount: parseEditListDocument(editList.value).segments.length,
            mode: parseEditListDocument(editList.value).mode,
          }
        : documentSummary(null),
      visualPlan: documentSummary(visualPlan),
      workbench: documentSummary(workbench),
    },
    warnings,
  };
}

export interface RegisterProjectResult {
  projectId: string;
  linkPath: string;
  registered: boolean;
}

export async function registerProject(
  project: ResolvedProject,
  projectsDir = defaultProjectsDir(),
): Promise<RegisterProjectResult> {
  if (!(await pathExists(join(project.directory, "index.html")))) {
    throw new VideocutError(
      "invalid_project",
      `Project has no index.html: ${project.directory}`,
    );
  }
  assertSafeProjectId(project.projectId);
  await mkdir(projectsDir, { recursive: true });
  const linkPath = join(resolve(projectsDir), project.projectId);

  try {
    await lstat(linkPath);
    let existing: string;
    try {
      existing = await realpath(linkPath);
    } catch {
      throw new VideocutError(
        "project_id_conflict",
        `Project id points to a broken link: ${project.projectId}`,
        { linkPath },
      );
    }
    if (existing !== project.directory) {
      throw new VideocutError(
        "project_id_conflict",
        `Project id is already registered to another directory: ${project.projectId}`,
        { linkPath, existing, requested: project.directory },
      );
    }
    return { projectId: project.projectId, linkPath, registered: false };
  } catch (error) {
    if (error instanceof VideocutError) throw error;
    if (errorCode(error) !== "ENOENT") throw error;
  }

  try {
    await symlink(project.directory, linkPath, "dir");
  } catch (error) {
    if (errorCode(error) === "EEXIST") return registerProject(project, projectsDir);
    throw error;
  }
  return { projectId: project.projectId, linkPath, registered: true };
}

export function projectUrl(project: ResolvedProject, origin?: string): string {
  const manifestUrl = nestedString(project.project, "workbench", "url");
  const source =
    origin?.trim() || process.env.CHENGFENG_VIDEOCUT_STUDIO_ORIGIN?.trim() || manifestUrl;
  if (!source) {
    throw new VideocutError(
      "studio_origin_required",
      "Studio origin is missing; pass --origin or set CHENGFENG_VIDEOCUT_STUDIO_ORIGIN",
    );
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new VideocutError("invalid_argument", `Invalid Studio origin: ${source}`);
  }
  // 口播工作台由 ?view=koubo 选择，且必须是真正的 query 参数（# 之前）：
  // 前端用 searchParams 读它，拼进 hash 里会静默落回上游 Studio 界面。
  url.searchParams.set("view", "koubo");
  url.hash = `project/${encodeURIComponent(project.projectId)}`;
  return url.toString();
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o644;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    try {
      const directoryHandle = await openFile(dirname(path), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is not supported on every platform. The file rename is atomic.
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<string> {
  const content = serializeJson(value);
  await atomicWriteText(path, content);
  return sha256(content);
}

/**
 * Who asked for a change. The log records what the caller declared; nothing here
 * can verify it, so `unknown` is honest and must stay the default rather than
 * being guessed at.
 */
export type ProjectEventActor =
  | "studio-transcript"
  | "studio-timeline"
  | "cli"
  | "skill"
  | "runtime"
  | "unknown";

export interface ProjectEvent {
  type: string;
  actor?: ProjectEventActor;
  payload?: JsonObject;
}

/**
 * Append one line to the project's `events.jsonl`.
 *
 * Every deletion and restore used to leave no trace at all: the cut ranges hold
 * two numbers and nothing else, and `events.jsonl` only ever carried the two
 * lines written when a project was prepared. On 2026-07-26 a real timeline lost
 * two segments and 2.32 seconds and it was impossible to determine what had done
 * it — not because the evidence was ambiguous, but because none was recorded.
 *
 * A failed append must never fail the edit it describes: losing a log line is
 * strictly better than losing the person's work. It must not be swallowed in
 * silence either, or the log lies by omission — so failures go to stderr.
 */
export async function appendProjectEvent(
  project: ResolvedProject,
  event: ProjectEvent,
  now: () => Date = () => new Date(),
): Promise<void> {
  const line = `${JSON.stringify({
    ts: now().toISOString(),
    type: event.type,
    actor: event.actor ?? "unknown",
    payload: { projectId: project.projectId, ...(event.payload ?? {}) },
  })}\n`;
  try {
    await appendFile(join(project.directory, "events.jsonl"), line, "utf8");
  } catch (error) {
    process.stderr.write(
      `[events] failed to record ${event.type} for ${project.projectId}: ${String(error)}\n`,
    );
  }
}

function cutSelectionEventPayload(result: WriteCutSelectionResult): JsonObject {
  return {
    previousRevision: result.previousRevision,
    revision: result.revision,
    changed: result.changed,
    cutWordCount: result.document.cutWordIds.length,
    cutRangeCount: result.document.cutRanges.length,
    cutSeconds: Number(
      result.document.cutRanges
        .reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
        .toFixed(3),
    ),
  };
}

function editListEventPayload(result: WriteEditListResult): JsonObject {
  return {
    previousRevision: result.previousRevision,
    revision: result.revision,
    changed: result.changed,
    mode: result.document.mode,
    segmentCount: result.document.segments.length,
    duration: result.document.duration,
  };
}

export interface WriteCutSelectionOptions {
  expectedRevision?: string;
  dryRun?: boolean;
  /** Declared by the caller and recorded verbatim; nothing here can verify it. */
  actor?: ProjectEventActor;
  now?: string;
  /**
   * `full-selection` is the authoritative Studio checkbox state. It may keep a
   * pause that natural-pause-v2 initially selected for deletion.
   *
   * `semantic-overlay` is the Skill/CLI contract: the submitted ids describe
   * semantic spoken-word deletions only. Product-owned natural-pause-v2 ids
   * are merged from the stored initialization baseline while the project lock
   * is held, so a Skill never has to copy or union that baseline itself.
   */
  mode?: CutSelectionWriteMode;
}

export type CutSelectionWriteMode = "full-selection" | "semantic-overlay";

export interface WriteCutSelectionResult {
  projectId: string;
  path: string;
  previousRevision: string | null;
  revision: string;
  changed: boolean;
  dryRun: boolean;
  document: CutSelectionDocument;
}

/**
 * Carve newly deleted ranges out of a hand-arranged timeline.
 *
 * Regenerating the timeline from Cuts would throw away the arrangement, so only
 * the difference is applied, one range at a time, through the same operator the
 * editor uses. Everything the user did — order, trims, restores — survives.
 *
 * Two kinds of range are deliberately skipped:
 *  - ranges already absent from the timeline, so nothing to do;
 *  - ranges the user restored on purpose. A restore is a decision and a review
 *    result is a suggestion, so the decision wins. Assuming the opposite is how
 *    a sentence ended up playing twice.
 */
const CUT_RANGE_EPSILON = 0.0005;

function applyNewCutRangesToManualTimeline(
  current: EditListDocument,
  previous: CutSelectionDocument | undefined,
  next: CutSelectionDocument,
): EditListDocument {
  const source = current.segments[0]?.source;
  if (!source) return current;

  const wasDeleted = (start: number, end: number): boolean =>
    (previous?.cutRanges ?? []).some((range) =>
      range.start <= start + CUT_RANGE_EPSILON && range.end >= end - CUT_RANGE_EPSILON);

  let document = current;
  for (const range of next.cutRanges) {
    // Only act on ranges Cuts did not already claim; the rest are either
    // untouched or were restored by hand afterwards.
    if (wasDeleted(range.start, range.end)) continue;
    const audible = document.segments.some((segment) =>
      segment.source === source
      && segment.sourceStart < range.end - CUT_RANGE_EPSILON
      && segment.sourceEnd > range.start + CUT_RANGE_EPSILON);
    if (!audible) continue;
    try {
      document = applyEditListOperation(document, {
        type: "delete-range",
        source,
        sourceStart: range.start,
        sourceEnd: range.end,
      });
    } catch {
      // A single unusable range must not abandon the rest. Geometry that the
      // operator refuses — a range shorter than the minimum segment, or one
      // that would empty the timeline — is left in place on the timeline while
      // still being recorded in Cuts as the reason it should go.
      continue;
    }
  }
  return document;
}

function naturalPauseBaselineWordIds(
  words: readonly ReturnType<typeof parseTranscriptWords>[number][],
  previous: unknown,
): string[] {
  if (!isObject(previous)) return [];
  const initialization = previous.initialization;
  if (
    !isObject(initialization) ||
    !isKnownNaturalPausePolicyVersion(initialization.naturalPausePolicy) ||
    !Array.isArray(initialization.baselineCutWordIds)
  ) {
    return [];
  }

  // The baseline is persisted Product metadata, but old or partially migrated
  // projects can contain stale ids. Only transcript-backed ids are legal for
  // the current write; preserve transcript order and de-duplicate them.
  const requested = new Set(
    initialization.baselineCutWordIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return words.filter((word) => requested.has(word.id)).map((word) => word.id);
}

function buildProductCutSelectionFromProposal(
  words: readonly ReturnType<typeof parseTranscriptWords>[number][],
  proposal: unknown,
  previous: unknown,
  updatedAt: string,
  mode: CutSelectionWriteMode,
): CutSelectionDocument {
  const submitted = buildCutSelectionFromProposal(words, proposal, previous, updatedAt);
  if (mode === "full-selection") return submitted;

  const semanticCutWordIds = expandCutWordIdsAcrossEnclosedGaps(
    words,
    new Set(submitted.cutWordIds),
  );
  const baseline = naturalPauseBaselineWordIds(words, previous);
  return buildCutSelectionDocument({
    words,
    cutWordIds: new Set([...baseline, ...semanticCutWordIds]),
    previous,
    updatedAt,
    // Only the semantic decisions carry a declared reason. The baseline's reason
    // is the pause policy already recorded in `initialization.naturalPausePolicy`,
    // so inventing per-word entries for it would add noise, not information.
    reasons: isObject(proposal) ? proposal.reasons : undefined,
  });
}

async function writeCutSelectionSnapshot(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteCutSelectionOptions,
): Promise<WriteCutSelectionResult> {
  const transcript = await readProjectDocument(project, "transcript.json");
  const words = parseTranscriptWords(transcript.value);
  const targetPath = documentPath(project, "cut-selection.json");
  const previous = await readOptionalJsonAt(targetPath);
  const currentRevision = previous?.revision ?? null;

  if (options.expectedRevision !== undefined) {
    const expectedCurrent = currentRevision ?? "none";
    if (options.expectedRevision !== expectedCurrent) {
      throw new VideocutError(
        "revision_conflict",
        "cut-selection.json changed after it was inspected",
        { expectedRevision: options.expectedRevision, currentRevision },
      );
    }
  }

  const document = buildProductCutSelectionFromProposal(
    words,
    proposal,
    previous?.value,
    options.now ?? new Date().toISOString(),
    options.mode ?? "full-selection",
  );
  if (previous && hasSameCutSelectionMeaning(previous.value, document)) {
    return {
      projectId: project.projectId,
      path: targetPath,
      previousRevision: currentRevision,
      revision: currentRevision as string,
      changed: false,
      dryRun: Boolean(options.dryRun),
      document: previous.value as CutSelectionDocument,
    };
  }

  const content = serializeJson(document);
  const revision = sha256(content);
  if (!options.dryRun) await atomicWriteText(targetPath, content);
  return {
    projectId: project.projectId,
    path: targetPath,
    previousRevision: currentRevision,
    revision,
    changed: true,
    dryRun: Boolean(options.dryRun),
    document,
  };
}

/**
 * Writes a cut selection using an optimistic revision check.
 *
 * Mutating writes are serialized per project across CLI/Studio processes so
 * two callers cannot both commit from the same expected revision. A dry run
 * deliberately skips that lock: it is an advisory snapshot and does not
 * reserve the returned revision for a later write.
 */
export async function writeCutSelection(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteCutSelectionOptions = {},
): Promise<WriteCutSelectionResult> {
  const operation = async () => {
    const result = await writeCutSelectionSnapshot(project, proposal, options);
    if (result.changed) {
      await appendProjectEvent(project, {
        type: "cuts_written",
        actor: options.actor,
        payload: cutSelectionEventPayload(result),
      });
    }
    return result;
  };
  if (options.dryRun) return writeCutSelectionSnapshot(project, proposal, options);
  return serializeProjectOperation(project.directory, operation);
}

export interface WriteCutsAndDerivedEditListResult {
  cuts: WriteCutSelectionResult;
  editList: WriteEditListResult | null;
}

/**
 * Product transaction used by the Cuts API. A derived edit list follows Cuts;
 * a manual edit list rejects semantic Cuts changes until the user explicitly rebases.
 */
export async function writeCutSelectionWithEditList(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteCutSelectionOptions = {},
): Promise<WriteCutsAndDerivedEditListResult> {
  const operation = async (): Promise<WriteCutsAndDerivedEditListResult> => {
    const [previousCuts, transcript, previousEditList] = await Promise.all([
      readOptionalJsonAt(documentPath(project, "cut-selection.json")),
      readProjectDocument(project, "transcript.json"),
      readOptionalJsonAt(documentPath(project, "edit-list.json")),
    ]);
    const currentCutsRevision = previousCuts?.revision ?? null;
    if (options.expectedRevision !== undefined) {
      const expectedCurrent = currentCutsRevision ?? "none";
      if (options.expectedRevision !== expectedCurrent) {
        throw new VideocutError(
          "revision_conflict",
          "cut-selection.json changed after it was inspected",
          { expectedRevision: options.expectedRevision, currentRevision: currentCutsRevision },
        );
      }
    }
    const words = parseTranscriptWords(transcript.value);
    const candidate = buildProductCutSelectionFromProposal(
      words,
      proposal,
      previousCuts?.value,
      options.now ?? new Date().toISOString(),
      options.mode ?? "full-selection",
    );
    const cutsChange = !previousCuts || !hasSameCutSelectionMeaning(previousCuts.value, candidate);
    const currentEditList = previousEditList
      ? parseEditListDocument(previousEditList.value)
      : null;
    if (!currentEditList) {
      throw new VideocutError(
        "invalid_edit_list",
        "edit-list.json does not exist; prepare the project before changing Cuts",
        {
          reason: "project_not_prepared",
          projectId: project.projectId,
        },
      );
    }

    const cutsPath = documentPath(project, "cut-selection.json");
    const cutsContent = cutsChange ? serializeJson(candidate) : previousCuts?.raw ?? "";
    const cutsRevision = cutsChange ? sha256(cutsContent) : currentCutsRevision as string;
    const cuts: WriteCutSelectionResult = {
      projectId: project.projectId,
      path: cutsPath,
      previousRevision: currentCutsRevision,
      revision: cutsRevision,
      changed: cutsChange,
      dryRun: Boolean(options.dryRun),
      document: cutsChange
        ? candidate
        : previousCuts?.value as CutSelectionDocument,
    };

    // Build and serialize every dependent document before the first rename.
    // In particular, a selection that removes the whole source must reject
    // without leaving cut-selection.json ahead of edit-list.json.
    let nextEditList: EditListDocument | null = null;
    let editListContent: string | null = null;
    let editListRevision: string | null = null;
    if (cutsChange && currentEditList.mode === "cuts-derived") {
      nextEditList = buildEditListFromCuts({
        projectId: project.projectId,
        source: currentEditList.segments[0]?.source ?? "",
        sourceDuration: currentEditList.sourceDuration,
        cutsRevision,
        transcriptRevision: transcript.revision,
        cutRanges: candidate.cutRanges,
      });
      editListContent = serializeJson(nextEditList);
      editListRevision = sha256(editListContent);
    } else if (cutsChange && currentEditList.mode === "manual") {
      // A hand-arranged timeline cannot be regenerated from Cuts without
      // discarding the arrangement, so this used to be refused outright — which
      // left semantic review with no way in at all once the user had touched the
      // timeline even once.
      //
      // Instead of rebuilding, carve out only what is newly deleted. Ranges the
      // user still has on the timeline but that Cuts now marks deleted are
      // removed one at a time through the same operator the editor uses, so the
      // order, trims and restores all survive.
      //
      // Ranges already absent are skipped, and a range the user deliberately
      // restored is skipped too: an explicit user action outranks a suggestion,
      // which is exactly the case that produced a duplicated sentence when the
      // opposite was assumed.
      nextEditList = applyNewCutRangesToManualTimeline(
        currentEditList,
        previousCuts?.value as CutSelectionDocument | undefined,
        candidate,
      );
      if (nextEditList !== currentEditList) {
        editListContent = serializeJson(nextEditList);
        editListRevision = sha256(editListContent);
      } else {
        nextEditList = null;
      }
    }

    const editList: WriteEditListResult | null = nextEditList && editListContent && editListRevision
      ? {
          projectId: project.projectId,
          path: documentPath(project, "edit-list.json"),
          previousRevision: previousEditList?.revision ?? null,
          revision: editListRevision,
          changed: !previousEditList || previousEditList.revision !== editListRevision,
          dryRun: Boolean(options.dryRun),
          document: nextEditList,
        }
      : null;
    if (options.dryRun || !cutsChange) return { cuts, editList };

    await atomicWriteText(cutsPath, cutsContent);
    if (editList?.changed && editListContent) {
      try {
        await atomicWriteText(editList.path, editListContent);
      } catch (error) {
        try {
          if (previousCuts) await atomicWriteText(cutsPath, previousCuts.raw);
          else await rm(cutsPath, { force: true });
        } catch (rollbackError) {
          throw new VideocutError(
            "io_error",
            "Failed to save edit-list.json and failed to roll back cut-selection.json",
            {
              cause: error instanceof Error ? error.message : String(error),
              rollbackCause: rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
            },
          );
        }
        throw error;
      }
    }
    // One line for the whole transaction, not one per file: Cuts and the derived
    // edit list land together or not at all, so two lines would imply two events.
    await appendProjectEvent(project, {
      type: "cuts_written",
      actor: options.actor,
      payload: {
        ...cutSelectionEventPayload(cuts),
        ...(editList?.changed
          ? { editList: editListEventPayload(editList) }
          : { editList: null }),
      },
    });
    return { cuts, editList };
  };
  if (options.dryRun) return operation();
  return serializeProjectOperation(project.directory, operation);
}

export interface WriteEditListOptions {
  expectedRevision?: string;
  dryRun?: boolean;
  /** Declared by the caller and recorded verbatim; nothing here can verify it. */
  actor?: ProjectEventActor;
  /**
   * Last chance to move a cut, and the only one.
   *
   * Transcription marks where it recognised a word, not where the sound stops, so a
   * boundary taken straight from it can land mid-syllable. Correcting that needs the
   * audio, which this module cannot read — so the caller does it, here, before the
   * document is written. Afterwards the boundary is the record: cutting, playback and
   * export all obey it, and none of them may adjust it again.
   */
  placeBoundaries?: (document: EditListDocument) => Promise<EditListDocument>;
}

export interface WriteEditListResult {
  projectId: string;
  path: string;
  previousRevision: string | null;
  revision: string;
  changed: boolean;
  dryRun: boolean;
  document: EditListDocument;
}

async function commitEditListSnapshot(
  project: ResolvedProject,
  previous: JsonDocument | null,
  document: EditListDocument,
  options: WriteEditListOptions,
): Promise<WriteEditListResult> {
  const targetPath = documentPath(project, "edit-list.json");
  const currentRevision = previous?.revision ?? null;
  if (options.expectedRevision !== undefined) {
    const expectedCurrent = currentRevision ?? "none";
    if (options.expectedRevision !== expectedCurrent) {
      throw new VideocutError(
        "revision_conflict",
        "edit-list.json changed after it was inspected",
        { expectedRevision: options.expectedRevision, currentRevision },
      );
    }
  }
  if (document.projectId !== project.projectId) {
    throw new VideocutError(
      "invalid_edit_list",
      "edit-list.json projectId does not match the registered project",
      { documentProjectId: document.projectId, projectId: project.projectId },
    );
  }
  if (previous && hasSameEditListMeaning(previous.value, document)) {
    return {
      projectId: project.projectId,
      path: targetPath,
      previousRevision: currentRevision,
      revision: currentRevision as string,
      changed: false,
      dryRun: Boolean(options.dryRun),
      document: parseEditListDocument(previous.value),
    };
  }
  const content = serializeJson(document);
  const nextRevision = sha256(content);
  if (!options.dryRun) await atomicWriteText(targetPath, content);
  return {
    projectId: project.projectId,
    path: targetPath,
    previousRevision: currentRevision,
    revision: nextRevision,
    changed: true,
    dryRun: Boolean(options.dryRun),
    document,
  };
}

async function writeEditListSnapshot(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteEditListOptions,
): Promise<WriteEditListResult> {
  const previous = await readOptionalJsonAt(documentPath(project, "edit-list.json"));
  const document = parseEditListDocument(proposal);
  return commitEditListSnapshot(project, previous, document, options);
}

export async function readEditList(
  project: ResolvedProject,
): Promise<JsonDocument<EditListDocument> | null> {
  const snapshot = await readOptionalProjectDocument(project, "edit-list.json");
  if (!snapshot) return null;
  return { ...snapshot, value: parseEditListDocument(snapshot.value) };
}

export async function writeEditList(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteEditListOptions = {},
): Promise<WriteEditListResult> {
  const operation = async () => {
    const result = await writeEditListSnapshot(project, proposal, options);
    // Inside the lock, after the bytes landed: the log line and the committed
    // change stand or fall together.
    if (result.changed) {
      await appendProjectEvent(project, {
        type: "edit_list_written",
        actor: options.actor,
        payload: editListEventPayload(result),
      });
    }
    return result;
  };
  if (options.dryRun) return writeEditListSnapshot(project, proposal, options);
  return serializeProjectOperation(project.directory, operation);
}

/* ---------------------------------------------------------------- subtitles */

export interface WriteSubtitlesOptions {
  expectedRevision?: string;
  dryRun?: boolean;
  /** Declared by the caller and recorded verbatim; nothing here can verify it. */
  actor?: ProjectEventActor;
}

export interface WriteSubtitlesResult {
  projectId: string;
  path: string;
  previousRevision: string | null;
  revision: string;
  changed: boolean;
  dryRun: boolean;
  document: SubtitleDocument;
}

export async function readSubtitles(
  project: ResolvedProject,
): Promise<JsonDocument<SubtitleDocument> | null> {
  const snapshot = await readOptionalProjectDocument(project, "subtitles.json");
  if (!snapshot) return null;
  assertSubtitleDocument(snapshot.value);
  // Styles gained fields — a shadow, a plate's corners, tracking — and the
  // outline changed from a centred stroke to an outward one. Filling that in
  // here means one answer for every reader, and none of them has to know that
  // documents written before today exist. The revision is deliberately left
  // alone: normalising is not an edit, and bumping it would make every project
  // look dirty the first time it is opened.
  const style = normalizeSubtitleStyle(snapshot.value.style);
  return { ...snapshot, value: { ...snapshot.value, style } };
}

/**
 * Write `subtitles.json`.
 *
 * Unlike the edit list this has no operation reducer: a subtitle document is
 * small, and every change to it — retyping a line, moving a word to the next
 * screen, nudging the colour — is the person editing text. A whole-document
 * write with a revision check is the honest model of that, and CAS is what
 * stops two open tabs from silently overwriting each other.
 */
export async function writeSubtitles(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteSubtitlesOptions = {},
): Promise<WriteSubtitlesResult> {
  const commit = async (): Promise<WriteSubtitlesResult> => {
    const targetPath = documentPath(project, "subtitles.json");
    const previous = await readOptionalJsonAt(targetPath);
    const currentRevision = previous?.revision ?? null;
    if (options.expectedRevision !== undefined) {
      const expectedCurrent = currentRevision ?? "none";
      if (options.expectedRevision !== expectedCurrent) {
        throw new VideocutError(
          "revision_conflict",
          "subtitles.json changed after it was inspected",
          { expectedRevision: options.expectedRevision, currentRevision },
        );
      }
    }
    assertSubtitleDocument(proposal);
    const document = proposal;
    if (document.projectId !== project.projectId) {
      throw new VideocutError(
        "invalid_subtitles",
        "subtitles.json projectId does not match the registered project",
        { documentProjectId: document.projectId, projectId: project.projectId },
      );
    }
    const content = serializeJson(document);
    const nextRevision = sha256(content);
    if (previous && previous.revision === nextRevision) {
      return {
        projectId: project.projectId,
        path: targetPath,
        previousRevision: currentRevision,
        revision: nextRevision,
        changed: false,
        dryRun: Boolean(options.dryRun),
        document,
      };
    }
    if (!options.dryRun) await atomicWriteText(targetPath, content);
    const result: WriteSubtitlesResult = {
      projectId: project.projectId,
      path: targetPath,
      previousRevision: currentRevision,
      revision: nextRevision,
      changed: true,
      dryRun: Boolean(options.dryRun),
      document,
    };
    if (!options.dryRun) {
      await appendProjectEvent(project, {
        type: "subtitles_written",
        actor: options.actor,
        payload: {
          previousRevision: result.previousRevision,
          revision: result.revision,
          cueCount: document.cues.length,
        },
      });
    }
    return result;
  };
  if (options.dryRun) return commit();
  return serializeProjectOperation(project.directory, commit);
}

/* --------------------------------------------------------------- visuals */

export interface WriteVisualsOptions {
  expectedRevision?: string;
  dryRun?: boolean;
  actor?: ProjectEventActor;
}

export interface WriteVisualsResult {
  projectId: string;
  path: string;
  previousRevision: string | null;
  revision: string;
  changed: boolean;
  dryRun: boolean;
  document: VisualDocument;
}

export async function readVisuals(
  project: ResolvedProject,
): Promise<JsonDocument<VisualDocument> | null> {
  const snapshot = await readOptionalProjectDocument(project, "visuals.json");
  if (!snapshot) return null;
  assertVisualDocument(snapshot.value);
  return { ...snapshot, value: snapshot.value };
}

/**
 * Write `visuals.json`.
 *
 * Same model as the subtitles: a whole-document write under a revision check.
 * The document is small and every change to it is a person placing or removing
 * one layer, so an operation reducer would be machinery without a payer. CAS is
 * what stops two open tabs from silently overwriting each other.
 */
export async function writeVisuals(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteVisualsOptions = {},
): Promise<WriteVisualsResult> {
  const commit = async (): Promise<WriteVisualsResult> => {
    const targetPath = documentPath(project, "visuals.json");
    const previous = await readOptionalJsonAt(targetPath);
    const currentRevision = previous?.revision ?? null;
    if (options.expectedRevision !== undefined) {
      const expectedCurrent = currentRevision ?? "none";
      if (options.expectedRevision !== expectedCurrent) {
        throw new VideocutError(
          "revision_conflict",
          "visuals.json changed after it was inspected",
          { expectedRevision: options.expectedRevision, currentRevision },
        );
      }
    }
    assertVisualDocument(proposal);
    const document = proposal;
    if (document.projectId !== project.projectId) {
      throw new VideocutError(
        "invalid_visuals",
        "visuals.json projectId does not match the registered project",
        { documentProjectId: document.projectId, projectId: project.projectId },
      );
    }
    // A layer names an HTML file that the preview will load. Accepting a path to
    // something that is not there defers a plain "you have not written that
    // module yet" into a blank rectangle at playback, which reads as the
    // product being broken.
    for (const layer of document.layers) {
      const modulePath = resolve(project.directory, layer.module);
      const relativeToProject = relativePath(project.directory, modulePath);
      if (relativeToProject.startsWith("..") || isAbsolute(relativeToProject)) {
        throw new VideocutError(
          "invalid_visuals",
          "A visual layer module must stay inside the project",
          { layerId: layer.id, module: layer.module },
        );
      }
      if (!existsSync(modulePath)) {
        throw new VideocutError(
          "invalid_visuals",
          `Visual layer ${layer.id} names a module that does not exist`,
          { layerId: layer.id, module: layer.module },
        );
      }
    }
    const content = serializeJson(document);
    const nextRevision = sha256(content);
    if (previous && previous.revision === nextRevision) {
      return {
        projectId: project.projectId,
        path: targetPath,
        previousRevision: currentRevision,
        revision: nextRevision,
        changed: false,
        dryRun: Boolean(options.dryRun),
        document,
      };
    }
    if (!options.dryRun) await atomicWriteText(targetPath, content);
    const result: WriteVisualsResult = {
      projectId: project.projectId,
      path: targetPath,
      previousRevision: currentRevision,
      revision: nextRevision,
      changed: true,
      dryRun: Boolean(options.dryRun),
      document,
    };
    if (!options.dryRun) {
      await appendProjectEvent(project, {
        type: "visuals_written",
        actor: options.actor,
        payload: {
          previousRevision: result.previousRevision,
          revision: result.revision,
          layerCount: document.layers.length,
        },
      });
    }
    return result;
  };
  if (options.dryRun) return commit();
  return serializeProjectOperation(project.directory, commit);
}

export interface SubtitleProjectState {
  projectId: string;
  document: SubtitleDocument | null;
  revision: string | null;
  /** Screens the edit broke. Empty when nothing did. */
  stale: ReturnType<typeof subtitleStaleness>;
  /** Transcript revision the stored document was built against. */
  baseTranscriptRevision: string | null;
  /** Transcript revision on disk right now. */
  transcriptRevision: string | null;
}

/**
 * Everything the subtitle surface needs, read in one pass.
 *
 * Staleness is computed here rather than stored, for the same reason timing is:
 * a stored answer goes wrong the moment someone edits the cut, and a wrong
 * answer about what is broken is worse than no answer.
 */
export async function readSubtitleState(
  project: ResolvedProject,
): Promise<SubtitleProjectState> {
  const [subtitles, transcript, editList] = await Promise.all([
    readSubtitles(project),
    readOptionalProjectDocument(project, "transcript.json"),
    readOptionalJsonAt(documentPath(project, "edit-list.json")),
  ]);
  const words = transcript ? parseTranscriptWords(transcript.value) : [];
  const timeline = editList ? parseEditListDocument(editList.value) : null;
  return {
    projectId: project.projectId,
    document: subtitles?.value ?? null,
    revision: subtitles?.revision ?? null,
    stale: subtitles ? subtitleStaleness(subtitles.value, words, timeline) : [],
    baseTranscriptRevision: subtitles?.value.baseTranscriptRevision ?? null,
    transcriptRevision: transcript?.revision ?? null,
  };
}

/**
 * Build a first draft of the subtitles from the transcript and the current cut.
 *
 * Refuses to overwrite an existing document unless asked. Splitting and wording
 * are what a person spends their time on here; silently replacing that with a
 * fresh machine split is the single most destructive thing this command could do.
 */
export async function buildProjectSubtitles(
  project: ResolvedProject,
  options: WriteSubtitlesOptions & {
    replace?: boolean;
    maxColumns?: number;
    breakPauseSeconds?: number;
  } = {},
): Promise<WriteSubtitlesResult> {
  const existing = await readSubtitles(project);
  if (existing && options.replace !== true) {
    throw new VideocutError(
      "subtitles_exist",
      "subtitles.json already exists; pass --replace to rebuild it from the transcript",
      { revision: existing.revision, cueCount: existing.value.cues.length },
    );
  }
  const transcript = await readProjectDocument(project, "transcript.json");
  const editList = await readOptionalJsonAt(documentPath(project, "edit-list.json"));
  const document = createSubtitleDocument(
    project.projectId,
    transcript.revision,
    parseTranscriptWords(transcript.value),
    editList ? parseEditListDocument(editList.value) : null,
    {
      ...(options.maxColumns !== undefined ? { maxColumns: options.maxColumns } : {}),
      ...(options.breakPauseSeconds !== undefined
        ? { breakPauseSeconds: options.breakPauseSeconds }
        : {}),
    },
  );
  return writeSubtitles(project, document, {
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.dryRun ? { dryRun: options.dryRun } : {}),
    ...(existing ? { expectedRevision: existing.revision } : {}),
  });
}

export async function patchEditList(
  project: ResolvedProject,
  operation: EditListOperation | unknown,
  options: WriteEditListOptions,
): Promise<WriteEditListResult> {
  const apply = async () => {
    const previous = await readOptionalJsonAt(documentPath(project, "edit-list.json"));
    if (!previous) {
      throw new VideocutError(
        "invalid_edit_list",
        "edit-list.json does not exist; prepare the project before editing its timeline",
      );
    }
    // Reject a stale command before validating or applying its payload. A
    // restore range may legitimately overlap the *new* document, but that
    // must surface as CAS conflict rather than a misleading payload error.
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== previous.revision
    ) {
      throw new VideocutError(
        "revision_conflict",
        "edit-list.json changed after it was inspected",
        { expectedRevision: options.expectedRevision, currentRevision: previous.revision },
      );
    }
    const current = parseEditListDocument(previous.value);
    const applied = applyEditListOperation(current, operation);
    // Put the cut where it belongs *before* it becomes the record.
    //
    // Nothing downstream may move a boundary. Three layers each nudging it — the
    // ledger writing a transcript timestamp, the cutter hunting for silence, the
    // player seeking — is how the same seam produced three different bugs in one
    // day, each reasonable on its own. So the boundary is decided once, here, and
    // what the ledger says is what is cut, what is played, and what is exported.
    //
    // The adjustment needs the audio, which core cannot read; the caller supplies
    // it. Without one the boundaries stand exactly as given — never guessed at.
    const next = options.placeBoundaries ? await options.placeBoundaries(applied) : applied;
    const result = await commitEditListSnapshot(project, previous, next, options);
    if (result.changed) {
      await appendProjectEvent(project, {
        type: "edit_list_patched",
        actor: options.actor,
        payload: {
          // The operation type is the whole point of this line: it is the only
          // record of *what* was asked for, as opposed to what the file now says.
          operation: describeEditListOperation(operation),
          ...editListEventPayload(result),
        },
      });
    }
    return result;
  };
  if (options.dryRun) return apply();
  return serializeProjectOperation(project.directory, apply);
}

/**
 * Reduce an operation to the fields worth keeping in the log. Deliberately does
 * not persist snapshot payloads: `restore-snapshot` carries whole segment arrays,
 * and a log that copies them would grow without bound.
 */
function describeEditListOperation(operation: EditListOperation | unknown): JsonObject {
  if (!operation || typeof operation !== "object") return { type: "unknown" };
  const value = operation as Record<string, unknown>;
  const described: JsonObject = { type: typeof value.type === "string" ? value.type : "unknown" };
  for (const field of ["clipId", "start", "sourceStart", "sourceEnd", "source", "previousSegmentId", "nextSegmentId"]) {
    if (value[field] !== undefined) described[field] = value[field] as never;
  }
  return described;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export type DoctorCapabilities = RuntimeDoctorCapabilities;

/**
 * PATH 上找可执行文件（Windows 带 PATHEXT 后缀）。导出给服务启动预检用：
 * 常驻服务进程的环境是启动那一刻的快照，终端 doctor 全绿不代表服务进程
 * 找得到 ffmpeg（Issue #3 真机根因），服务必须自己查一遍自己的环境。
 */
export async function findExecutable(name: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  // Windows executables carry PATHEXT suffixes (ffmpeg.exe), and X_OK is
  // meaningless there — without this, doctor reports a perfectly working
  // ffmpeg as missing and the whole Skill chain gates itself shut.
  const suffixes = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((s) => s.toLowerCase())
    : [""];
  const accessMode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  for (const pathEntry of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = join(pathEntry, name + suffix);
      try {
        await access(candidate, accessMode);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

/**
 * One entry of what the audience actually hears, in the order they hear it.
 */
export type PlaybackTranscriptEntry =
  | { id: string; text: string; isGap: boolean; seconds: number }
  | { removedSpeech: string; seconds: number };

export interface PlaybackTranscript {
  projectId: string;
  /** Plain-language contract, carried in the payload because it is what stops the reader misjudging. */
  note: string;
  totalPlayedSeconds: number;
  stream: PlaybackTranscriptEntry[];
}

/**
 * Flatten the transcript into what the audience hears.
 *
 * Judging "did this get said twice" depends on adjacency, and adjacency means
 * *heard* next to each other, not stored next to each other. In an edited
 * project two lines 40 seconds apart in the source can be back-to-back on the
 * timeline, and two lines that are adjacent in the source can have content
 * between them.
 *
 * Handing over the raw transcript instead makes the reader draw the wrong
 * conclusion in a specific, observed way: it sees the cue numbering skip, reads
 * that as "several seconds were withheld from me", and refuses to judge. On
 * 2026-07-26 that rejected two correct calls, one of them a plainly visible
 * repeat. The criteria were fine; the input lied about what was missing.
 *
 * Two details matter as much as the ordering:
 *
 * - A removed stretch is marked only when *speech* was removed. Marking
 *   compressed pauses too took the marker count from 15 to 58 on a real project
 *   and made every reader assume the whole piece was riddled with breaks, which
 *   pushes them toward refusing to cut anything.
 * - The marker says the content will not play, so it is not missing context.
 *   Without that, "something was removed here" reads as "something is hidden
 *   from you", which is the same failure as the cue-number skip.
 */
export function buildPlaybackTranscript(
  projectId: string,
  words: readonly ReturnType<typeof parseTranscriptWords>[number][],
  editList: EditListDocument | null,
): PlaybackTranscript {
  const segments = [...(editList?.segments ?? [])].sort(
    (left, right) => left.timelineStart - right.timelineStart,
  );
  const plays = (word: { start: number; end: number }): boolean => segments.some(
    (segment) => segment.sourceStart < word.end - PLAYBACK_EPSILON
      && segment.sourceEnd > word.start + PLAYBACK_EPSILON,
  );
  const ordered = [...words].sort((left, right) => left.start - right.start);
  const stream: PlaybackTranscriptEntry[] = [];
  let removed: typeof ordered = [];
  for (const word of ordered) {
    if (!plays(word)) {
      removed.push(word);
      continue;
    }
    if (removed.length > 0) {
      const spoken = removed.filter((candidate) => candidate.isGap !== true);
      if (spoken.length > 0) {
        stream.push({
          removedSpeech: spoken.map((candidate) => candidate.text ?? "").join(""),
          seconds: roundSeconds(removed.reduce((total, candidate) => total + (candidate.end - candidate.start), 0)),
        });
      }
      removed = [];
    }
    stream.push({
      id: word.id,
      text: word.text ?? "",
      isGap: word.isGap === true,
      seconds: roundSeconds(word.end - word.start),
    });
  }
  return {
    projectId,
    note: [
      "stream 是按播放顺序铺平的，就是听众实际会听到的全部内容，一个字不缺。",
      "removedSpeech 表示此处原本说过话、已被删除、不会播出——它不是缺失的资料，判断时当它不存在。",
      "被压掉的停顿不做标记，因为那不影响语义。",
      "相邻两个条目播出来就是相邻的：判断重复只看这个顺序，不要用源片秒数。",
    ].join(""),
    totalPlayedSeconds: roundSeconds(
      segments.reduce((total, segment) => total + (segment.sourceEnd - segment.sourceStart), 0),
    ),
    stream,
  };
}

const PLAYBACK_EPSILON = 0.0005;

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

export interface TranscriptTextCorrection {
  wordId: string;
  text: string;
}

export interface CorrectTranscriptTextResult {
  projectId: string;
  path: string;
  previousRevision: string;
  revision: string;
  changed: boolean;
  dryRun: boolean;
  applied: Array<{ wordId: string; from: string; to: string }>;
  /** What the same respelling did to the subtitle screens, if there are any. */
  subtitles: Pick<SubtitleRespellResult, "updated" | "needsAttention">;
  unchanged: number;
}

/**
 * Fix what the transcript says without touching when it says it.
 *
 * A mis-heard proper noun is not surplus speech — deleting the word would leave
 * the sentence short a word, and no amount of cutting can turn "Clock" back into
 * "Grok". So this is the one edit the transcript needs that the cut path cannot
 * express. On a real project it was the difference between subtitles that read
 * `Codex` / `CodeX` / `codex` and subtitles that read one thing.
 *
 * The hard constraint is the whole design: **timing is the ground truth for every
 * cut already made**. Word ids, word count, and every start/end must come out
 * identical. A correction that shifted a single boundary would silently move every
 * downstream deletion off its target, so the write refuses rather than adjusts:
 * an unknown id, a changed count, or any attempt to reach a time field fails.
 */
/**
 * Write the same respelling into `subtitles.json`, when there is one.
 *
 * Best effort by design: correcting a misheard name is worth doing whether or
 * not subtitles exist yet, and a project with no subtitle document is the
 * normal case. What must never happen is a *silent* miss, so anything this
 * cannot rewrite comes back in `needsAttention` rather than being dropped.
 */
async function respellProjectSubtitles(
  project: ResolvedProject,
  applied: ReadonlyArray<{ wordId: string; from: string; to: string }>,
  options: { dryRun?: boolean; actor?: ProjectEventActor },
): Promise<Pick<SubtitleRespellResult, "updated" | "needsAttention">> {
  if (applied.length === 0) return { updated: [], needsAttention: [] };
  const current = await readOptionalJsonAt<SubtitleDocument>(
    documentPath(project, "subtitles.json"),
  );
  if (!current) return { updated: [], needsAttention: [] };
  assertSubtitleDocument(current.value);
  const result = respellSubtitles(current.value, applied);
  if (!options.dryRun && result.updated.length > 0) {
    await atomicWriteText(
      documentPath(project, "subtitles.json"),
      serializeJson(result.document),
    );
  }
  return { updated: result.updated, needsAttention: result.needsAttention };
}

export async function correctTranscriptText(
  project: ResolvedProject,
  corrections: readonly TranscriptTextCorrection[],
  options: { dryRun?: boolean; actor?: ProjectEventActor } = {},
): Promise<CorrectTranscriptTextResult> {
  const apply = async (): Promise<CorrectTranscriptTextResult> => {
    const path = documentPath(project, "transcript.json");
    const previous = await readOptionalJsonAt(path);
    if (!previous) {
      throw new VideocutError("invalid_transcript", "transcript.json does not exist");
    }
    const requested = new Map<string, string>();
    for (const correction of corrections) {
      const wordId = typeof correction.wordId === "string" ? correction.wordId.trim() : "";
      if (!wordId) {
        throw new VideocutError("invalid_transcript", "every correction needs a wordId");
      }
      if (typeof correction.text !== "string") {
        throw new VideocutError("invalid_transcript", `correction for ${wordId} needs text`);
      }
      if (requested.has(wordId)) {
        throw new VideocutError("invalid_transcript", `duplicate correction for ${wordId}`, { wordId });
      }
      requested.set(wordId, correction.text);
    }
    const document = JSON.parse(JSON.stringify(previous.value)) as {
      cues?: Array<{ words?: Array<Record<string, unknown>> }>;
    };
    const applied: Array<{ wordId: string; from: string; to: string }> = [];
    const seen = new Set<string>();
    let unchanged = 0;
    for (const cue of document.cues ?? []) {
      for (const word of cue.words ?? []) {
        const wordId = typeof word.id === "string" ? word.id : "";
        if (!wordId || !requested.has(wordId)) continue;
        seen.add(wordId);
        const next = requested.get(wordId) as string;
        const from = typeof word.text === "string" ? word.text : "";
        if (from === next) {
          unchanged += 1;
          continue;
        }
        word.text = next;
        applied.push({ wordId, from, to: next });
      }
    }
    const missing = [...requested.keys()].filter((wordId) => !seen.has(wordId));
    if (missing.length > 0) {
      throw new VideocutError(
        "invalid_transcript",
        `${missing.length} correction(s) name a word that is not in transcript.json`,
        { unknownWordIds: missing.slice(0, 20) },
      );
    }
    // The timing contract, re-derived from both documents and compared. Cheaper to
    // state as an assertion than to trust, because a violation is silent and
    // catastrophic: every existing cut would land somewhere else.
    const before = parseTranscriptWords(previous.value);
    const after = parseTranscriptWords(document);
    if (before.length !== after.length) {
      throw new VideocutError("invalid_transcript", "a text correction must not change the word count");
    }
    for (let index = 0; index < before.length; index += 1) {
      const left = before[index]!;
      const right = after[index]!;
      if (left.id !== right.id || left.start !== right.start || left.end !== right.end
        || (left.isGap === true) !== (right.isGap === true)) {
        throw new VideocutError(
          "invalid_transcript",
          "a text correction must not change any word id, time or gap flag",
          { wordId: left.id },
        );
      }
    }
    const content = serializeJson(document);
    const revision = sha256(content);
    const changed = revision !== previous.revision;
    // Screens showing a respelled word are corrected in the same breath. Doing
    // it later is not possible: only here are the word ids known, and without
    // them "which screens went stale" degrades to "something moved".
    const subtitles = changed
      ? await respellProjectSubtitles(project, applied, options)
      : { updated: [], needsAttention: [] };
    if (!options.dryRun && changed) {
      await atomicWriteText(path, content);
      await appendProjectEvent(project, {
        type: "transcript_text_corrected",
        actor: options.actor,
        payload: {
          previousRevision: previous.revision,
          revision,
          correctedWordCount: applied.length,
          corrections: applied.slice(0, 40),
          subtitleScreensUpdated: subtitles.updated.length,
        },
      });
    }
    return {
      projectId: project.projectId,
      path,
      previousRevision: previous.revision,
      revision: changed ? revision : previous.revision,
      changed,
      dryRun: Boolean(options.dryRun),
      applied,
      unchanged,
      subtitles,
    };
  };
  if (options.dryRun) return apply();
  return serializeProjectOperation(project.directory, apply);
}

export const LOCAL_DEVELOPMENT_AUTHORIZATION_FILE =
  "development-runtime-authorization.json" as const;

interface InstalledDevelopmentIdentity {
  root: string;
  account: { uid: number | null; username: string };
  platform: NodeJS.Platform;
  arch: string;
  runtime: {
    version: string;
    archiveSha256: string;
    buildId: string;
    treeDigest: string;
  };
  tools: {
    version: string;
    installManifestSha256: string;
    archiveSha256: string;
    treeDigest: string;
    resourcesManifestSha256: string;
  };
}

interface ManagedToolsDoctorResult {
  ok: boolean;
  detail: string;
  executables: Partial<Record<"bun" | "ffmpeg" | "ffprobe", string>>;
  releaseReady: boolean;
  developmentMode: boolean;
  identity?: InstalledDevelopmentIdentity;
}

interface LocalDevelopmentAuthorization extends InstalledDevelopmentIdentity {
  schemaVersion: 1;
  product: "chengfeng-videocut";
  purpose: "local-development-unverified-runtime";
  acknowledged: "UNVERIFIED tools are authorized only for this local development identity";
  authorizedAt: string;
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function exactDigest(value: unknown, length = 64): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

async function readStableSingleLinkJson(path: string, label: string): Promise<{ raw: string; value: unknown }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const raw = await readFile(path, "utf8");
  const after = await lstat(path);
  if (
    !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) throw new Error(`${label} changed while reading`);
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function regularTreeDigest(root: string, label: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update("chengfeng-videocut-regular-tree-v1\0");
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`${label} contains symlink: ${relative}`);
      const permissions = (metadata.mode & 0o777).toString(8).padStart(3, "0");
      if (metadata.isDirectory()) {
        const canonical = await realpath(absolute);
        const escaped = relativePath(root, canonical);
        if (escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
          throw new Error(`${label} directory escaped: ${relative}`);
        }
        digest.update(`d\0${Buffer.byteLength(relative)}\0${relative}\0${permissions}\0`);
        await walk(absolute, relative);
      } else if (metadata.isFile() && metadata.nlink === 1) {
        digest.update(`f\0${Buffer.byteLength(relative)}\0${relative}\0${permissions}\0${metadata.size}\0`);
        const bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (
          !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
          metadata.dev !== after.dev || metadata.ino !== after.ino || metadata.size !== after.size ||
          metadata.mtimeMs !== after.mtimeMs
        ) throw new Error(`${label} file changed while hashing: ${relative}`);
        digest.update(bytes);
      } else {
        throw new Error(`${label} contains hardlink, reparse point or special entry: ${relative}`);
      }
    }
  };
  await walk(root);
  return digest.digest("hex");
}

function managedRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} path is invalid`);
  }
  // Manifests use POSIX separators even when the bundle itself is installed on
  // Windows. Normalize first so a backslash cannot hide an escaping segment on
  // a host with the other path convention.
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(value) || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`${label} path is invalid`);
  return normalized;
}

function managedFilePath(root: string, relative: string, label: string): string {
  const absolute = resolve(root, relative);
  const escaped = relativePath(root, absolute);
  if (
    !escaped || escaped === ".." ||
    escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(escaped)
  ) throw new Error(`${label} escaped tools/current`);
  return absolute;
}

async function stableFileSha256(
  path: string,
  before: { dev: number; ino: number; size: number; mtimeMs: number },
): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = await lstat(path);
  if (
    !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
    after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) throw new Error(`managed tools file changed while hashing: ${path}`);
  return digest.digest("hex");
}

function defaultProductRoot(): string {
  return resolve(join(homedir(), ".chengfeng-videocut"));
}

async function assertLocalDevelopmentRoot(dataDir: string, expectedRoot: string): Promise<string> {
  if (resolve(dataDir) !== resolve(expectedRoot)) {
    throw new Error("local development is authorized only for the default Product root");
  }
  const metadata = await lstat(dataDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("local development Product root must be a regular directory");
  }
  const canonical = await realpath(dataDir);
  const expectedCanonical = await realpath(expectedRoot);
  if (canonical !== expectedCanonical) {
    throw new Error("local development Product root must be canonical");
  }
  return canonical;
}

async function installedDevelopmentIdentity(
  dataDir: string,
  canonicalTools: string,
  resourcesManifestRaw: string,
  toolsVersion: string,
  expectedRoot: string,
): Promise<InstalledDevelopmentIdentity> {
  const canonicalRoot = await assertLocalDevelopmentRoot(dataDir, expectedRoot);
  const installerStateDocument = await readStableSingleLinkJson(
    join(canonicalRoot, "installer-state.json"),
    "installer-state.json",
  );
  const installerState = installerStateDocument.value;
  if (!exactObjectKeys(installerState, [
    "schemaVersion", "transactionId", "phase", "active", "previous", "pending",
    "transaction", "terminationFailure", "updatedAt",
  ])) throw new Error("installer-state.json does not have the exact idle schema");
  if (
    installerState.schemaVersion !== 2 || installerState.phase !== "idle" ||
    installerState.transactionId !== null || installerState.pending !== null || installerState.transaction !== null ||
    (installerState.terminationFailure !== null && installerState.terminationFailure !== undefined)
  ) throw new Error("installer-state.json is not an idle managed Runtime identity");
  const active = installerState.active;
  if (!exactObjectKeys(active, ["version", "path", "archiveSha256", "buildId", "treeDigest"])) {
    throw new Error("installer-state.json active identity is invalid");
  }
  if (
    typeof active.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(active.version) ||
    typeof active.path !== "string" || !exactDigest(active.archiveSha256) ||
    !exactDigest(active.buildId, 16) || !exactDigest(active.treeDigest)
  ) throw new Error("installer-state.json active identity fields are invalid");
  const appCurrent = join(canonicalRoot, "app", "current");
  const appCurrentMetadata = await lstat(appCurrent);
  if (!appCurrentMetadata.isSymbolicLink()) throw new Error("app/current must be a managed symlink or junction");
  const canonicalApp = await realpath(appCurrent);
  if (
    canonicalApp !== await realpath(active.path) ||
    canonicalApp !== join(canonicalRoot, "app", active.version)
  ) throw new Error("app/current does not match installer-state.json active identity");
  const appVersion = (await readFile(join(canonicalApp, "VERSION"), "utf8")).split(/\r?\n/, 1)[0];
  if (appVersion !== active.version || appVersion !== toolsVersion) {
    throw new Error("app/current, installer state and managed tools versions do not match");
  }
  if (await regularTreeDigest(canonicalApp, "app/current") !== active.treeDigest) {
    throw new Error("app/current tree digest does not match installer-state.json");
  }

  const toolsStateDocument = await readStableSingleLinkJson(
    join(canonicalRoot, "managed-tools-state.json"),
    "managed-tools-state.json",
  );
  const toolsState = toolsStateDocument.value;
  if (!exactObjectKeys(toolsState, [
    "schemaVersion", "productVersion", "platformKey", "manifestSha256", "archiveSha256",
    "path", "treeDigest", "updatedAt",
  ])) throw new Error("managed-tools-state.json identity is invalid");
  if (
    toolsState.schemaVersion !== 1 || toolsState.productVersion !== toolsVersion ||
    typeof toolsState.platformKey !== "string" || typeof toolsState.path !== "string" ||
    await realpath(toolsState.path) !== canonicalTools || !exactDigest(toolsState.manifestSha256) ||
    !exactDigest(toolsState.archiveSha256) || !exactDigest(toolsState.treeDigest)
  ) throw new Error("managed-tools-state.json identity fields are invalid");
  if (await regularTreeDigest(canonicalTools, "tools/current") !== toolsState.treeDigest) {
    throw new Error("tools/current tree digest does not match managed-tools-state.json");
  }

  return {
    root: canonicalRoot,
    account: {
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      username: userInfo().username,
    },
    platform: process.platform,
    arch: process.arch,
    runtime: {
      version: active.version,
      archiveSha256: active.archiveSha256,
      buildId: active.buildId,
      treeDigest: active.treeDigest,
    },
    tools: {
      version: toolsVersion,
      installManifestSha256: toolsState.manifestSha256,
      archiveSha256: toolsState.archiveSha256,
      treeDigest: toolsState.treeDigest,
      resourcesManifestSha256: sha256(resourcesManifestRaw),
    },
  };
}

function sameIdentityRecord(actual: unknown, expected: Record<string, string | number | null>): boolean {
  if (!exactObjectKeys(actual, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function validateLocalDevelopmentAuthorization(
  identity: InstalledDevelopmentIdentity,
): Promise<void> {
  const authorizationPath = join(identity.root, LOCAL_DEVELOPMENT_AUTHORIZATION_FILE);
  const metadata = await lstat(authorizationPath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) throw new Error("local development authorization must be a mode 0600 single-link regular file");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("local development authorization must be owned by the current account");
  }
  const document = await readStableSingleLinkJson(authorizationPath, "local development authorization");
  const authorization = document.value;
  if (!exactObjectKeys(authorization, [
    "schemaVersion", "product", "purpose", "acknowledged", "authorizedAt", "root", "account",
    "platform", "arch", "runtime", "tools",
  ])) throw new Error("local development authorization schema is invalid");
  if (
    authorization.schemaVersion !== 1 || authorization.product !== "chengfeng-videocut" ||
    authorization.purpose !== "local-development-unverified-runtime" ||
    authorization.acknowledged !==
      "UNVERIFIED tools are authorized only for this local development identity" ||
    typeof authorization.authorizedAt !== "string" || !Number.isFinite(Date.parse(authorization.authorizedAt)) ||
    authorization.root !== identity.root || authorization.platform !== identity.platform ||
    authorization.arch !== identity.arch ||
    !sameIdentityRecord(authorization.account, identity.account) ||
    !sameIdentityRecord(authorization.runtime, identity.runtime) ||
    !sameIdentityRecord(authorization.tools, identity.tools)
  ) throw new Error("local development authorization does not match the installed Runtime identity");
}

async function inspectInstalledManagedTools(
  dataDir: string,
  options: { localDevelopment: boolean; expectedProductRoot: string; skipAuthorization?: boolean },
): Promise<ManagedToolsDoctorResult> {
  const toolsRoot = resolve(dataDir, "tools");
  const current = join(toolsRoot, "current");
  try {
    const currentLinkMetadata = await lstat(current);
    if (!currentLinkMetadata.isSymbolicLink()) {
      throw new Error("tools/current must be a managed symlink or junction");
    }
    const [canonicalToolsRoot, canonicalCurrent] = await Promise.all([
      realpath(toolsRoot),
      realpath(current),
    ]);
    const relativeCurrent = relativePath(canonicalToolsRoot, canonicalCurrent);
    if (
      !relativeCurrent || relativeCurrent === ".." ||
      relativeCurrent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeCurrent) || relativeCurrent.split(/[\\/]/).length !== 1 ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(relativeCurrent)
    ) throw new Error("tools/current does not target an exact managed version directory");
    const currentMetadata = await lstat(canonicalCurrent);
    if (!currentMetadata.isDirectory() || currentMetadata.isSymbolicLink()) {
      throw new Error("tools/current target is not a regular directory");
    }
    const manifestPath = join(canonicalCurrent, "resources-manifest.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      schemaVersion?: number;
      product?: string;
      productVersion?: string;
      platform?: string;
      arch?: string;
      distributionMode?: string;
      licenseStatus?: string;
      executables?: Record<string, string>;
      files?: Array<{ path?: string; size?: number; sha256?: string }>;
      resources?: unknown;
    };
    const schemaVersion = manifest.schemaVersion;
    if (
      schemaVersion !== 4 ||
      manifest.product !== "chengfeng-videocut-managed-tools" ||
      manifest.platform !== process.platform || manifest.arch !== process.arch ||
      !manifest.executables || !Array.isArray(manifest.files)
    ) throw new Error("resources-manifest is not VERIFIED/release-ready for this platform");
    const releaseReady =
      manifest.distributionMode === "release-ready" && manifest.licenseStatus === "VERIFIED";
    const localDevelopmentEligible =
      manifest.distributionMode === "local-test-only" && manifest.licenseStatus === "UNVERIFIED";
    if (!releaseReady && !(options.localDevelopment && localDevelopmentEligible)) {
      throw new Error("resources-manifest is not VERIFIED/release-ready for this platform");
    }
    if (!releaseReady && !localDevelopmentEligible) {
      throw new Error("resources-manifest trust state is not an allowed Product combination");
    }
    if (Object.hasOwn(manifest, "resources")) {
      throw new Error("schema 4 resources-manifest must not include renderer resources");
    }
    const requiredExecutables = ["bun", "ffmpeg", "ffprobe"] as const;
    if (Object.keys(manifest.executables).sort().join(",") !== requiredExecutables.join(",")) {
      throw new Error("schema 4 resources-manifest must expose only bun, ffmpeg and ffprobe");
    }
    const runtimeVersion = (await readFile(join(dataDir, "app", "current", "VERSION"), "utf8"))
      .split(/\r?\n/, 1)[0];
    if (!runtimeVersion || manifest.productVersion !== runtimeVersion) {
      throw new Error("managed tools version does not match app/current");
    }
    const actualFiles = new Map<string, { size: number; sha256: string }>();
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) throw new Error(`managed tools contain symlink: ${relative}`);
        if (metadata.isDirectory()) {
          const canonical = await realpath(absolute);
          const escaped = relativePath(canonicalCurrent, canonical);
          if (escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
            throw new Error(`managed tools directory escaped: ${relative}`);
          }
          await walk(absolute, relative);
        } else if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new Error(`managed tools contain hardlink/reparse/special entry: ${relative}`);
        } else if (relative !== "resources-manifest.json") {
          actualFiles.set(relative.replaceAll("\\", "/"), {
            size: metadata.size,
            sha256: await stableFileSha256(absolute, metadata),
          });
        }
      }
    };
    await walk(canonicalCurrent);
    if (actualFiles.size !== manifest.files.length) throw new Error("managed tools file count drifted");
    const seen = new Set<string>();
    for (const record of manifest.files) {
      if (
        typeof record.path !== "string" || seen.has(record.path) ||
        !Number.isSafeInteger(record.size) || typeof record.sha256 !== "string"
      ) throw new Error("managed tools manifest contains an invalid file record");
      seen.add(record.path);
      const actual = actualFiles.get(record.path);
      if (!actual || actual.size !== record.size || actual.sha256 !== record.sha256) {
        throw new Error(`managed tools content drifted: ${record.path}`);
      }
    }
    const executables: ManagedToolsDoctorResult["executables"] = {};
    for (const key of requiredExecutables) {
      const relative = managedRelativePath(manifest.executables[key], `managed ${key}`);
      const executable = managedFilePath(canonicalCurrent, relative, `managed ${key}`);
      const canonicalExecutable = await realpath(executable);
      const escaped = relativePath(canonicalCurrent, canonicalExecutable);
      if (!escaped || escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`managed ${key} escaped tools/current`);
      }
      const metadata = await lstat(executable);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error(`managed ${key} is not a single-link regular file`);
      }
      await access(executable, process.platform === "win32" ? fsConstants.R_OK : fsConstants.R_OK | fsConstants.X_OK);
      executables[key] = executable;
    }
    if (await realpath(process.execPath) !== await realpath(executables.bun!)) {
      throw new Error("Runtime was not launched by tools/current managed Bun");
    }
    const identity = releaseReady
      ? undefined
      : await installedDevelopmentIdentity(
        dataDir,
        canonicalCurrent,
        manifestRaw,
        manifest.productVersion!,
        options.expectedProductRoot,
      );
    if (identity && !options.skipAuthorization) await validateLocalDevelopmentAuthorization(identity);
    return {
      ok: true,
      detail: releaseReady
        ? `VERIFIED ${manifest.productVersion} at ${canonicalCurrent}`
        : `authorized local development ${manifest.productVersion} at ${canonicalCurrent}; NOT release-ready`,
      executables,
      releaseReady,
      developmentMode: !releaseReady,
      ...(identity ? { identity } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      executables: {},
      releaseReady: false,
      developmentMode: false,
    };
  }
}

export async function authorizeLocalDevelopmentRuntime(options: {
  acknowledged: boolean;
  dataDir?: string;
  expectedProductRoot?: string;
}): Promise<{ path: string; authorization: LocalDevelopmentAuthorization }> {
  if (!options.acknowledged) {
    throw new Error(
      "authorization requires --acknowledge-unverified-local-runtime; this does not make the Runtime release-ready",
    );
  }
  const expectedProductRoot = resolve(options.expectedProductRoot ?? defaultProductRoot());
  const dataDir = resolve(options.dataDir ?? productHomeDir());
  const inspected = await inspectInstalledManagedTools(dataDir, {
    localDevelopment: true,
    expectedProductRoot,
    skipAuthorization: true,
  });
  if (!inspected.ok || inspected.releaseReady || !inspected.developmentMode || !inspected.identity) {
    throw new Error(`installed Runtime is not an exact local-test-only development identity: ${inspected.detail}`);
  }
  const authorization: LocalDevelopmentAuthorization = {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    purpose: "local-development-unverified-runtime",
    acknowledged: "UNVERIFIED tools are authorized only for this local development identity",
    authorizedAt: new Date().toISOString(),
    ...inspected.identity,
  };
  const target = join(inspected.identity.root, LOCAL_DEVELOPMENT_AUTHORIZATION_FILE);
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error("existing local development authorization is not a single-link regular file");
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await atomicWriteText(target, serializeJson(authorization));
  await chmod(target, 0o600);
  await validateLocalDevelopmentAuthorization(inspected.identity);
  return { path: target, authorization };
}

export async function doctor(
  options: Pick<ProjectResolutionOptions, "projectsDir"> & {
    localDevelopment?: boolean;
    /** Test seam only. The CLI never overrides the canonical default Product root. */
    expectedProductRoot?: string;
  } = {},
): Promise<{
  healthy: boolean;
  developmentMode: boolean;
  releaseReady: boolean;
  readinessMode: "release-ready" | "local-development" | "source-development" | "unready";
  capabilities: DoctorCapabilities;
  checks: DoctorCheck[];
}> {
  const projectsDir = resolve(options.projectsDir ?? defaultProjectsDir());
  const productRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const packagedStudioIndex = fileURLToPath(new URL("./studio/index.html", import.meta.url));
  const sourceStudioPackage = join(productRoot, "apps/studio/package.json");
  const installedMode = Boolean(process.env.CHENGFENG_VIDEOCUT_EXECUTABLE);
  const managedTools: ManagedToolsDoctorResult = installedMode
    ? await inspectInstalledManagedTools(productHomeDir(), {
      localDevelopment: options.localDevelopment === true,
      expectedProductRoot: resolve(options.expectedProductRoot ?? defaultProductRoot()),
    })
    : options.localDevelopment
      ? {
        ok: false,
        detail: "local development authorization applies only to the installed default Product Runtime",
        executables: {},
        releaseReady: false,
        developmentMode: false,
      }
      : {
        ok: true,
        detail: "source-development PATH fallback",
        executables: {},
        releaseReady: false,
        developmentMode: false,
      };
  const [sourceFfmpeg, sourceFfprobe, registryExists, studioExists, transcription] = await Promise.all([
    installedMode ? Promise.resolve(null) : findExecutable("ffmpeg"),
    installedMode ? Promise.resolve(null) : findExecutable("ffprobe"),
    existingDirectory(projectsDir),
    Promise.all([pathExists(packagedStudioIndex), pathExists(sourceStudioPackage)]).then(
      ([packaged, source]) => packaged || source,
    ),
    resolveTranscriptionCredentials(),
  ]);
  const ffmpeg = installedMode ? managedTools.executables.ffmpeg ?? null : sourceFfmpeg;
  const ffprobe = installedMode ? managedTools.executables.ffprobe ?? null : sourceFfprobe;
  const bunVersion = (
    globalThis as typeof globalThis & { Bun?: { version?: string } }
  ).Bun?.version ?? null;
  const checks: DoctorCheck[] = [
    {
      name: "dependencyMode",
      ok: managedTools.ok,
      required: true,
      detail: managedTools.detail,
    },
    {
      name: "runtime",
      ok: Boolean(bunVersion) && managedTools.ok,
      required: true,
      detail: bunVersion
        ? installedMode
          ? `Managed Bun ${bunVersion}`
          : `Bun ${bunVersion} (source-development fallback)`
        : "Bun is required",
    },
    {
      name: "studio",
      ok: studioExists,
      required: true,
      detail: studioExists
        ? (await pathExists(packagedStudioIndex))
          ? packagedStudioIndex
          : sourceStudioPackage
        : "Studio assets are missing",
    },
    {
      name: "projectRegistry",
      ok: Boolean(registryExists),
      required: false,
      detail: registryExists ? projectsDir : `${projectsDir} (created by start)`,
    },
    {
      name: "ffmpeg",
      ok: Boolean(ffmpeg),
      required: true,
      detail: ffmpeg ?? "ffmpeg was not found on PATH",
    },
    {
      name: "ffprobe",
      ok: Boolean(ffprobe),
      required: true,
      detail: ffprobe ?? "ffprobe was not found on PATH",
    },
    {
      // Documented in four contracts and checked nowhere: a machine without the
      // credential looked healthy right up to the moment a transcription failed
      // with "missing adapter", which reads like a product fault. Say it here,
      // before anything is spent on extracting audio.
      name: "cloudTranscription",
      ok: Boolean(transcription.apiKey),
      // Reported, not enforced. `healthy` gates every Skill's preflight, and a
      // machine with existing projects needs no credential to open, cut or
      // subtitle any of them — only to transcribe a new one. Blocking all of
      // that would trade one clear failure for a much larger one.
      required: false,
      detail: transcription.apiKey
        ? `已配置（${productConfigPath()} 或环境变量）`
        : `未配置。设置：chengfeng-videocut config set transcription.apiKey <值>`,
    },
  ];
  const healthy = checks.every((check) => !check.required || check.ok);
  const readinessMode = !healthy
    ? "unready" as const
    : managedTools.releaseReady
      ? "release-ready" as const
      : managedTools.developmentMode
        ? "local-development" as const
        : "source-development" as const;
  return {
    healthy,
    developmentMode: healthy && managedTools.developmentMode,
    releaseReady: healthy && managedTools.releaseReady,
    readinessMode,
    capabilities: RUNTIME_DOCTOR_CAPABILITIES,
    checks,
  };
}
