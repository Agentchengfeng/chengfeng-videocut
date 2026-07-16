import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCutSelectionFromProposal,
  buildCutTimeRanges,
  hasSameCutSelectionMeaning,
  parseTranscriptWords,
  totalCutDuration,
  type CutSelectionDocument,
  type JsonObject,
} from "./cuts";
import { VideocutError } from "./errors";

export const PROJECT_DOCUMENT_NAMES = [
  "project.json",
  "transcript.json",
  "cut-selection.json",
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

const projectWriteQueues = new Map<string, Promise<void>>();

async function serializeProjectWrite<T>(
  projectDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectWriteQueues.get(projectDirectory) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  projectWriteQueues.set(projectDirectory, tail);
  void tail.then(() => {
    if (projectWriteQueues.get(projectDirectory) === tail) {
      projectWriteQueues.delete(projectDirectory);
    }
  });
  return result;
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
  const [transcript, cuts, visualPlan, workbench] = await Promise.all([
    readOptionalProjectDocument(project, "transcript.json"),
    readOptionalProjectDocument(project, "cut-selection.json"),
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

export interface WriteCutSelectionOptions {
  expectedRevision?: string;
  dryRun?: boolean;
  now?: string;
}

export interface WriteCutSelectionResult {
  projectId: string;
  path: string;
  previousRevision: string | null;
  revision: string;
  changed: boolean;
  dryRun: boolean;
  document: CutSelectionDocument;
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

  const document = buildCutSelectionFromProposal(
    words,
    proposal,
    previous?.value,
    options.now ?? new Date().toISOString(),
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
 * Mutating writes are serialized per project inside this process so two callers
 * cannot both commit from the same expected revision. A dry run deliberately
 * skips that queue: it is an advisory snapshot and does not reserve the returned
 * revision for a later write.
 */
export async function writeCutSelection(
  project: ResolvedProject,
  proposal: unknown,
  options: WriteCutSelectionOptions = {},
): Promise<WriteCutSelectionResult> {
  const operation = () => writeCutSelectionSnapshot(project, proposal, options);
  if (options.dryRun) return operation();
  return serializeProjectWrite(project.directory, operation);
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

async function findExecutable(name: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = join(pathEntry, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export async function doctor(
  options: Pick<ProjectResolutionOptions, "projectsDir"> = {},
): Promise<{ healthy: boolean; checks: DoctorCheck[] }> {
  const projectsDir = resolve(options.projectsDir ?? defaultProjectsDir());
  const productRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const packagedStudioIndex = fileURLToPath(new URL("./studio/index.html", import.meta.url));
  const sourceStudioPackage = join(productRoot, "apps/studio/package.json");
  const [ffmpeg, ffprobe, registryExists, studioExists] = await Promise.all([
    findExecutable("ffmpeg"),
    findExecutable("ffprobe"),
    existingDirectory(projectsDir),
    Promise.all([pathExists(packagedStudioIndex), pathExists(sourceStudioPackage)]).then(
      ([packaged, source]) => packaged || source,
    ),
  ]);
  const bunVersion = (
    globalThis as typeof globalThis & { Bun?: { version?: string } }
  ).Bun?.version ?? null;
  const checks: DoctorCheck[] = [
    {
      name: "runtime",
      ok: Boolean(bunVersion),
      required: true,
      detail: bunVersion ? `Bun ${bunVersion}` : "Bun is required",
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
  ];
  return {
    healthy: checks.every((check) => !check.required || check.ok),
    checks,
  };
}
