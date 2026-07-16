import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import hyperframesRuntimeSource from "@hyperframes/core/runtime" with { type: "text" };
import { createStudioApi } from "@hyperframes/studio-server";
import customEaseSource from "gsap/dist/CustomEase.min.js" with { type: "text" };
import motionPathPluginSource from "gsap/dist/MotionPathPlugin.min.js" with { type: "text" };
import gsapSource from "gsap/dist/gsap.min.js" with { type: "text" };
import { createVideocutCutsHandler } from "../../../studio/src/server/videocutCutsApi";
import { StudioEventHub } from "./events";
import { createProjectMediaHandler } from "./project-media";
import { watchRegisteredProjects } from "./project-watcher";
import { createProductionStudioAdapter } from "./studio-adapter";
import { createVideocutWorkflowHandler } from "./workflow-api";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5190;

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

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
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

async function staticResponse(
  request: Request,
  url: URL,
  staticDir: string,
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
  let filePath = resolve(staticDir, requested);
  if (!isWithin(staticDir, filePath)) return new Response("Not Found", { status: 404 });

  let file = Bun.file(filePath);
  if (!(await file.exists())) {
    if (extname(requested)) return new Response("Not Found", { status: 404 });
    filePath = resolve(staticDir, "index.html");
    file = Bun.file(filePath);
  }

  const headers = new Headers({
    "Content-Type": mimeType(filePath),
    "Cache-Control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : filePath.endsWith("index.html")
        ? "no-store"
        : "public, max-age=3600",
  });
  return new Response(request.method === "HEAD" ? null : file, { headers });
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
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectsDir, { recursive: true }),
    mkdir(rendersDir, { recursive: true }),
  ]);

  const events = new StudioEventHub();
  const context: StudioServerApiContext = { projectsDir, dataDir, events };
  const productApi = options.apiHandler ?? options.extraApiHandler;
  const cutsApi = createVideocutCutsHandler({
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
  const projectMedia = createProjectMediaHandler({ projectsDir });
  const studioApi = createStudioApi(
    createProductionStudioAdapter({ projectsDir, rendersDir }),
  );

  const server = Bun.serve({
    hostname: host,
    port: requestedPort,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      try {
        // These product-owned offline dependencies must win before any
        // pluggable or generic API handler can claim the same /api paths.
        const vendorAsset = VENDOR_ASSETS.get(url.pathname);
        if (vendorAsset) return vendorAssetResponse(request, vendorAsset);
        const mediaResponse = await projectMedia(request);
        if (mediaResponse) return mediaResponse;
        if (url.pathname.startsWith("/api/") && productApi) {
          const response = await productApi(request, context);
          if (response) return response;
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await workflowApi(request);
          if (response) return response;
        }
        if (url.pathname.startsWith("/api/")) {
          const response = await cutsApi(request);
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
          return await localizeStudioResponse(await studioApi.fetch(apiRequest));
        }
        return await staticResponse(request, url, staticDir);
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
