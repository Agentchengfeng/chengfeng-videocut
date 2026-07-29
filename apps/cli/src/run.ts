import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VideocutError, asVideocutError, parseTranscriptWords } from "@video-workbench/core";
import {
  createKouboProject,
  exportFilm,
  prepareKouboProject,
  probeMedia,
  putKouboArtifact,
  runKouboRender,
  alignScriptToWords,
  matchDictionary,
  regroupKouboTranscript,
  parseDictionary,
  transcribeKouboVideo,
  transcribeProjectCut,
  type KouboArtifactType,
  type RunKouboRenderOptions,
  type TranscribeKouboVideoResult,
} from "@video-workbench/koubo-adapter";
import {
  buildExportPlan,
  createVisualDocument,
  sourceTimeForCutTime,
  subtitleCueTimings,
  subtitleStaleness,
  visualLayerTimings,
  type SubtitleDocument,
} from "@video-workbench/core";
import type { ConfigFieldPath } from "@video-workbench/core";
import {
  buildPlaybackTranscript,
  buildProjectSubtitles,
  inspectProductConfig,
  productConfigPath,
  resolveTranscriptionCredentials,
  writeProductSetting,
  correctTranscriptText,
  doctor,
  inspectProject,
  projectUrl,
  readEditList,
  readOptionalProjectDocument,
  readProjectDocument,
  readSubtitleState,
  readSubtitles,
  readVisuals,
  registerProject,
  resolveProject,
  writeCutSelection,
  writeSubtitles,
  writeVisuals,
} from "@video-workbench/core/node";
import { parseArgs, type CliCommand } from "./args";
import { openBrowser as defaultOpenBrowser } from "./server/open-browser";
import {
  startStudioServer as defaultStartStudioServer,
  type RunningStudioServer,
  type StartStudioServerOptions,
} from "./server/start";
import {
  BRAND_NAME,
  HELP_TEXT,
  PRODUCT_VERSION,
  errorEnvelope,
  humanDoctor,
  humanService,
  successEnvelope,
} from "./output";
import {
  runStudioServiceCommand as defaultRunStudioServiceCommand,
  type StudioServiceAction,
  type StudioServiceCommandResult,
} from "./service";

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface RunCliOptions {
  cwd?: string;
  io?: CliIo;
  startServer?: (options: StartStudioServerOptions) => Promise<RunningStudioServer>;
  openBrowser?: (url: string) => Promise<void>;
  runRender?: CliRenderRunner;
  runServiceCommand?: (
    action: StudioServiceAction,
    options?: { lines?: number },
  ) => Promise<StudioServiceCommandResult>;
  runTranscription?: (
    jobDir: string,
    options: { video: string; output: string; language?: string },
  ) => Promise<TranscribeKouboVideoResult>;
  /** Injectable so the CLI can be exercised without calling the cloud. */
  runCutTranscription?: typeof transcribeProjectCut;
}

interface CliRenderResult {
  directory: string;
  status: string;
  revision: string;
  previousRevision: string;
  finalVideoPath: string;
  verificationPath: string;
  verification: {
    passed: boolean;
    aspectRatio: string;
    frames: {
      global: unknown[];
      htmlScenes: unknown[];
      unique: unknown[];
    };
  };
}

type CliRenderRunner = (
  jobDir: string,
  options: RunKouboRenderOptions,
) => Promise<CliRenderResult>;

interface CliFailure extends Error {
  code: string;
  details?: Record<string, unknown>;
}

class CliRequestError extends Error implements CliFailure {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliRequestError";
    this.code = code;
    this.details = details;
  }
}

const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
};

function exitCodeFor(error: CliFailure): number {
  switch (error.code) {
    case "invalid_argument":
    case "confirmation_required":
    case "revision_required":
      return 2;
    case "project_not_found":
      return 3;
    case "invalid_project":
    case "invalid_json":
    case "invalid_transcript":
    case "invalid_cut_selection":
    case "invalid_config":
    case "studio_origin_required":
    case "media_has_no_audio":
    case "missing_cloud_transcription_adapter":
    case "cloud_transcription_failed":
      return 4;
    case "revision_conflict":
    case "project_id_conflict":
    case "invalid_state":
    case "missing_artifact":
      return 5;
    case "service_unavailable":
    case "service_unsupported":
    case "service_not_installed":
    case "service_launcher_missing":
    case "service_port_conflict":
    case "service_busy":
      return 6;
    case "missing_renderer":
      return 7;
    case "render_failed":
      return 8;
    case "verification_failed":
      return 9;
    default:
      return 10;
  }
}

function normalizeCliError(error: unknown): CliFailure {
  if (
    error instanceof Error &&
    typeof (error as Partial<CliFailure>).code === "string"
  ) {
    return error as CliFailure;
  }
  return asVideocutError(error);
}

function configuredProjectsDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.CHENGFENG_VIDEOCUT_PROJECTS_DIR) {
    return resolve(process.env.CHENGFENG_VIDEOCUT_PROJECTS_DIR);
  }
  if (process.env.VIDEO_WORKBENCH_PROJECTS_DIR) {
    return resolve(process.env.VIDEO_WORKBENCH_PROJECTS_DIR);
  }
  const dataDir = resolve(
    process.env.CHENGFENG_VIDEOCUT_DATA_DIR ?? join(homedir(), ".chengfeng-videocut"),
  );
  return join(dataDir, "projects");
}

async function readProposal(file: string, cwd: string): Promise<unknown> {
  const path = resolve(cwd, file);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VideocutError("invalid_argument", `Cannot read --file ${path}: ${message}`, {
      path,
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new VideocutError("invalid_json", `Invalid JSON in --file: ${path}`, { path });
  }
}

/**
 * The declared reason for each group of cut words, passed through untouched.
 * Core validates the shape and narrows it to words actually cut; the CLI's only
 * job is to not lose it.
 */
function proposalReasons(proposal: unknown): unknown {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return undefined;
  const reasons = (proposal as Record<string, unknown>).reasons;
  if (reasons === undefined) return undefined;
  if (!Array.isArray(reasons)) {
    throw new VideocutError("invalid_cut_selection", "reasons must be an array when present");
  }
  return reasons;
}

function proposalCutWordIds(proposal: unknown): unknown[] {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new VideocutError("invalid_cut_selection", "cut-selection input must be a JSON object");
  }
  const cutWordIds = (proposal as Record<string, unknown>).cutWordIds;
  if (!Array.isArray(cutWordIds)) {
    throw new VideocutError(
      "invalid_cut_selection",
      "cut-selection input must contain cutWordIds as an array",
    );
  }
  return cutWordIds;
}

interface CutsApiResult {
  projectId: string;
  changed: boolean;
  previousRevision: string;
  revision: string;
  document: {
    cutWordIds: unknown[];
    cutRanges: unknown[];
  };
}

