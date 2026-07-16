import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VideocutError, asVideocutError } from "@video-workbench/core";
import {
  prepareKouboProject,
  putKouboArtifact,
  runKouboRender,
  type KouboArtifactType,
  type RunKouboRenderOptions,
} from "@video-workbench/koubo-adapter";
import {
  doctor,
  inspectProject,
  projectUrl,
  registerProject,
  resolveProject,
  writeCutSelection,
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
  successEnvelope,
} from "./output";

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
      return 4;
    case "revision_conflict":
    case "project_id_conflict":
    case "invalid_state":
    case "missing_artifact":
      return 5;
    case "service_unavailable":
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
  resource: "workflow" | "actions",
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

async function updateCutsThroughApi(options: {
  apiBase: string;
  projectId: string;
  expectedRevision: string;
  cutWordIds: unknown[];
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
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliRequestError(
      "service_unavailable",
      `Cannot reach chengfeng-VideoCut at ${options.apiBase}`,
      { endpoint, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliRequestError(
      "service_unavailable",
      `chengfeng-VideoCut returned an invalid response (${response.status})`,
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
        : `chengfeng-VideoCut request failed (${response.status})`,
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
      "chengfeng-VideoCut returned an incompatible cuts response",
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
  config?: unknown;
}): Promise<Record<string, unknown>> {
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
        ...(options.config !== undefined ? { config: options.config } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    } : {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliRequestError(
      "service_unavailable",
      `Cannot reach chengfeng-VideoCut at ${options.apiBase}`,
      { endpoint, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliRequestError(
      "service_unavailable",
      `chengfeng-VideoCut returned an invalid response (${response.status})`,
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
        : `chengfeng-VideoCut request failed (${response.status})`,
      objectRecord(errorRecord?.details) ?? { endpoint, status: response.status },
    );
  }
  if (!record || record.schemaVersion !== 1 || record.projectId !== options.projectId ||
      typeof record.revision !== "string" || !/^[a-f0-9]{64}$/.test(record.revision) ||
      !objectRecord(record.project)) {
    throw new CliRequestError(
      "service_unavailable",
      "chengfeng-VideoCut returned an incompatible workflow response",
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

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo;
  const cwd = resolve(options.cwd ?? process.cwd());
  const wantsJson = argv.includes("--json") || argv.some((arg) => arg.startsWith("--json="));
  let command = argv[0] ?? "help";

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

    if (parsed.command === "project.prepare") {
      const directory = resolve(cwd, projectInput(parsed.command, parsed.project));
      const prepared = await prepareKouboProject(directory, {
        video: parsed.video,
        transcript: parsed.transcript,
        duration: parsed.duration,
        forceIndex: parsed.forceIndex,
        refreshTranscript: parsed.refreshTranscript,
      });
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
      const data = await requestWorkflowApi({
        apiBase: parsed.apiBase ?? "http://127.0.0.1:5190",
        projectId: project.projectId,
        action,
        expectedRevision: parsed.expectedRevision,
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
      const result = parsed.dryRun
        ? await writeCutSelection(project, { cutWordIds }, {
            expectedRevision: parsed.expectedRevision,
            dryRun: true,
          })
        : await updateCutsThroughApi({
            apiBase: parsed.apiBase ?? "http://127.0.0.1:5190",
            projectId: project.projectId,
            expectedRevision: parsed.expectedRevision as string,
            cutWordIds,
          });
      const data = {
        projectId: result.projectId,
        path: join(project.directory, "cut-selection.json"),
        previousRevision: result.previousRevision,
        revision: result.revision,
        changed: result.changed,
        dryRun: parsed.dryRun,
        cutWordCount: result.document.cutWordIds.length,
        cutRangeCount: result.document.cutRanges.length,
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
