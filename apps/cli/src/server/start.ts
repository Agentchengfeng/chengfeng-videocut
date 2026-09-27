import { createHash } from "node:crypto";
import { createConnectionApi } from "./connection-api";
import {createModuleApi} from './module-api';
import { createIngestApi } from './ingest-api';
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, basename } from "node:path";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import hyperframesRuntimeSource from "@hyperframes/core/runtime" with { type: "text" };
import { createStudioApi } from "@hyperframes/studio-server";
import customEaseSource from "gsap/dist/CustomEase.min.js" with { type: "text" };
import motionPathPluginSource from "gsap/dist/MotionPathPlugin.min.js" with { type: "text" };
import gsapSource from "gsap/dist/gsap.min.js" with { type: "text" };
import { createVideocutCutsHandler } from "../../../studio/src/server/videocutCutsApi";
import { createVideocutEditListHandler } from "../../../studio/src/server/videocutEditListApi";
import { createVideocutSubtitlesHandler } from "../../../studio/src/server/videocutSubtitlesApi";
import { createVideocutVisualsHandler } from "../../../studio/src/server/videocutVisualsApi";
import { createSoundEffectsApi } from "./sound-effects-api";
import { createMediaAssetsApi } from "./media-assets-api";
import { createProjectConfigApi } from "./project-config-api";
import { createMultisourceApi } from "./multisource-api";
import { assertProjectReadable } from "@video-workbench/core/node";
import { VideocutError } from "@video-workbench/core";
import { createVideocutTimelineMediaHandler } from "../../../studio/src/server/videocutTimelineMediaApi";
import { createVideocutProjectSurfaceHandler } from "../../../studio/src/server/videocutProjectSurfaceApi";
import { materializeKouboEditListIndex } from "@video-workbench/koubo-adapter";
import { findExecutable, OperationAuditStore, serializeProjectOperation } from "@video-workbench/core/node";
import { StudioEventHub } from "./events";
import { createProjectMediaHandler } from "./project-media";
import { watchRegisteredProjects } from "./project-watcher";
import { createProductionStudioAdapter } from "./studio-adapter";
import {
  EditPreviewArtifactManager,
  createEditPreviewArtifactHandler,
  projectInput,
} from "./edit-preview-artifact";
import { placeCutBoundaries } from "./preview-stream";
import { deriveSemanticCutRanges } from "./semantic-cut-boundaries";
import { refineSeams, audibleSeams } from "./seam-refine";
import { parseEditListDocument } from "@video-workbench/core";
import { fetchGuardedStudioApi } from "./studio-mutation-guard";
import { createVideocutWorkflowHandler } from "./workflow-api";
import { skillDirectoryResponse } from "./skill-directory";
import { PRODUCT_VERSION } from "../output";
import { JobManager } from "../jobs/manager";
import { createJobsApi } from "./jobs-api";
import { createLifecycleLog } from "./lifecycle";
import { IdleLifecycle } from "./idle-lifecycle";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5190;
const STUDIO_SERVER_IDLE_TIMEOUT_SECONDS = 60;

type StudioRuntimeMode = "launchd" | "windows-task" | "foreground";


function resolveJobConcurrency(explicit?: number): number | undefined {
  if (explicit !== undefined) return explicit;
  const raw = process.env.CHENGFENG_VIDEOCUT_JOB_CONCURRENCY?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("CHENGFENG_VIDEOCUT_JOB_CONCURRENCY must be an integer from 1 to 32");
  }
  return value;
}

export interface StudioServerApiContext {
  projectsDir: string;
  dataDir: string;
  events: StudioEventHub;
}

export type StudioServerApiHandler = (
  request: Request,
  context: StudioServerApiContext,
) => Response | null | undefined | Promise<Response | null | undefined>;

