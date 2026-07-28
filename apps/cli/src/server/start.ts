import { createHash } from "node:crypto";
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
import { createVideocutTimelineMediaHandler } from "../../../studio/src/server/videocutTimelineMediaApi";
import { materializeKouboEditListIndex } from "@video-workbench/koubo-adapter";
import { serializeProjectOperation } from "@video-workbench/core/node";
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
import { fetchGuardedStudioApi } from "./studio-mutation-guard";
import { createVideocutWorkflowHandler } from "./workflow-api";
import { PRODUCT_VERSION } from "../output";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5190;
const STUDIO_SERVER_IDLE_TIMEOUT_SECONDS = 60;

type StudioRuntimeMode = "launchd" | "foreground";

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
  });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function startStudioServer(
  options: StartStudioServerOptions = {},
): Promise<RunningStudioServer> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  if (!host.trim()) throw new Error("--host must not be empty");
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("--port must be an integer from 0 to 65535");
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
    process.env.CHENGFENG_VIDEOCUT_SERVICE === "launchd" ? "launchd" : "foreground";
  const listenPort = await resolveListenPort(host, requestedPort);
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectsDir, { recursive: true }),
    mkdir(rendersDir, { recursive: true }),
  ]);

  const events = new StudioEventHub();
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
    materializeIndex: materializeEditListIndex,
    onDocumentChanged(change) {
      events.publish("file-change", change);
    },
  });
  const editListApi = createVideocutEditListHandler({
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
  const projectMedia = createProjectMediaHandler({ projectsDir });
  const studioAdapter = createProductionStudioAdapter({ projectsDir, rendersDir });
  const studioApi = createStudioApi(studioAdapter);

  const server = Bun.serve({
    hostname: host,
    port: listenPort,
    // Long video range requests and the Studio event stream must survive the
    // framework's 10-second default idle window.
    idleTimeout: STUDIO_SERVER_IDLE_TIMEOUT_SECONDS,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      try {
        // These product-owned offline dependencies must win before any
        // pluggable or generic API handler can claim the same /api paths.
        const vendorAsset = VENDOR_ASSETS.get(url.pathname);
        if (vendorAsset) return vendorAssetResponse(request, vendorAsset);
        if (url.pathname === "/api/health") {
          return healthResponse(request, staticSnapshot.buildId, runtimeMode);
        }
        const mediaResponse = await projectMedia(request);
        if (mediaResponse) return mediaResponse;
        const timelineMediaResponse = await timelineMediaApi(request);
        if (timelineMediaResponse) return timelineMediaResponse;
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
        console.error("[chengfeng-videocut] request failed", error);
        return Response.json(
          { error: "internal_error", message: "Internal server error" },
          { status: 500 },
        );
      }
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
  let stopped = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    projectWatcher.close();
    events.close();
    server.stop(true);
  };

  if (options.installSignalHandlers) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        void stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  return { host, port, url, projectsDir, dataDir, events, stop };
}
