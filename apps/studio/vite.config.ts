import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readNodeRequestBody } from "./vite.request-body.js";
import { createViteAdapter, isPathWithin } from "./vite.adapter";

async function loadRuntimeSourceForDev(
  server: import("vite").ViteDevServer,
): Promise<string | null> {
  try {
    const mod = await server.ssrLoadModule("@hyperframes/core");
    if (typeof mod.loadHyperframeRuntimeSource === "function") {
      const source = mod.loadHyperframeRuntimeSource();
      if (typeof source === "string" && source.trim()) return source;
    }
  } catch (err) {
    console.warn("[Studio] Failed to load runtime source from core:", err);
  }
  try {
    const runtimePath = createRequire(import.meta.url).resolve("@hyperframes/core/runtime");
    return readFileSync(runtimePath, "utf8");
  } catch (err) {
    console.warn("[Studio] Failed to load prebuilt runtime from core:", err);
    return null;
  }
}

const studioPkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

// ── Bridge Hono fetch → Node http response ───────────────────────────────────

async function bridgeHonoResponse(
  honoResponse: Response,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  honoResponse.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(honoResponse.status, headers);

  if (!honoResponse.body) {
    res.end();
    return;
  }

  const reader = honoResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* client disconnected */
  }
  res.end();
}

function isVideocutCutsMiddlewareRequest(method: string, pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const isCutsApi =
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "projects" &&
    segments[4] === "cuts";
  if (isCutsApi) return true;
  if (
    method.toUpperCase() !== "PUT" ||
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "projects" ||
    segments[3] !== "files"
  ) {
    return false;
  }
  try {
    return decodeURIComponent(segments[4]) === "cut-selection.json";
  } catch {
    return false;
  }
}

// ── Vite plugin ──────────────────────────────────────────────────────────────

function devProjectApi(): Plugin {
  const dataDir = resolve(
    process.env.VIDEO_WORKBENCH_PROJECTS_DIR ?? resolve(__dirname, "data/projects"),
  );

  return {
    name: "studio-dev-api",
    configureServer(server): void {
      let _api: { fetch: (req: Request) => Promise<Response> } | null = null;
      let _cutsApi: ((request: Request) => Promise<Response | null>) | null = null;
      const getCutsApi = async () => {
        if (!_cutsApi) {
          const mod = await server.ssrLoadModule("./src/server/videocutCutsApi.ts");
          _cutsApi = mod.createVideocutCutsHandler({
            projectsDir: dataDir,
            onDocumentChanged(change: { path: string; projectId: string }) {
              server.ws.send({
                type: "custom",
                event: "hf:file-change",
                data: { path: change.path, projectId: change.projectId },
              });
            },
          });
        }
        return _cutsApi;
      };
      const getApi = async () => {
        if (!_api) {
          const mod = await server.ssrLoadModule("@hyperframes/studio-server");
          const adapter = createViteAdapter(dataDir, server);
          _api = mod.createStudioApi(adapter);
        }
        return _api;
      };

      // Runtime endpoint is supplied by the versioned HyperFrames core package.
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/runtime.js") return next();
        const serve = async () => {
          const runtimeSource = await loadRuntimeSourceForDev(server);
          if (!runtimeSource) {
            res.writeHead(404);
            res.end("runtime not available from @hyperframes/core");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-store",
          });
          res.end(runtimeSource);
        };
        void serve().catch((err) => {
          console.error("[Studio runtime] Failed to serve runtime", err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("failed to serve runtime");
          }
        });
      });

      // Product-owned cut selection API. This sits before the generic Studio
      // file routes so cut-selection.json has one revision-aware write path.
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (!isVideocutCutsMiddlewareRequest(req.method ?? "GET", url.pathname)) return next();
        try {
          let body: Buffer | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            const bytes = await readNodeRequestBody(req);
            body = bytes.byteLength > 0 ? bytes : undefined;
          }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (value != null) headers[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          const cutsApi = await getCutsApi();
          const response = await cutsApi(
            new Request(url.toString(), {
              method: req.method,
              headers,
              body,
            }),
          );
          if (!response) return next();
          await bridgeHonoResponse(response, res);
        } catch (err) {
          console.error("[Studio cuts API] Error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              schemaVersion: 1,
              ok: false,
              error: { code: "internal_error", message: "Internal server error" },
            }));
          }
        }
      });

      // API middleware
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const api = await getApi();
          const url = new URL(req.url, `http://${req.headers.host}`);
          url.pathname = url.pathname.slice(4);
          let body: Buffer | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            const bytes = await readNodeRequestBody(req);
            body = bytes.byteLength > 0 ? bytes : undefined;
          }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (value != null) headers[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          const fetchReq = new Request(url.toString(), {
            method: req.method,
            headers,
            body,
          });
          const response = await api.fetch(fetchReq);
          await bridgeHonoResponse(response, res);
        } catch (err) {
          console.error("[Studio API] Error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      });

      // Watch project directories for file changes → HMR
      const realProjectPaths: Array<{ projectId: string; path: string }> = [];
      try {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
          const full = join(dataDir, entry.name);
          try {
            const real = lstatSync(full).isSymbolicLink() ? realpathSync(full) : full;
            realProjectPaths.push({ projectId: entry.name, path: real });
            server.watcher.add(real);
          } catch {
            /* skip broken symlinks */
          }
        }
      } catch {
        /* dataDir doesn't exist yet */
      }

      server.watcher.on("change", (filePath: string) => {
        const project = realProjectPaths.find((entry) =>
          isPathWithin(entry.path, filePath),
        );
        if (
          project &&
          (filePath.endsWith(".html") ||
            filePath.endsWith(".css") ||
            filePath.endsWith(".js") ||
            filePath.endsWith(".json"))
        ) {
          console.log(`[Studio] File changed: ${filePath}`);
          server.ws.send({
            type: "custom",
            event: "hf:file-change",
            data: { path: filePath, projectId: project.projectId },
          });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProjectApi()],
  define: {
    __STUDIO_VERSION__: JSON.stringify(studioPkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["bpm-detective"],
  },
  server: {
    port: 5200,
  },
  ssr: {
    // recast / @babel/parser are CommonJS and call `require("fs")`. They are
    // reachable only server-side via the Node-only `@hyperframes/parsers/gsap-parser`
    // subpath (studio-api GSAP mutations + the linter), which the dev server loads
    // through Vite SSR. Externalizing them makes SSR load the native Node modules
    // instead of esbuild-transforming the `require` into a shim that throws
    // "Dynamic require of fs is not supported". Browser bundles never reach them.
    external: ["recast", "@babel/parser", "ast-types"],
  },
  test: {
    exclude: ["data/**", "node_modules/**"],
    setupFiles: ["src/test-setup.ts"],
  },
});