export interface StartStudioServerOptions {
  host?: string;
  port?: number;
  projectsDir?: string;
  dataDir?: string;
  staticDir?: string;
  /** Product-owned routes run before the generic HyperFrames API. */
  apiHandler?: StudioServerApiHandler;
  /** Backward-compatible alias for apiHandler. */
  extraApiHandler?: StudioServerApiHandler;
  installSignalHandlers?: boolean;
  /** Opt in to process idle shutdown. Zero/default leaves it disabled. */
  idleTimeoutSeconds?: number;
  /** Parallel durable jobs; falls back to CHENGFENG_VIDEOCUT_JOB_CONCURRENCY, then machine size. */
  jobConcurrency?: number;
  /** In-process test/embedding provider; never supplied through HTTP or CLI. */
  ingest?: Parameters<typeof createIngestApi>[3];
}

export interface RunningStudioServer {
  host: string;
  port: number;
  url: string;
  projectsDir: string;
  dataDir: string;
  events: StudioEventHub;
  stop: () => Promise<void>;
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

interface StudioStaticAsset {
  body: Blob;
  byteLength: number;
  contentType: string;
}

interface StudioStaticSnapshot {
  buildId: string;
  files: ReadonlyMap<string, StudioStaticAsset>;
}

function isPublishedStudioStaticFile(relativePath: string): boolean {
  // TypeScript incremental metadata is emitted beside the browser bundle by
  // typecheck. It has no browser URL and is not part of a releasable Studio
  // snapshot, so including it would make health identity drift without any
  // change to the assets users can receive.
  return !relativePath.endsWith(".tsbuildinfo");
}

async function loadStudioStaticSnapshot(staticDir: string): Promise<StudioStaticSnapshot> {
  const files = new Map<string, StudioStaticAsset>();
  const digest = createHash("sha256");

  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !isPublishedStudioStaticFile(relativePath)) continue;
      const body = await readFile(absolutePath);
      const key = `/${relativePath}`;
      files.set(key, {
        body: new Blob([body]),
        byteLength: body.byteLength,
        contentType: mimeType(absolutePath),
      });
      digest.update(key);
      digest.update(body);
    }
  };

  await walk(staticDir);
  const index = files.get("/index.html");
  if (!index) throw new Error(`Studio static snapshot is missing index.html: ${staticDir}`);

  const indexHtml = await index.body.text();
  for (const match of indexHtml.matchAll(/(?:src|href)=["'](\/[^"'#?]+)[^"']*["']/g)) {
    const referencedPath = match[1];
    if (!files.has(referencedPath)) {
      throw new Error(
        `Studio static snapshot is incomplete: index.html references missing ${referencedPath}`,
      );
    }
  }

  return {
    buildId: digest.digest("hex").slice(0, 16),
    files,
  };
}

function packagedStaticCandidates(): string[] {
  return [
    fileURLToPath(new URL("./studio/", import.meta.url)),
    fileURLToPath(new URL("../../../studio/dist/", import.meta.url)),
    resolve(process.cwd(), "apps/studio/dist"),
  ];
}

function resolveStaticDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.CHENGFENG_VIDEOCUT_STATIC_DIR,
    ...packagedStaticCandidates(),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const match = candidates.map((candidate) => resolve(candidate)).find((candidate) =>
    existsSync(resolve(candidate, "index.html")),
  );
  if (!match) {
    throw new Error(
      "Studio assets are missing. Reinstall chengfeng-videocut or run its package build first.",
    );
  }
  return match;
}

interface BundledVendorAsset {
  source: string;
  etag: string;
  byteLength: number;
}

function bundledVendorAsset(source: string): BundledVendorAsset {
  const digest = createHash("sha256").update(source).digest("base64url");
  return {
    source,
    etag: `"sha256-${digest}"`,
    byteLength: Buffer.byteLength(source),
  };
}

const VENDOR_ASSETS = new Map<string, BundledVendorAsset>([
  ["/api/vendor/gsap.min.js", bundledVendorAsset(gsapSource)],
  ["/api/vendor/CustomEase.min.js", bundledVendorAsset(customEaseSource)],
  ["/api/vendor/MotionPathPlugin.min.js", bundledVendorAsset(motionPathPluginSource)],
]);

const BUNDLED_GSAP_FILES = new Set([
  "gsap.min.js",
  "CustomEase.min.js",
  "MotionPathPlugin.min.js",
]);