interface CutsReadApiResult {
  projectId: string;
  exists: boolean;
  revision: string;
  document: Record<string, unknown> | null;
}

function apiEndpoint(apiBase: string, projectId: string): string {
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    throw new VideocutError("invalid_argument", `Invalid --api-base URL: ${apiBase}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new VideocutError(
      "invalid_argument",
      `--api-base must use http or https: ${apiBase}`,
    );
  }
  base.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/cuts`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function projectApiEndpoint(
  apiBase: string,
  projectId: string,
  resource: "workflow" | "actions" | "edit-list",
): string {
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    throw new VideocutError("invalid_argument", `Invalid --api-base URL: ${apiBase}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new VideocutError("invalid_argument", `--api-base must use http or https: ${apiBase}`);
  }
  base.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/${resource}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface EditListApiResult {
  projectId: string;
  exists?: boolean;
  changed?: boolean;
  previousRevision?: string;
  revision: string;
  document: Record<string, unknown> | null;
}

/**
 * Read or write the edit list over the same HTTP resource the editor uses.
 *
 * The CLI deliberately owns no edit-list writing logic of its own: a segment
 * level change must pass the same geometry checks, the same CAS and the same
 * project lock whether it came from a pointer drag or from an agent. Before
 * this existed there was no sanctioned CLI path at all, so an agent facing a
 * manual timeline had nothing left but to edit project files directly.
 */
async function requestEditListApi(options: {
  apiBase: string;
  projectId: string;
  method: "GET" | "PATCH";
  expectedRevision?: string;
  operation?: unknown;
}): Promise<EditListApiResult> {
  const endpoint = projectApiEndpoint(options.apiBase, options.projectId, "edit-list");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: options.method,
      headers: options.method === "PATCH"
        ? { "Content-Type": "application/json" }
        : { Accept: "application/json" },
      body: options.method === "PATCH"
        ? JSON.stringify({
            expectedRevision: options.expectedRevision,
            operation: options.operation,
            // Declared so the project's event log can tell a CLI edit apart from
            // one made in a browser pane. It is a declaration, not a proof.
            actor: "cli",
          })
        : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new CliRequestError(
      "service_unavailable",
      `Cannot reach chengfeng-videocut at ${options.apiBase}`,
      { endpoint, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliRequestError(
      "service_unavailable",
      `chengfeng-videocut returned an invalid response (${response.status})`,
      { endpoint, status: response.status },
    );
  }
  const record = objectRecord(payload);
  if (!response.ok) {
    const errorRecord = objectRecord(record?.error);
    throw new CliRequestError(
      typeof errorRecord?.code === "string" ? errorRecord.code : "service_unavailable",
      typeof errorRecord?.message === "string"
        ? errorRecord.message
        : `chengfeng-videocut request failed (${response.status})`,
      objectRecord(errorRecord?.details) ?? { endpoint, status: response.status },
    );
  }
  if (!record || typeof record.revision !== "string") {
    throw new CliRequestError(
      "service_unavailable",
      "chengfeng-videocut returned an unexpected edit-list payload",
      { endpoint },
    );
  }
  return {
    projectId: options.projectId,
    exists: typeof record.exists === "boolean" ? record.exists : undefined,
    changed: typeof record.changed === "boolean" ? record.changed : undefined,
    previousRevision: typeof record.previousRevision === "string"
      ? record.previousRevision
      : undefined,
    revision: record.revision,
    document: objectRecord(record.document),
  };
}

async function readCutsThroughApi(options: {
  apiBase: string;
  projectId: string;
}): Promise<CutsReadApiResult> {
  const endpoint = apiEndpoint(options.apiBase, options.projectId);
  let response: Response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new CliRequestError(
      "service_unavailable",
      `Cannot reach chengfeng-videocut at ${options.apiBase}`,
      { endpoint, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliRequestError(
      "service_unavailable",
      `chengfeng-videocut returned an invalid response (${response.status})`,
      { endpoint, status: response.status },
    );
  }
  const record = objectRecord(payload);
  if (!response.ok) {
    const errorRecord = objectRecord(record?.error);
    throw new CliRequestError(
      typeof errorRecord?.code === "string" ? errorRecord.code : "service_unavailable",
      typeof errorRecord?.message === "string"
        ? errorRecord.message
        : `chengfeng-videocut request failed (${response.status})`,
      objectRecord(errorRecord?.details) ?? { endpoint, status: response.status },
    );
  }

  const revision = record?.revision;
  const exists = record?.exists;
  const document = objectRecord(record?.document);
  const validDocument = exists === false
    ? record?.document === null
    : exists === true && document !== null &&
      Array.isArray(document.cutWordIds) && Array.isArray(document.cutRanges);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.projectId !== options.projectId ||
    typeof exists !== "boolean" ||
    typeof revision !== "string" ||
    !/^(?:none|[a-f0-9]{64})$/.test(revision) ||
    !validDocument
  ) {
    throw new CliRequestError(
      "service_unavailable",
      "chengfeng-videocut returned an incompatible cuts response",
      { endpoint, status: response.status },
    );
  }
  return {
    projectId: options.projectId,
    exists,
    revision,
    document: exists ? document : null,
  };
}

async function updateCutsThroughApi(options: {
  apiBase: string;
  projectId: string;
  expectedRevision: string;
  cutWordIds: unknown[];
  reasons?: unknown;
}): Promise<CutsApiResult> {
  const endpoint = apiEndpoint(options.apiBase, options.projectId);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: options.expectedRevision,
        cutWordIds: options.cutWordIds,
        mode: "semantic-overlay",
        // Carry the declared reason through. Dropping it here is what left
        // "why was this deleted" unanswerable for every deletion ever made.
        ...(options.reasons === undefined ? {} : { reasons: options.reasons }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliRequestError(
      "service_unavailable",
      `Cannot reach chengfeng-videocut at ${options.apiBase}`,
      { endpoint, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliRequestError(
      "service_unavailable",
      `chengfeng-videocut returned an invalid response (${response.status})`,
      { endpoint, status: response.status },
    );
  }
  const record = objectRecord(payload);
  if (!response.ok) {
    const errorRecord = objectRecord(record?.error);
    throw new CliRequestError(
      typeof errorRecord?.code === "string" ? errorRecord.code : "service_unavailable",
      typeof errorRecord?.message === "string"
        ? errorRecord.message
        : `chengfeng-videocut request failed (${response.status})`,
      objectRecord(errorRecord?.details) ?? { endpoint, status: response.status },
    );
  }
  const document = objectRecord(record?.document);
  const revisionPattern = /^[a-f0-9]{64}$/;
  const previousRevision = record?.previousRevision;
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.projectId !== options.projectId ||
    typeof record.changed !== "boolean" ||
    typeof record.revision !== "string" ||
    !revisionPattern.test(record.revision) ||
    typeof previousRevision !== "string" ||
    !(previousRevision === "none" || revisionPattern.test(previousRevision)) ||
    !document ||
    !Array.isArray(document.cutWordIds) ||
    !Array.isArray(document.cutRanges)
  ) {
    throw new CliRequestError(
      "service_unavailable",
      "chengfeng-videocut returned an incompatible cuts response",
      { endpoint, status: response.status },
    );
  }
  return {
    projectId: record.projectId,
    changed: record.changed,
    previousRevision,
    revision: record.revision,
    document: {
      cutWordIds: document.cutWordIds,
      cutRanges: document.cutRanges,
    },
  };
}

async function requestWorkflowApi(options: {
  apiBase: string;
  projectId: string;
  action?: string;
  expectedRevision?: string;
  expectedEditListRevision?: string;
  config?: unknown;
}): Promise<Record<string, unknown>> {
  if (options.action === "apply-cut") {
    if (options.expectedEditListRevision === undefined) {
      throw new CliRequestError(
        "revision_required",
        "apply-cut requires the edit-list revision captured at confirmation",
        { reason: "missing_confirmed_edit_list_revision" },
      );
    }
    if (!/^[a-f0-9]{64}$/.test(options.expectedEditListRevision)) {
      throw new CliRequestError(
        "revision_required",
        "apply-cut requires a prepared edit-list.json revision",
        { reason: "edit_list_required" },
      );
    }
  }
  const endpoint = projectApiEndpoint(
    options.apiBase,
    options.projectId,
    options.action ? "actions" : "workflow",
  );
  let response: Response;
  try {
    response = await fetch(endpoint, options.action ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: options.action,
        confirmed: true,
        expectedRevision: options.expectedRevision,
        ...(options.expectedEditListRevision !== undefined
          ? { expectedEditListRevision: options.expectedEditListRevision }
          : {}),
        ...(options.config !== undefined ? { config: options.config } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    } : {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliRequestError(
      "service_unavailable",
      `Cannot reach chengfeng-videocut at ${options.apiBase}`,
      { endpoint, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliRequestError(
      "service_unavailable",
      `chengfeng-videocut returned an invalid response (${response.status})`,
      { endpoint, status: response.status },
    );
  }
  const record = objectRecord(payload);
  if (!response.ok) {
    const errorRecord = objectRecord(record?.error);
    throw new CliRequestError(
      typeof errorRecord?.code === "string" ? errorRecord.code : "service_unavailable",
      typeof errorRecord?.message === "string"
        ? errorRecord.message
        : `chengfeng-videocut request failed (${response.status})`,
      objectRecord(errorRecord?.details) ?? { endpoint, status: response.status },
    );
  }
  if (!record || record.schemaVersion !== 1 || record.projectId !== options.projectId ||
      typeof record.revision !== "string" || !/^[a-f0-9]{64}$/.test(record.revision) ||
      typeof record.editListRevision !== "string" ||
      !/^(?:none|[a-f0-9]{64})$/.test(record.editListRevision) ||
      !objectRecord(record.project)) {
    throw new CliRequestError(
      "service_unavailable",
      "chengfeng-videocut returned an incompatible workflow response",
      { endpoint, status: response.status },
    );
  }
  return record;
}

async function assertRegisteredProject(input: {
  project: Awaited<ReturnType<typeof resolveProject>>;
  cwd: string;
  projectsDir: string;
  outputDir?: string;
}): Promise<void> {
  const registered = await resolveProject(input.project.projectId, {
    cwd: input.cwd,
    projectsDir: input.projectsDir,
    outputDir: input.outputDir ?? input.projectsDir,
  });
  if (registered.directory !== input.project.directory) {
    throw new VideocutError(
      "project_id_conflict",
      `Registered project id points to another directory: ${input.project.projectId}`,
      { registered: registered.directory, requested: input.project.directory },
    );
  }
}

function projectInput(command: CliCommand, value: string | undefined): string {
  if (value) return value;
  throw new VideocutError("invalid_argument", `${command} requires a project`);
}

/**
 * One frame of the original file, written where a person or an Agent can open
 * it.
 *
 * `-ss` before `-i` seeks by keyframe index rather than decoding forward, which
 * is the difference between milliseconds and a minute on a long file. The cost
 * is landing on the nearest keyframe; for judging what is in the picture — is
 * there empty space, where is the content, what would a layer cover — that is
 * exact enough, and the alternative is a tool nobody waits for.
 */
async function extractFrame(source: string, time: number, target: string): Promise<void> {
  await new Promise<void>((settle, fail) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", time.toFixed(3),
      "-i", source,
      "-frames:v", "1",
      "-q:v", "3",
      "-y", target,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) settle();
      else fail(new VideocutError("invalid_project", `ffmpeg could not read a frame: ${stderr.trim()}`));
    });
  });
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo;
  const cwd = resolve(options.cwd ?? process.cwd());
  const wantsJson = argv.includes("--json") || argv.some((arg) => arg.startsWith("--json="));
  let command = argv[0] === "cuts" && argv[1]
    ? `cuts.${argv[1]}`
    : argv[0] === "service" && argv[1]
      ? `service.${argv[1]}`
    : argv[0] === "project" && argv[1]
      ? `project.${argv[1]}`
      : argv[0] ?? "help";

  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    const projectsDir = configuredProjectsDir(parsed.projectsDir);
    if (parsed.command === "help") {
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope("help", { text: HELP_TEXT })));
      else io.stdout(HELP_TEXT);
      return 0;
    }
    if (parsed.command === "version") {
      if (parsed.json) {
        io.stdout(JSON.stringify(successEnvelope("version", { version: PRODUCT_VERSION })));
      } else {
        io.stdout(PRODUCT_VERSION);
      }
      return 0;
    }
    if (parsed.command.startsWith("service.")) {
      const action = parsed.command.slice("service.".length) as StudioServiceAction;
      const data = await (options.runServiceCommand ?? defaultRunStudioServiceCommand)(action, {
        lines: parsed.logLines,
      });
      if (parsed.openBrowser) {
        await (options.openBrowser ?? defaultOpenBrowser)(data.url);
      }
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(humanService(data));
      return 0;
    }
    if (parsed.command === "config.get" || parsed.command === "config.set") {
      if (parsed.command === "config.set") {
        await writeProductSetting(parsed.file as ConfigFieldPath, parsed.output as string);
      }
      const data = {
        path: productConfigPath(),
        settings: await inspectProductConfig(),
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else {
        io.stdout(data.path);
        for (const item of data.settings) {
          // Secrets are masked here as everywhere: a command that prints its own
          // configuration is exactly where one would otherwise leak.
          io.stdout(`  ${item.field}  ${item.value ?? "（未设置）"}  ← ${item.source}`);
        }
      }
      return 0;
    }
    if (parsed.command === "doctor") {
      const data = await doctor({ projectsDir });
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(humanDoctor(data));
      return data.healthy ? 0 : 1;
    }
    if (parsed.command === "start") {
      const startServer = options.startServer ?? defaultStartStudioServer;
      const server = await startServer({
        host: parsed.host,
        port: parsed.port,
        projectsDir,
        dataDir: parsed.dataDir,
        installSignalHandlers: true,
      });
      if (parsed.openBrowser) {
        try {
          await (options.openBrowser ?? defaultOpenBrowser)(server.url);
        } catch (error) {
          await server.stop();
          throw error;
        }
      }
      const data = {
        brand: BRAND_NAME,
        url: server.url,
        host: server.host,
        port: server.port,
        pid: process.pid,
        projectsDir: server.projectsDir,
        dataDir: server.dataDir,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`${BRAND_NAME} running at ${server.url}`);
      return 0;
    }

    if (parsed.command === "transcript.retranscribe") {
      const project = await resolveProject(projectInput(parsed.command, parsed.project), {
        cwd, projectsDir: parsed.projectsDir, outputDir: parsed.outputDir,
      });
      const document = JSON.parse(
        await readFile(join(project.directory, "edit-list.json"), "utf8"),
      ) as { segments?: Array<{ sourceStart?: number; sourceEnd?: number }> };
      // Playback order, which is the order the audience hears and therefore the
      // order the transcript must come back in.
      const ranges = (document.segments ?? [])
        .map((segment) => ({ start: Number(segment.sourceStart), end: Number(segment.sourceEnd) }))
        .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
        .sort((left, right) => left.start - right.start);
      const manifest = JSON.parse(
        await readFile(join(project.directory, "project.json"), "utf8"),
      ) as { inputVideo?: string };
      if (!manifest.inputVideo) {
        throw new VideocutError("invalid_argument", "project.json does not record an inputVideo");
      }
      const result = await (options.runCutTranscription ?? transcribeProjectCut)({
        source: resolve(project.directory, manifest.inputVideo),
        ranges,
        output: resolve(cwd, parsed.output as string),
        language: parsed.language,
        // One place answers "where does the key come from". Reading the
        // environment at each call site is how it ended up documented nowhere.
        ...(await resolveTranscriptionCredentials()),
      });
      const data = {
        provider: result.provider,
        source: result.source,
        output: result.output,
        cueCount: result.cueCount,
        wordCount: result.wordCount,
        duration: result.duration,
        keptRanges: ranges.length,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`Transcribed the cut (${data.keptRanges} ranges, ${data.duration.toFixed(2)}s) to ${data.output}`);
      return 0;
    }

    if (parsed.command === "transcribe") {
      const result = await (options.runTranscription ?? transcribeKouboVideo)(
        resolve(cwd, projectInput(parsed.command, parsed.project)),
        {
          video: parsed.video as string,
          output: parsed.output as string,
          language: parsed.language,
          ...(await resolveTranscriptionCredentials()),
        },
      );
      const data = {
        provider: result.provider,
        source: result.source,
        output: result.output,
        cueCount: result.cueCount,
        wordCount: result.wordCount,
        duration: result.duration,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`Transcribed ${data.wordCount} words to ${data.output}`);
      return 0;
    }

    if (parsed.command === "project.create") {
      let url: string | undefined;
      let registered: boolean | undefined;
      const created = await createKouboProject(
        resolve(cwd, projectInput(parsed.command, parsed.project)),
        {
          video: parsed.video as string,
          transcript: parsed.transcript as string,
          aspectRatio: parsed.aspectRatio as "3:4" | "4:3" | "16:9",
          finalize: async (prepared) => {
            const project = await resolveProject(prepared.directory, { cwd, projectsDir });
            url = projectUrl(project);
            const registration = await registerProject(project, projectsDir);
            if (!registration.registered) {
              throw new VideocutError(
                "project_id_conflict",
                `project create refuses to reuse an existing registration: ${project.projectId}`,
                { projectId: project.projectId, linkPath: registration.linkPath },
              );
            }
            registered = true;
          },
        },
      );
      if (url === undefined || registered === undefined) {
        throw new VideocutError(
          "io_error",
          "project create completed without registration metadata",
        );
      }
      const data = {
        projectId: created.projectId,
        directory: created.directory,
        url,
        registered,
        canonicalVideo: created.canonicalVideo,
        canonicalTranscript: created.canonicalTranscript,
        indexWritten: created.indexWritten,
        transcriptCueCount: created.transcript.cues.length,
        cutWordCount: created.cutWordIds.length,
        metadata: created.metadata,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`${data.url}\nCreated ${data.directory}`);
      return 0;
    }

    if (parsed.command === "project.prepare") {
      const prepared = await prepareKouboProject(
        resolve(cwd, projectInput(parsed.command, parsed.project)),
        {
          video: parsed.video,
          transcript: parsed.transcript,
          duration: parsed.duration,
          forceIndex: parsed.forceIndex,
          refreshTranscript: parsed.refreshTranscript,
        },
      );
      const project = await resolveProject(prepared.directory, { cwd, projectsDir });
      const url = projectUrl(project, parsed.origin);
      const registration = await registerProject(project, projectsDir);
      const data = {
        projectId: prepared.projectId,
        directory: prepared.directory,
        url,
        registered: registration.registered,
        indexWritten: prepared.indexWritten,
        transcriptCueCount: prepared.transcript.cues.length,
        cutWordCount: prepared.cutWordIds.length,
        metadata: prepared.metadata,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`${data.url}\nPrepared ${data.directory}`);
      return 0;
    }

    const project = await resolveProject(projectInput(parsed.command, parsed.project), {
      cwd,
      projectsDir,
      outputDir: parsed.outputDir,
    });
    if (parsed.command === "inspect") {
      const data = await inspectProject(project);
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(JSON.stringify(data, null, 2));
      return 0;
    }
    if (parsed.command === "open") {
      // Resolve and validate the URL before creating a registry link. A bad
      // origin must be a side-effect-free CLI error.
      const url = projectUrl(project, parsed.origin);
      const registration = await registerProject(project, projectsDir);
      const data = {
        projectId: project.projectId,
        directory: project.directory,
        url,
        registered: registration.registered,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(data.url);
      return 0;
    }
    if (parsed.command === "render.run") {
      const result = await (options.runRender ?? runKouboRender)(project.directory, {
        confirmed: parsed.confirmed,
        expectedRevision: parsed.expectedRevision as string,
        rendererPath: parsed.renderer,
      });
      const data = {
        projectId: project.projectId,
        directory: result.directory,
        status: result.status,
        previousRevision: result.previousRevision,
        revision: result.revision,
        finalVideoPath: result.finalVideoPath,
        verificationPath: result.verificationPath,
        verification: {
          passed: result.verification.passed,
          aspectRatio: result.verification.aspectRatio,
          globalFrameCount: result.verification.frames.global.length,
          htmlSceneCount: result.verification.frames.htmlScenes.length,
          uniqueFrameCount: result.verification.frames.unique.length,
        },
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else {
        io.stdout(
          `${BRAND_NAME} render complete\n` +
          `Final video: ${data.finalVideoPath}\n` +
          `Verification: ${data.verificationPath}\n` +
          `Revision: ${data.revision}`,
        );
      }
      return 0;
    }
    if (parsed.command === "artifact.put") {
      const source = resolve(cwd, parsed.file as string);
      let content: Uint8Array;
      try {
        content = await readFile(source);
      } catch (error) {
        throw new VideocutError(
          "invalid_argument",
          `Cannot read artifact file ${source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const result = await putKouboArtifact(project.directory, {
        type: parsed.artifactType as KouboArtifactType,
        content,
        expectedProjectRevision: parsed.expectedProjectRevision as string,
        expectedArtifactRevision: parsed.expectedArtifactRevision as string,
      });
      const data = {
        projectId: project.projectId,
        source,
        ...result,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`Published ${result.type}: ${result.target}\nStatus: ${result.status}`);
      return 0;
    }
    if (parsed.command === "editList.get" || parsed.command === "editList.patch") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const apiBase = parsed.apiBase ?? "http://127.0.0.1:5190";
      const operation = parsed.command === "editList.patch"
        ? await readProposal(parsed.file as string, cwd)
        : undefined;
      const result = await requestEditListApi({
        apiBase,
        projectId: project.projectId,
        method: parsed.command === "editList.patch" ? "PATCH" : "GET",
        expectedRevision: parsed.expectedRevision,
        operation,
      });
      const segments = Array.isArray(result.document?.segments)
        ? (result.document.segments as unknown[])
        : [];
      const data = {
        projectId: result.projectId,
        path: join(project.directory, "edit-list.json"),
        ...(result.exists === undefined ? {} : { exists: result.exists }),
        ...(result.changed === undefined ? {} : { changed: result.changed }),
        ...(result.previousRevision === undefined
          ? {}
          : { previousRevision: result.previousRevision }),
        revision: result.revision,
        mode: typeof result.document?.mode === "string" ? result.document.mode : null,
        duration: typeof result.document?.duration === "number"
          ? result.document.duration
          : null,
        segmentCount: segments.length,
        document: result.document,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else if (parsed.command === "editList.get") {
        io.stdout(JSON.stringify(data, null, 2));
      } else {
        io.stdout(
          `${data.changed ? "Applied" : "No change"}\n` +
          `Revision: ${data.previousRevision ?? "none"} -> ${data.revision}\n` +
          `Timeline: ${data.segmentCount} segments, ${data.duration ?? "?"}s (${data.mode ?? "?"})`,
        );
      }
      return 0;
    }
    if (parsed.command === "transcript.correct") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const file = await readProposal(parsed.file as string, cwd);
      const list = (file as { corrections?: unknown }).corrections ?? file;
      if (!Array.isArray(list)) {
        throw new VideocutError(
          "invalid_transcript",
          "corrections file must be an array, or an object with a corrections array",
        );
      }
      const data = await correctTranscriptText(
        project,
        list as Array<{ wordId: string; text: string }>,
        { dryRun: parsed.dryRun, actor: "skill" },
      );
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else {
        const verb = data.dryRun ? "Would correct" : data.changed ? "Corrected" : "Unchanged";
        io.stdout(`${verb} ${data.applied.length} word(s) in ${data.path}\nRevision: ${data.revision}`);
      }
      return 0;
    }
    if (parsed.command === "transcript.regroup") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const before = await readProjectDocument(project, "transcript.json");
      // Words, ids and times come out identical — the function refuses otherwise.
      // Only the paragraph boundaries move, which is what makes this safe on a
      // project that has already been cut and subtitled.
      const after = regroupKouboTranscript(before.value);
      const countCues = (value: unknown) =>
        Array.isArray((value as { cues?: unknown[] })?.cues)
          ? ((value as { cues: unknown[] }).cues.length)
          : 0;
      const data = {
        projectId: project.projectId,
        path: join(project.directory, "transcript.json"),
        dryRun: parsed.dryRun,
        cuesBefore: countCues(before.value),
        cuesAfter: after.cues.length,
        sentenceEnds: after.cues.filter((cue) =>
          /[。！？!?]/.test(cue.words.at(-1)?.punctuation ?? "")).length,
      };
      if (!parsed.dryRun && data.cuesBefore !== data.cuesAfter) {
        await writeFile(data.path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
      }
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(`段落 ${data.cuesBefore} -> ${data.cuesAfter}，其中 ${data.sentenceEnds} 段以句号结尾`);
      return 0;
    }
    if (parsed.command === "transcript.dictionary") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const transcript = await readProjectDocument(project, "transcript.json");
      const { entries, ignored } = parseDictionary(
        await readFile(resolve(cwd, parsed.file as string), "utf8"),
      );
      const matches = matchDictionary(entries, parseTranscriptWords(transcript.value));
      // Applied without asking: the dictionary is the operator's own statement
      // about their own vocabulary, so writing a rule into it *is* the decision.
      // What it changed is listed in full, which is what makes that safe.
      const result = matches.length > 0
        ? await correctTranscriptText(
          project,
          matches.map((match) => ({ wordId: match.wordId, text: match.to })),
          { actor: "cli", ...(parsed.dryRun ? { dryRun: true } : {}) },
        )
        : null;
      const data = {
        projectId: project.projectId,
        rules: entries.length,
        // A line that is not a rule is reported, never skipped in silence: a
        // typo in the dictionary is otherwise indistinguishable from a name
        // that simply never came up.
        unreadableLines: ignored,
        dryRun: parsed.dryRun,
        applied: matches.map((match) => ({
          from: match.from,
          to: match.to,
          context: match.context,
        })),
        revision: result?.revision ?? transcript.revision,
        // Screens showing a renamed word are rewritten in the same operation.
        subtitleScreensUpdated: result?.subtitles.updated.length ?? 0,
        subtitleScreensNeedingAttention: result?.subtitles.needsAttention ?? [],
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else {
        for (const match of data.applied) {
          io.stdout(`${match.from} -> ${match.to}    ${match.context}`);
        }
        io.stdout(`${data.applied.length} 处改写，${data.subtitleScreensUpdated} 屏字幕跟着改了`);
        for (const line of ignored) io.stdout(`词典第 ${line.line} 行读不懂：${line.text}`);
      }
      return 0;
    }
    if (parsed.command === "transcript.align") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const transcript = await readProjectDocument<{
        cues?: Array<{ words?: Array<{ id?: string; text?: string; isGap?: boolean }> }>;
      }>(project, "transcript.json");
      const words = (transcript.value.cues ?? []).flatMap((cue) => cue.words ?? [])
        .filter((word): word is { id: string; text: string; isGap?: boolean } =>
          typeof word.id === "string" && typeof word.text === "string");
      const markdown = await readFile(resolve(cwd, parsed.file as string), "utf8");
      const alignment = alignScriptToWords(markdown, words);
      const data = {
        corrections: alignment.corrections,
        // Terms the script spells but whose position in the speech is not decidable.
        // Reported, never guessed: a wrong name is worse than a misheard one.
        undecided: [...new Set(alignment.unmatched.map((item) => item.text))],
        totalWords: alignment.totalWords,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else {
        for (const correction of data.corrections) {
          io.stdout(`${correction.from} -> ${correction.to}`);
        }
        if (data.undecided.length > 0) io.stdout(`undecided: ${data.undecided.join(" ")}`);
      }
      return 0;
    }

    if (parsed.command === "visual.frame") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const [subtitles, transcript, editList] = await Promise.all([
        readSubtitles(project),
        readOptionalProjectDocument(project, "transcript.json"),
        readEditList(project),
      ]);
      if (!subtitles) {
        throw new VideocutError("invalid_visuals", "This project has no subtitles yet");
      }
      const byId = new Map(subtitles.value.cues.map((cue) => [cue.id, cue]));
      const missing = (parsed.cueIds ?? []).filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new VideocutError("invalid_visuals", "Those subtitle screens are not in this project", {
          missing,
        });
      }
      const words = transcript ? parseTranscriptWords(transcript.value) : [];
      // Reuse the layer timing exactly: the frames a person judges by have to be
      // the frames the layer will actually cover, not an approximation of them.
      const span = visualLayerTimings(
        {
          ...createVisualDocument(project.projectId, transcript?.revision ?? ""),
          layers: [{
            id: "probe",
            wordIds: (parsed.cueIds ?? []).flatMap((id) => byId.get(id)!.wordIds),
            module: "probe.html",
          }],
        },
        words,
        editList?.value ?? null,
      )[0]!;
      if (span.orphaned) {
        throw new VideocutError(
          "invalid_visuals",
          "Those screens have no words left in the cut, so there is nothing to look at",
        );
      }
      const count = parsed.frameCount ?? 3;
    const outDir = parsed.outDir
        ? resolve(cwd, parsed.outDir)
        : join(project.directory, "review", "frames");
      await mkdir(outDir, { recursive: true });
      const inputVideo = (project.project as Record<string, unknown>).inputVideo;
      if (typeof inputVideo !== "string" || !inputVideo.trim()) {
        throw new VideocutError("invalid_project", "This project has no inputVideo to sample");
      }
      const sourcePath = resolve(project.directory, inputVideo);
      const frames: Array<{ cutTime: number; sourceTime: number; file: string }> = [];
      for (let index = 0; index < count; index += 1) {
        // Sample inside the span, never on its edges: the first and last frames
        // of a cut are the ones most likely to be a transition smear.
        const cutTime = span.start + (span.duration * (index + 0.5)) / count;
        const sourceTime = sourceTimeForCutTime(editList?.value ?? null, cutTime);
        if (sourceTime === null) continue;
        const file = join(outDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
        await extractFrame(sourcePath, sourceTime, file);
        frames.push({ cutTime, sourceTime, file });
      }
      const data = {
        projectId: project.projectId,
        cueIds: parsed.cueIds ?? [],
        text: (parsed.cueIds ?? []).map((id) => byId.get(id)!.text).join(""),
        start: span.start,
        end: span.end,
        duration: span.duration,
        frames,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(JSON.stringify(data, null, 2));
      return 0;
    }

    if (parsed.command === "export") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const [subtitles, transcript, editList, visuals] = await Promise.all([
        readSubtitles(project),
        readOptionalProjectDocument(project, "transcript.json"),
        readEditList(project),
        readVisuals(project),
      ]);
      const inputVideo = (project.project as Record<string, unknown>).inputVideo;
      if (typeof inputVideo !== "string" || !inputVideo.trim()) {
        throw new VideocutError("invalid_project", "This project has no inputVideo to export");
      }
      const sourcePath = resolve(project.directory, inputVideo);
      const probe = await probeMedia(sourcePath);
      if (!probe.hasVideo) {
        throw new VideocutError("invalid_project", "The source is not a readable video", {
          sourcePath,
        });
      }
      const plan = buildExportPlan({
        editList: editList?.value ?? null,
        words: transcript ? parseTranscriptWords(transcript.value) : [],
        subtitles: subtitles?.value ?? null,
        visuals: visuals?.value ?? null,
        source: {
          width: probe.width,
          height: probe.height,
          duration: probe.duration,
          frameRate: probe.frameRate ?? 30,
        },
        scale: parsed.scale,
        fps: parsed.fps,
      });
      const outputPath = parsed.outFile
        ? resolve(cwd, parsed.outFile)
        : join(project.directory, "成片.mp4");
      const summary = {
        projectId: project.projectId,
        output: outputPath,
        duration: plan.duration,
        fps: plan.fps,
        frameCount: plan.frameCount,
        source: plan.source,
        outputSize: plan.output,
        cutSegments: plan.spans.length,
        subtitleScreens: plan.subtitleCues.length,
        visualLayers: plan.layers.length,
        zoomSpans: plan.zoomSpans.filter((span) => span.box).length,
        warnings: plan.warnings,
      };
      // A dry run answers the only question worth asking before spending ten
      // minutes on an encode: is this the film I think it is?
      if (parsed.dryRun) {
        if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, summary)));
        else io.stdout(JSON.stringify(summary, null, 2));
        return 0;
      }
      const workDirectory = join(project.directory, ".chengfeng-videocut", "export");
      await rm(workDirectory, { recursive: true, force: true });
      let lastReport = 0;
      const result = await exportFilm({
        projectDirectory: project.directory,
        sourcePath,
        plan,
        outputPath,
        workDirectory,
        keepWork: parsed.keepWork,
        onProgress: (stage, done, total) => {
          if (parsed.json) return;
          const now = Date.now();
          if (done !== total && now - lastReport < 1000) return;
          lastReport = now;
          io.stderr(`${stage} ${done}/${total}`);
        },
      });
      const data = {
        ...summary,
        width: result.probe.width,
        height: result.probe.height,
        actualDuration: result.probe.duration,
        hasAudio: result.probe.hasAudio,
        renderedFrames: result.frameCount,
        problems: result.problems,
      };
      // A file that does not match its own plan is not a delivery, and the
      // product may not report it as one. The file is left on disk and named
      // in the details — it is evidence, not a result.
      if (result.problems.length > 0) {
        throw new VideocutError("readback_mismatch", "成片和导出计划对不上", {
          ...data,
        });
      }
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(JSON.stringify(data, null, 2));
      return 0;
    }

    if (
      parsed.command === "visual.get"
      || parsed.command === "visual.add"
      || parsed.command === "visual.remove"
    ) {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const current = await readVisuals(project);
      let document = current?.value
        ?? createVisualDocument(project.projectId, (await readOptionalProjectDocument(
          project,
          "transcript.json",
        ))?.revision ?? "");
      let revision = current?.revision ?? "none";

      if (parsed.command === "visual.add") {
        // A layer is placed on screens, not on word ids typed by hand. The
        // screens are what a person and an Agent both actually reason about,
        // and going through them means a layer can never name a word nobody
        // says — the ids come out of the document, they are not supplied.
        const subtitles = await readSubtitles(project);
        if (!subtitles) {
          throw new VideocutError(
            "invalid_visuals",
            "This project has no subtitles yet, so there are no screens to place a layer on",
          );
        }
        const byId = new Map(subtitles.value.cues.map((cue) => [cue.id, cue]));
        const missing = (parsed.cueIds ?? []).filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new VideocutError("invalid_visuals", "Those subtitle screens are not in this project", {
            missing,
          });
        }
        const wordIds = (parsed.cueIds ?? []).flatMap((id) => byId.get(id)!.wordIds);
        const layerId = parsed.layerId
          ?? `vis-${String(document.layers.length + 1).padStart(4, "0")}`;
        document = {
          ...document,
          layers: [...document.layers, {
            id: layerId,
            wordIds,
            module: parsed.modulePath!,
            ...(parsed.zoom ? { zoom: parsed.zoom } : {}),
          }],
        };
      }

      if (parsed.command === "visual.remove") {
        const before = document.layers.length;
        document = {
          ...document,
          layers: document.layers.filter((layer) => layer.id !== parsed.layerId),
        };
        if (document.layers.length === before) {
          throw new VideocutError("invalid_visuals", `No such visual layer: ${parsed.layerId}`, {
            layerId: parsed.layerId,
          });
        }
      }

      if (parsed.command !== "visual.get") {
        const result = await writeVisuals(project, document, {
          actor: "cli",
          expectedRevision: parsed.expectedRevision ?? revision,
          ...(parsed.dryRun ? { dryRun: true } : {}),
        });
        document = result.document;
        revision = result.revision;
      }

      const [transcript, editList] = await Promise.all([
        readOptionalProjectDocument(project, "transcript.json"),
        readEditList(project),
      ]);
      const words = transcript ? parseTranscriptWords(transcript.value) : [];
      const timings = visualLayerTimings(document, words, editList?.value ?? null);
      const data = {
        projectId: project.projectId,
        revision,
        animationStyle: document.animationStyle,
        layers: document.layers.map((layer) => {
          const timing = timings.find((candidate) => candidate.layerId === layer.id);
          return {
            id: layer.id,
            module: layer.module,
            wordCount: layer.wordIds.length,
            start: timing?.start ?? 0,
            end: timing?.end ?? 0,
            duration: timing?.duration ?? 0,
            orphaned: timing?.orphaned ?? true,
          };
        }),
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(JSON.stringify(data, null, 2));
      return 0;
    }

    if (
      parsed.command === "subtitle.get"
      || parsed.command === "subtitle.build"
      || parsed.command === "subtitle.set"
    ) {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      let written: SubtitleDocument | null = null;
      let writtenRevision: string | null = null;
      if (parsed.command === "subtitle.build") {
        const result = await buildProjectSubtitles(project, {
          actor: "cli",
          replace: parsed.replace,
          ...(parsed.dryRun ? { dryRun: true } : {}),
          ...(parsed.maxColumns !== undefined ? { maxColumns: parsed.maxColumns } : {}),
          ...(parsed.breakPauseSeconds !== undefined
            ? { breakPauseSeconds: parsed.breakPauseSeconds }
            : {}),
        });
        written = result.document;
        writtenRevision = result.revision;
      }
      if (parsed.command === "subtitle.set") {
        const result = await writeSubtitles(
          project,
          await readProposal(parsed.file as string, cwd),
          {
            actor: "cli",
            ...(parsed.dryRun ? { dryRun: true } : {}),
            ...(parsed.expectedRevision ? { expectedRevision: parsed.expectedRevision } : {}),
          },
        );
        written = result.document;
        writtenRevision = result.revision;
      }
      // Report the document this command produced, not what is on disk: with
      // --dry-run nothing was written, and reading disk back would describe the
      // old state while claiming to describe the new one.
      const state = await readSubtitleState(project);
      const [transcript, editList] = await Promise.all([
        readProjectDocument(project, "transcript.json"),
        readEditList(project),
      ]);
      const words = parseTranscriptWords(transcript.value);
      const document = written ?? state.document;
      const timings = document
        ? subtitleCueTimings(document, words, editList?.value ?? null)
        : [];
      const data = {
        projectId: state.projectId,
        path: join(project.directory, "subtitles.json"),
        exists: document !== null,
        dryRun: parsed.dryRun,
        revision: writtenRevision ?? state.revision,
        cueCount: document?.cues.length ?? 0,
        // Screens the cut broke — always the exact list, never "may be stale".
        stale: document ? subtitleStaleness(document, words, editList?.value ?? null) : [],
        tooFast: timings.filter((timing) => timing.tooFast && !timing.orphaned)
          .map((timing) => timing.cueId),
        transcriptMoved: document !== null
          && state.transcriptRevision !== null
          && document.baseTranscriptRevision !== state.transcriptRevision,
        ...(parsed.command === "subtitle.get" ? { document } : {}),
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(JSON.stringify(data, null, 2));
      return 0;
    }

    if (parsed.command === "transcript.playback") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      // What the audience hears, in the order they hear it. The judging layer must
      // never assemble this itself: doing so wrong is silent and it changes the
      // verdict, not just the presentation.
      const [transcript, editList] = await Promise.all([
        readProjectDocument(project, "transcript.json"),
        readEditList(project),
      ]);
      const playback = buildPlaybackTranscript(
        project.projectId,
        parseTranscriptWords(transcript.value),
        editList?.value ?? null,
      );
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, playback)));
      else io.stdout(JSON.stringify(playback, null, 2));
      return 0;
    }
    if (parsed.command === "cuts.get") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      const result = await readCutsThroughApi({
        apiBase: parsed.apiBase ?? "http://127.0.0.1:5190",
        projectId: project.projectId,
      });
      const data = {
        projectId: result.projectId,
        path: join(project.directory, "cut-selection.json"),
        exists: result.exists,
        revision: result.revision,
        cutWordCount: Array.isArray(result.document?.cutWordIds)
          ? result.document.cutWordIds.length
          : 0,
        cutRangeCount: Array.isArray(result.document?.cutRanges)
          ? result.document.cutRanges.length
          : 0,
        document: result.document,
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else io.stdout(JSON.stringify(data, null, 2));
      return 0;
    }
    if (parsed.command === "workflow.get" || parsed.command === "workflow.transition" ||
        parsed.command === "cuts.apply") {
      await assertRegisteredProject({ project, cwd, projectsDir, outputDir: parsed.outputDir });
      let config: unknown;
      if (parsed.command === "workflow.transition" && parsed.file) {
        config = await readProposal(parsed.file, cwd);
      }
      const action = parsed.command === "cuts.apply" ? "apply-cut"
        : parsed.command === "workflow.transition" ? parsed.action
          : undefined;
      const apiBase = parsed.apiBase ?? "http://127.0.0.1:5190";
      const data = await requestWorkflowApi({
        apiBase,
        projectId: project.projectId,
        action,
        expectedRevision: parsed.expectedRevision,
        expectedEditListRevision: parsed.command === "cuts.apply"
          ? parsed.expectedEditListRevision
          : undefined,
        config,
      });
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else if (parsed.command === "workflow.get") {
        io.stdout(JSON.stringify(data, null, 2));
      } else {
        const current = objectRecord(data.project);
        const continuation = objectRecord(current?.codexContinue);
        io.stdout(
          `Accepted ${String(action)}\nStatus: ${String(current?.status ?? "unknown")}` +
          (continuation?.stage ? `\nNext stage: ${String(continuation.stage)}` : ""),
        );
      }
      return 0;
    }
    if (parsed.command === "cuts.set") {
      const proposal = await readProposal(parsed.file as string, cwd);
      // A path input is allowed for convenience, but the cuts service is keyed
      // exclusively by registered project id. Verify that both resolve to the
      // same real directory before calculating or sending any update.
      await assertRegisteredProject({ project, cwd, projectsDir });
      const cutWordIds = proposalCutWordIds(proposal);
      const reasons = proposalReasons(proposal);
      // Read the state being replaced, so the result can say what this write let go
      // of. Best-effort on purpose: a malformed proposal must still fail with its
      // own error rather than behind a connection error, and an unreachable service
      // must fail at the write. When it cannot be read the result says so — a
      // missing comparison is reported, never silently omitted.
      let previousCutWordIdList: string[] | null = null;
      try {
        const before = await readCutsThroughApi({
          apiBase: parsed.apiBase ?? "http://127.0.0.1:5190",
          projectId: project.projectId,
        });
        previousCutWordIdList = Array.isArray(before.document?.cutWordIds)
          ? before.document.cutWordIds.filter((id): id is string => typeof id === "string")
          : [];
      } catch {
        previousCutWordIdList = null;
      }
      const result = parsed.dryRun
        ? await writeCutSelection(project, {
            cutWordIds,
            ...(reasons === undefined ? {} : { reasons }),
          }, {
            expectedRevision: parsed.expectedRevision,
            dryRun: true,
            mode: "semantic-overlay",
            actor: "cli",
          })
        : await updateCutsThroughApi({
            apiBase: parsed.apiBase ?? "http://127.0.0.1:5190",
            projectId: project.projectId,
            expectedRevision: parsed.expectedRevision as string,
            cutWordIds,
            ...(reasons === undefined ? {} : { reasons }),
          });
      // Two different checks, because the obvious one guards the wrong thing.
      //
      // Reading back and confirming the write landed as written catches a corrupt
      // or racing write. It does *not* catch what actually went wrong on
      // 2026-07-26: a submission carrying only the newly-found words replaced the
      // whole previous conclusion. Written and read-back agreed perfectly — both
      // said 386 — and `changed: true` is what success looks like. The cut word
      // count had fallen from 430, the audio stayed correct because a manual
      // timeline is only ever carved, and the ledger quietly regressed.
      //
      // Submitting fewer words is also how the contract expresses a deliberate
      // retraction, so it cannot be refused. What can be done is refuse to let it
      // pass silently: report exactly which previously-cut words are no longer
      // cut, so an accidental delta is visible in the same breath as the success.
      const verified = parsed.dryRun ? null : await readCutsThroughApi({
        apiBase: parsed.apiBase ?? "http://127.0.0.1:5190",
        projectId: project.projectId,
      });
      if (verified) {
        const readBackWordCount = Array.isArray(verified.document?.cutWordIds)
          ? verified.document.cutWordIds.length
          : null;
        const mismatch =
          verified.revision !== result.revision
            ? { field: "revision", wrote: result.revision, readBack: verified.revision }
            : readBackWordCount !== result.document.cutWordIds.length
              ? { field: "cutWordCount", wrote: result.document.cutWordIds.length, readBack: readBackWordCount }
              : null;
        if (mismatch) {
          throw new VideocutError(
            "readback_mismatch",
            "cut-selection.json read back differently than it was written; nothing was reported as saved",
            { projectId: project.projectId, ...mismatch },
          );
        }
      }
      const nextCutWordIds = new Set(result.document.cutWordIds);
      const noLongerCut = previousCutWordIdList === null
        ? null
        : previousCutWordIdList.filter((id) => !nextCutWordIds.has(id));
      const data = {
        projectId: result.projectId,
        path: join(project.directory, "cut-selection.json"),
        previousRevision: result.previousRevision,
        revision: result.revision,
        changed: result.changed,
        dryRun: parsed.dryRun,
        cutWordCount: result.document.cutWordIds.length,
        cutRangeCount: result.document.cutRanges.length,
        // Present only when the write was verified against the product's own
        // read-back. Its absence is what a caller should look for.
        ...(verified ? { readBackVerified: true } : {}),
        // Words this write stopped cutting. Legitimate when a retraction was
        // intended; the signal that a delta was submitted by mistake when it was
        // not. Always reported, never inferred to be either.
        ...(noLongerCut === null
          ? { noLongerCut: "unknown" as const }
          : noLongerCut.length > 0
            ? { noLongerCut: noLongerCut.length, noLongerCutSample: noLongerCut.slice(0, 8) }
            : {}),
      };
      if (parsed.json) io.stdout(JSON.stringify(successEnvelope(parsed.command, data)));
      else {
        const verb = parsed.dryRun ? "Would write" : result.changed ? "Wrote" : "Unchanged";
        io.stdout(`${verb} ${data.path}\nRevision: ${result.revision}`);
      }
      return 0;
    }
    throw new VideocutError("invalid_argument", `Unsupported command: ${parsed.command}`);
  } catch (unknownError) {
    const error = normalizeCliError(unknownError);
    if (wantsJson) {
      io.stdout(JSON.stringify(errorEnvelope(command, error.code, error.message, error.details)));
    } else {
      io.stderr(`${error.code}: ${error.message}`);
    }
    return exitCodeFor(error);
  }
}