function localizeBundledGsapUrls(html: string): string {
  return html.replace(
    /https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^/"']+\/dist\/([A-Za-z]+(?:\.min)?\.js)/g,
    (url, filename: string) => BUNDLED_GSAP_FILES.has(filename)
      ? `/api/vendor/${filename}`
      : url,
  );
}

async function localizeStudioResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.toLowerCase().includes("text/html")) return response;

  const original = await response.text();
  const localized = localizeBundledGsapUrls(original);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  return new Response(localized, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestAcceptsEtag(request: Request, etag: string): boolean {
  const value = request.headers.get("if-none-match");
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

function vendorAssetResponse(request: Request, asset: BundledVendorAsset): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }

  const cacheHeaders = {
    "Cache-Control": "public, max-age=86400",
    "Content-Type": "text/javascript; charset=utf-8",
    ETag: asset.etag,
  };
  if (requestAcceptsEtag(request, asset.etag)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return new Response(request.method === "HEAD" ? null : asset.source, {
    headers: {
      ...cacheHeaders,
      "Content-Length": String(asset.byteLength),
    },
  });
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function resolveListenPort(host: string, requestedPort: number): Promise<number> {
  if (requestedPort !== 0) return requestedPort;
  // Bun 1.3 on macOS rejects port 0 instead of asking the kernel for an
  // ephemeral port. Probe with node:net so the public `--port 0` contract and
  // isolated server tests continue to work.
  return await new Promise<number>((resolvePort, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host, port: 0 }, () => {
      const address = probe.address() as AddressInfo | null;
      if (!address) {
        probe.close();
        reject(new Error("Failed to allocate an ephemeral Studio port"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function staticResponse(
  request: Request,
  url: URL,
  snapshot: StudioStaticSnapshot,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname.includes("\0")) return new Response("Bad Request", { status: 400 });

  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (requested.split("/").some((segment) => segment === "..")) {
    return new Response("Not Found", { status: 404 });
  }
  const requestedPath = `/${requested}`;
  let responsePath = requestedPath;
  let asset = snapshot.files.get(requestedPath);
  if (!asset) {
    if (extname(requested)) return new Response("Not Found", { status: 404 });
    responsePath = "/index.html";
    asset = snapshot.files.get(responsePath);
  }
  if (!asset) return new Response("Not Found", { status: 404 });

  const headers = new Headers({
    "Content-Length": String(asset.byteLength),
    "Content-Type": asset.contentType,
    "Cache-Control": responsePath === "/chengfeng-videocut-capabilities.json"
      ? "no-store"
      : responsePath.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : responsePath === "/index.html"
        ? "no-store"
        : "public, max-age=3600",
  });
  return new Response(request.method === "HEAD" ? null : asset.body, { headers });
}

function healthResponse(
  request: Request,
  buildId: string,
  runtimeMode: StudioRuntimeMode,
  mediaToolsMissing: readonly string[] = [],
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    ok: true,
    product: "chengfeng-videocut",
    productVersion: PRODUCT_VERSION,
    pid: process.pid,
    runtimeMode,
    studioBuildId: buildId,
    genericHtmlRender: {
      schemaVersion: 1,
      enabled: false,
      source: "production-studio-adapter",
      reason: "此工作台未启用通用 HTML 导出。请使用既有确认门控的产品导出流程。",
    },
    existingWorkflowApiVersion: 1,
    editTargetsApiVersion: 1,
    modulePublishApiVersion: 1,
    mediaAssetsApiVersion: 1,
    soundEffectsApiVersion: 1,
    soundEffects: { schemaVersion: 1, managedWav: true, preview: true, export: true, maxCues: 64 },
    projectConfigApiVersion: 1,
    projectConfig: { fields: ["aspectRatio", "canvasBackground", "narrationGainDb"] },
    multisourceAudioApiVersion: 1,
    insertMediaApiVersion: 1,
    seamRefinementApiVersion: 1,
    seamRefinement: { automatic: ["cut-writes", "range-delete", "range-restore"], skips: ["trim", "split"], report: "seams-get" },
    insertMedia: { schemaVersion: 1, anchor: "after-word", audio: "clip-own-audio", gainDb: false, maxInserts: 64, operations: ["inserts-get", "inserts-plan", "inserts-commit"] },
    multisourceAudio: { operations: ["prepend-project", "delete-words", "delete-segments", "recover-transaction"], segmentCutsApiVersion: 1, editListSchemaVersion: 2, mixing: false, videoSources: "insert-only",
      semanticCuts: true, wordCutsApiVersion: 1, reviewedVisualReplacementsApiVersion: 1, legacyCutsSet: false, studioWordCuts: false, restoreMode: "unchanged-transaction-only",
      transcriptPlayback: true, waveform: false },
    ingestApiVersion: 1,
    transcriptCorrectionApiVersion: 1,
    // 服务进程自己的环境里媒体工具是否可见——doctor 查的是终端环境，
    // 两者可以不一致（服务先启动、ffmpeg 后安装）。缺了服务照常跑：
    // 项目管理与账本都不需要 ffmpeg，只有预览/导出需要，用时会报具体错。
    ...(mediaToolsMissing.length > 0 ? { mediaToolsMissing } : {}),
  });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/** Append one line to a project's events.jsonl for a request the transaction gate refused. */
async function recordBlockedRequest(directory: string, projectId: string, method: string, path: string, error: VideocutError) {
  try {
    const { appendFile, lstat, realpath } = await import("node:fs/promises");
    const real = await realpath(directory);
    const file = resolve(real, "events.jsonl");
    const info = await lstat(file).catch(() => null);
    if (info && (!info.isFile() || info.isSymbolicLink())) return;
    await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), type: "request_blocked", actor: "runtime",
      payload: { projectId, method, path, code: error.code, message: error.message } })}\n`);
  } catch {
    // Recording is best effort; the refusal itself is already the answer.
  }
}

export async function startStudioServer(
  options: StartStudioServerOptions = {},
): Promise<RunningStudioServer> {
  const lifecycle = createLifecycleLog(resolve(options.dataDir ?? process.env.CHENGFENG_VIDEOCUT_DATA_DIR ?? resolve(homedir(), ".chengfeng-videocut")));
  lifecycle.record("starting");
  try {
    return await startStudioServerInternal(options, lifecycle);
  } catch (error) {
    lifecycle.record("startup_failed", { errorName: error instanceof Error ? error.name : "UnknownError",
      code: String((error as NodeJS.ErrnoException)?.code ?? "unknown").slice(0, 80) });
    throw error;
  }
}

async function startStudioServerInternal(options: StartStudioServerOptions, lifecycle: ReturnType<typeof createLifecycleLog>): Promise<RunningStudioServer> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  if (!host.trim()) throw new Error("--host must not be empty");
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  if (!Number.isFinite(options.idleTimeoutSeconds ?? 0) || (options.idleTimeoutSeconds ?? 0) < 0) {
    throw new Error("--idle-timeout-seconds must be non-negative");
  }

  const dataDir = resolve(
    options.dataDir ??
      process.env.CHENGFENG_VIDEOCUT_DATA_DIR ??
      resolve(homedir(), ".chengfeng-videocut"),
  );
  const projectsDir = resolve(
    options.projectsDir ??
      process.env.CHENGFENG_VIDEOCUT_PROJECTS_DIR ??
      process.env.VIDEO_WORKBENCH_PROJECTS_DIR ??
      resolve(dataDir, "projects"),
  );
  const rendersDir = resolve(dataDir, "renders");
  const staticDir = resolveStaticDir(options.staticDir);
  // Snapshot the complete Studio bundle once. A production server must keep
  // serving one coherent build even when a developer rebuilds dist in place;
  // otherwise index.html and hashed chunks can come from different builds and
  // strand already-open tabs on a blank page.
  const staticSnapshot = await loadStudioStaticSnapshot(staticDir);
  // The service owner supplies this marker in the LaunchAgent environment.
  // Capture it once at startup so health describes this process rather than a
  // later mutation of process.env by embedding code or tests.
  const runtimeMode: StudioRuntimeMode =
    process.env.CHENGFENG_VIDEOCUT_SERVICE === "launchd" ||
    process.env.CHENGFENG_VIDEOCUT_SERVICE === "windows-task"
      ? process.env.CHENGFENG_VIDEOCUT_SERVICE
      : "foreground";
  // 启动时对本进程环境做一次媒体工具预检。结果进健康报文与启动日志——
  // 「服务进程找不到 ffmpeg」要在这里被说出来，而不是等到第一个预览请求 500。
  const mediaToolsMissing: string[] = [];
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    if (!(await findExecutable(tool))) mediaToolsMissing.push(tool);
  }
  if (mediaToolsMissing.length > 0) {
    console.error(
      `[chengfeng-videocut] 服务进程的 PATH 找不到 ${mediaToolsMissing.join("、")}。` +
      `预览与导出会失败。如果终端里可用，请运行 chengfeng-videocut service restart ` +
      `让服务读到安装后的新环境。`,
    );
  }
  const listenPort = await resolveListenPort(host, requestedPort);
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectsDir, { recursive: true }),
    mkdir(rendersDir, { recursive: true }),
  ]);

  const events = new StudioEventHub();
  const operationAuditStore = new OperationAuditStore(dataDir);
  const jobs = new JobManager(dataDir, { projectsDir, concurrency: resolveJobConcurrency(options.jobConcurrency) });
  await jobs.initialize();
  const jobsApi = createJobsApi(jobs, listenPort, { operationAuditStore });
  const connectionApi = createConnectionApi(projectsDir, listenPort);
  const moduleApi = createModuleApi(projectsDir,listenPort);
  const ingestApi = createIngestApi(projectsDir, dataDir, listenPort, options.ingest);
  const editPreviewArtifacts = new EditPreviewArtifactManager(projectsDir);
  const editPreviewArtifactApi = createEditPreviewArtifactHandler(editPreviewArtifacts);
  const context: StudioServerApiContext = { projectsDir, dataDir, events };
  const productApi = options.apiHandler ?? options.extraApiHandler;
  const materializeEditListIndex = async (
    change: { projectId: string; revision: string },
  ): Promise<void> => {
    const projectDirectory = resolve(projectsDir, change.projectId);
    const result = await serializeProjectOperation(projectDirectory, () =>
      materializeKouboEditListIndex(
        projectDirectory,
        { expectedRevision: change.revision },
      ));
    if (result.materialized) {
      events.publish("file-change", {
        projectId: change.projectId,
        path: result.indexPath,
      });
    }
  };
  const cutsApi = createVideocutCutsHandler({
    projectsDir,
    operationAuditStore,
    materializeIndex: materializeEditListIndex,
    async deriveCutRanges(projectDir, selection) {
      const input = await projectInput(projectsDir, selection.previousEditList.projectId);
      return deriveSemanticCutRanges(selection, input.previewProxySource
        ? (ranges) => placeCutBoundaries({
          projectDir, proxySource: input.previewProxySource!,
          proxyCacheKey: input.previewProxyCacheKey, ranges, refineDeletedTails: true,
        })
        : undefined);
    },
    refineSeams: (projectDir, input) => refineSeams({ projectDir, ...input }),
    onDocumentChanged(change) {
      events.publish("file-change", change);
      editPreviewArtifacts.schedule(change.projectId);
    },
  });
  const editListApi = createVideocutEditListHandler({
    refineSeams: (projectDir, input) => refineSeams({ projectDir, ...input }),
    projectsDir,
    materializeIndex: materializeEditListIndex,
    // The ledger decides where every cut sits, once, using the audio — and nothing
    // downstream is allowed to move it afterwards.
    async placeBoundaries(projectDir, ranges) {
      // Best effort by design: placing a cut well is an improvement, not a
      // precondition for editing. A project with no proxy yet, or a proxy that
      // cannot be read, must still be editable — so anything that goes wrong here
      // leaves the boundaries exactly as asked rather than refusing the write.
      try {
        const input = await projectInput(projectsDir, basename(projectDir));
        if (!input.previewProxySource) return [...ranges];
        return await placeCutBoundaries({
          projectDir,
          proxySource: input.previewProxySource,
          proxyCacheKey: input.previewProxyCacheKey,
          ranges,
        });
      } catch {
        return [...ranges];
      }
    },
    onDocumentChanged(change) {
      events.publish("file-change", change);
      editPreviewArtifacts.schedule(change.projectId);
    },
  });
  const subtitlesApi = createVideocutSubtitlesHandler({
    projectsDir,
    onDocumentChanged(change) {
      events.publish("file-change", change);
    },
  });
  const visualsApi = createVideocutVisualsHandler({
    projectsDir,
    onDocumentChanged(change) {
      events.publish("file-change", change);
    },
  });
  const soundEffectsApi = createSoundEffectsApi(projectsDir, listenPort, {isBusy: directory => jobs.isProjectBusy(directory), onChanged: id => editPreviewArtifacts.schedule(id)});
  const mediaAssetsApi = createMediaAssetsApi(projectsDir, listenPort);
  const projectConfigApi = createProjectConfigApi({ projectsDir, port: listenPort,
    isBusy: directory => jobs.isProjectBusy(directory),
    // Narration level is part of the preview mix: rebuild it like a sound-effect change.
    onChanged(change) { events.publish("file-change", change); editPreviewArtifacts.schedule(change.projectId); },
  });
  const multisourceApi = createMultisourceApi({ projectsDir, port: listenPort,
    isBusy: directory => jobs.isProjectBusy(directory),
    onChanged(projectId) { events.publish("file-change", { projectId, path: "edit-list.json" }); editPreviewArtifacts.schedule(projectId); },
  });
  const workflowApi = createVideocutWorkflowHandler({
    projectsDir,
    onProjectChanged(change) {
      events.publish("file-change", change);
    },
  });
  const timelineMediaApi = createVideocutTimelineMediaHandler({
    projectsDir,
    cacheDir: resolve(dataDir, "cache", "timeline-media"),
  });
  // Old `#project/<id>` bookmarks are ambiguous with generic HyperFrames
  // projects.  This handler reads and positively verifies the Koubo artifacts;
  // it must run before the generic API and must never prepare or repair state.
  const projectSurfaceApi = createVideocutProjectSurfaceHandler({ projectsDir });
  const projectMedia = createProjectMediaHandler({ projectsDir });
  const studioAdapter = createProductionStudioAdapter({ projectsDir, rendersDir });
  const studioApi = createStudioApi(studioAdapter);
  let eventStreams = 0;

  const idle = new IdleLifecycle(options.idleTimeoutSeconds ?? 0, async () => {
    const blockers: string[] = [];
    if (await jobs.isBusy()) blockers.push("jobs");
    if (ingestApi.isBusy()) blockers.push("ingest");
    if (editPreviewArtifacts.isBusy()) blockers.push("preview");
    // Bun owns transmission after fetch returns, including sendfile/range
    // responses. Preserve those native bodies and subtract perpetual SSE only.
    if (server.pendingRequests > eventStreams) blockers.push("response_streams");
    return blockers;
  }, async () => {
    lifecycle.record("idle_timeout", { timeoutSeconds: options.idleTimeoutSeconds ?? 0 });
    try { await stop(); if (options.installSignalHandlers) process.exit(0); }
    catch { if (options.installSignalHandlers) process.exit(1); }
  });

  const server = Bun.serve({
    hostname: host,
    port: listenPort,
    // Long video range requests and the Studio event stream must survive the
    // framework's 10-second default idle window.
    idleTimeout: STUDIO_SERVER_IDLE_TIMEOUT_SECONDS,
    async fetch(request, bunServer): Promise<Response> {
      const url = new URL(request.url);
      // GET API status/health polling and SSE admission are not human activity.
      // Handlers hold admission; Bun's native pendingRequests covers bodies.
      const release = idle.admit(url.pathname !== "/api/runtime/activity" &&
        (!url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(request.method)));
      if (!release) return Response.json({ error: { code: "runtime_stopping" } }, { status: 503 });
      try {
      const handle = async (): Promise<Response> => {
      const dispatch = async (): Promise<Response> => {
      try {
        if (url.pathname === "/api/runtime/activity") return idle.activity(request, listenPort, bunServer.requestIP(request)?.address);
        // These product-owned offline dependencies must win before any
        // pluggable or generic API handler can claim the same /api paths.
        const vendorAsset = VENDOR_ASSETS.get(url.pathname);
        if (vendorAsset) return vendorAssetResponse(request, vendorAsset);
        if (url.pathname === "/api/health") {
          return healthResponse(request, staticSnapshot.buildId, runtimeMode, mediaToolsMissing);
        }
        const multisourceResponse = await multisourceApi(request, bunServer.requestIP(request)?.address);
        if (multisourceResponse) return multisourceResponse;
        const projectMatch = /^\/api\/(?:v1\/)?projects\/([^/]+)/.exec(url.pathname);
        if (projectMatch) {
          const id = decodeURIComponent(projectMatch[1]!);
          if (id && !/[\\/\0]/.test(id) && id !== "." && id !== "..") {
            try {
              await assertProjectReadable(resolve(projectsDir, id));
            } catch (error) {
              // A request refused here never reaches the API that would record
              // it; the page only sees a failure. Leave a line on the project.
              if (error instanceof VideocutError && error.code === "operation_in_progress") {
                await recordBlockedRequest(resolve(projectsDir, id), id, request.method, url.pathname, error);
              }
              throw error;
            }
          }
        }
        const jobsResponse = await jobsApi(request, bunServer.requestIP(request)?.address);
        const ingestResponse = await ingestApi(request, bunServer.requestIP(request)?.address);
        if (ingestResponse) return ingestResponse;
        const connectionResponse = await connectionApi(request, bunServer.requestIP(request)?.address);
        const moduleResponse = await moduleApi(request,bunServer.requestIP(request)?.address);
        const soundEffectsResponse = await soundEffectsApi(request, bunServer.requestIP(request)?.address);
        if (soundEffectsResponse) return soundEffectsResponse;
        const assetResponse = await mediaAssetsApi(request, bunServer.requestIP(request)?.address);
        const configResponse = await projectConfigApi(request, bunServer.requestIP(request)?.address);
        if (configResponse) return configResponse;
        if (assetResponse) return assetResponse;
        if(moduleResponse)return moduleResponse;
        if (connectionResponse) return connectionResponse;
        const directoryResponse = skillDirectoryResponse(request);
        if (directoryResponse) return directoryResponse;
        if (jobsResponse) return jobsResponse;
        const mediaResponse = await projectMedia(request);
        if (mediaResponse) return mediaResponse;
        const timelineMediaResponse = await timelineMediaApi(request);
        if (timelineMediaResponse) return timelineMediaResponse;
        const projectSurfaceResponse = await projectSurfaceApi(request);
        if (projectSurfaceResponse) return projectSurfaceResponse;
        const editPreviewArtifactResponse = await editPreviewArtifactApi(request);
        if (editPreviewArtifactResponse) return editPreviewArtifactResponse;
        if (url.pathname.startsWith("/api/") && productApi) {
          const response = await productApi(request, context);
          if (response) return response;
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await workflowApi(request);
          if (response) return response;
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await editListApi(request);
          if (response) return response;
        }
        const seamsMatch = /^\/api\/v1\/projects\/([^/]+)\/seams$/.exec(url.pathname);
        if (seamsMatch && request.method === "GET") {
          // Seams still audible after automatic refinement: continuous speech a
          // person should listen to. Read-only; never moves a boundary.
          const id = decodeURIComponent(seamsMatch[1]!);
          if (!id || /[\\/\0]/.test(id) || id === "." || id === "..") return Response.json({ error: { code: "invalid_argument" } }, { status: 400 });
          const { resolveProject: resolveProjectDir, readOptionalProjectDocument } = await import("@video-workbench/core/node");
          const project = await resolveProjectDir(resolve(projectsDir, id));
          const edl = await readOptionalProjectDocument(project, "edit-list.json");
          if (!edl) return Response.json({ projectId: id, editListRevision: null, seams: [] });
          const seams = await audibleSeams(project.directory, parseEditListDocument(edl.value));
          return Response.json({ projectId: id, editListRevision: edl.revision, seams }, { headers: { "Cache-Control": "no-store" } });
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await cutsApi(request);
          if (response) return response;
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await subtitlesApi(request);
          if (response) return response;
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await visualsApi(request);
          if (response) return response;
        }
        if (url.pathname === "/api/runtime.js") {
          return new Response(hyperframesRuntimeSource, {
            headers: {
              "Cache-Control": "public, max-age=31536000, immutable",
              "Content-Type": "text/javascript; charset=utf-8",
            },
          });
        }
        if (url.pathname === "/api/events") return events.response();
        if (url.pathname.startsWith("/api/")) {
          const apiUrl = new URL(request.url);
          apiUrl.pathname = apiUrl.pathname.slice(4);
          const apiRequest = new Request(apiUrl, request);
          return await localizeStudioResponse(await fetchGuardedStudioApi(apiRequest, {
            adapter: studioAdapter,
            fetch: (guardedRequest) => studioApi.fetch(guardedRequest),
          }));
        }
        return await staticResponse(request, url, staticSnapshot);
      } catch (error) {
        if (error instanceof VideocutError && error.code === "operation_in_progress") {
          return Response.json({ error: { code: error.code, message: error.message } }, { status: 409 });
        }
        console.error("[chengfeng-videocut] request failed", error);
        return Response.json(
          { error: "internal_error", message: "Internal server error" },
          { status: 500 },
        );
      }
      };
      // Readers share the writer lock so a multi-file commit is never served
      // halfway through. The two-project splice route acquires sorted locks itself.
      const binding = /^\/api\/(?:v1\/)?projects\/([^/]+)/.exec(url.pathname);
      if (binding && !/^\/api\/v1\/projects\/[^/]+\/sources(?:\/|$)/.test(url.pathname)) {
        try {
          const id = decodeURIComponent(binding[1]!);
          if (id && !/[\\/\0]/.test(id) && id !== "." && id !== "..") {
            return await serializeProjectOperation(resolve(projectsDir, id), dispatch);
          }
        } catch (error) {
          if (error instanceof URIError) return Response.json({ error: "invalid_project_id" }, { status: 400 });
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ error: "project_not_found" }, { status: 404 });
          throw error;
        }
      }
      return await dispatch();
      };
      const response = await handle();
      // Do not even access .body for file responses: Bun materializes that
      // stream lazily and doing so can discard its native range/sendfile path.
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return response;
      const reader = response.body.getReader();
      eventStreams++;
      let ended = false;
      const endStream = () => { if (!ended) { ended = true; eventStreams--; } };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) { controller.close(); endStream(); }
            else controller.enqueue(part.value);
          } catch (error) { controller.error(error); endStream(); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { endStream(); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally { release(); }
    },
  });

  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    events.close();
    throw new Error("Studio server did not report its listening port");
  }
  const url = `http://${hostForUrl(host)}:${port}`;
  const projectWatcher = watchRegisteredProjects(projectsDir, events);
  let stopPromise: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const stopObserving = options.installSignalHandlers ? lifecycle.observe() : () => {};
  lifecycle.record("listening", { port, host, runtimeMode });
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    idle.stopAdmission();
    lifecycle.record("stopping");
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    projectWatcher.close();
    events.close();
    const serverClosed = server.stop(true);
    stopPromise = (async () => { try {
      // Admitted handlers can still create detached owners. Drain those first,
      // then close their managers; never close a manager underneath a write.
      await idle.drain();
      // Wait for all owners even if one shutdown reports a failure.
      const results = await Promise.allSettled([editPreviewArtifacts.close(), ingestApi.drain(), serverClosed, jobs.shutdown()]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      lifecycle.record("stopped");
    } catch (error) {
      lifecycle.record("stop_failed");
      throw error;
    } finally { stopObserving(); } })();
    return stopPromise;
  };

  if (options.installSignalHandlers) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        lifecycle.record("signal", { signal });
        void stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  idle.start();
  return { host, port, url, projectsDir, dataDir, events, stop };
}
