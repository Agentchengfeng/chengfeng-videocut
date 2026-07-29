/// <reference types="node" />

/**
 * `/api/v1/projects/:id/visuals` — read and write the visual layers, and serve
 * the HTML modules they name.
 *
 * A GET returns two things, and only the first is stored:
 *
 * ```text
 * document   which layers exist, and which words each covers   read from visuals.json
 * timings    when each layer is on screen                      computed from transcript + edit list
 * ```
 *
 * Timing is recomputed on every read for the same reason the subtitles do it: a
 * stored answer about "when" goes wrong the instant someone edits the cut, and
 * it goes wrong silently.
 *
 * `GET …/visuals/module/<path>` returns a module's HTML so the preview can load
 * it in a frame. It is a separate route rather than an inlined string because a
 * module carries its own vendored GSAP and can run to hundreds of kilobytes —
 * paying that on every poll of the document would be absurd. The path is
 * confined to the project directory here as well as in the document validator:
 * this route is reachable with any path, not only the ones already stored.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  VideocutError,
  asVideocutError,
  parseTranscriptWords,
  visualLayerTimings,
  type VisualLayerTiming,
} from "@video-workbench/core";
import {
  readEditList,
  readOptionalProjectDocument,
  readVisuals,
  resolveProject,
  writeVisuals,
} from "@video-workbench/core/node";

const API_SCHEMA_VERSION = 1 as const;
const REVISION_PATTERN = /^(?:none|[a-f0-9]{64})$/;

export interface VideocutVisualsChange {
  projectId: string;
  path: string;
  revision: string;
}

export interface VideocutVisualsHandlerOptions {
  projectsDir: string;
  onDocumentChanged?: (change: VideocutVisualsChange) => void | Promise<void>;
}

type VideocutVisualsHandler = (request: Request) => Promise<Response | null>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse(
    {
      schemaVersion: API_SCHEMA_VERSION,
      ok: false,
      error: { code, message, ...(details ? { details } : {}) },
    },
    status,
  );
}

function errorStatus(error: VideocutError): number {
  switch (error.code) {
    case "project_not_found":
      return 404;
    case "revision_conflict":
      return 409;
    case "invalid_argument":
    case "invalid_project":
    case "invalid_json":
    case "invalid_transcript":
    case "invalid_edit_list":
    case "invalid_visuals":
      return 400;
    default:
      return 500;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

interface VisualsRoute {
  projectId: string;
  /** Set for the module route; absent for the document route. */
  modulePath?: string;
}

function matchRoute(pathname: string): VisualsRoute | null {
  const segments = pathSegments(pathname);
  if (segments.length < 5) return null;
  if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "projects") return null;
  if (segments[4] !== "visuals") return null;

  let projectId: string;
  try {
    projectId = decodeURIComponent(segments[3] as string);
  } catch {
    throw new VideocutError("invalid_argument", "Project id is not valid URL encoding");
  }

  if (segments.length === 5) return { projectId };
  if (segments[5] !== "module" || segments.length < 7) return null;
  let modulePath: string;
  try {
    modulePath = segments.slice(6).map((part) => decodeURIComponent(part)).join("/");
  } catch {
    throw new VideocutError("invalid_argument", "Module path is not valid URL encoding");
  }
  return { projectId, modulePath };
}

function assertProjectId(projectId: string): void {
  if (
    !projectId
    || projectId === "."
    || projectId === ".."
    || projectId.includes("/")
    || projectId.includes("\\")
    || projectId.includes("\0")
  ) {
    throw new VideocutError("invalid_argument", `Invalid project id: ${projectId}`);
  }
}

export function isVideocutVisualsRequest(_method: string, pathname: string): boolean {
  try {
    return matchRoute(pathname) !== null;
  } catch {
    // Bad URL encoding on a structurally matching route belongs here, so it gets
    // a stable invalid_argument rather than falling through to the SPA.
    return true;
  }
}

async function readJsonRequest(request: Request): Promise<unknown> {
  const source = await request.text();
  try {
    return JSON.parse(source || "null") as unknown;
  } catch {
    throw new VideocutError("invalid_json", "Visuals request body is not valid JSON");
  }
}

interface VisualsPutBody {
  expectedRevision: string;
  document: unknown;
}

function parsePutBody(value: unknown): VisualsPutBody {
  if (!isObject(value)) {
    throw new VideocutError("invalid_argument", "Visuals request body must be a JSON object");
  }
  const allowed = new Set(["expectedRevision", "document"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new VideocutError("invalid_argument", "Visuals request body contains unsupported fields", {
      unsupportedFields: unexpected,
    });
  }
  if (typeof value.expectedRevision !== "string" || !REVISION_PATTERN.test(value.expectedRevision)) {
    throw new VideocutError(
      "invalid_argument",
      "expectedRevision is required and must be 'none' or a SHA-256 revision",
    );
  }
  if (!isObject(value.document)) {
    throw new VideocutError("invalid_argument", "document must be a visual document object");
  }
  return { expectedRevision: value.expectedRevision, document: value.document };
}

async function derivedTimings(
  project: Awaited<ReturnType<typeof resolveProject>>,
  document: Awaited<ReturnType<typeof readVisuals>>,
): Promise<{ timings: VisualLayerTiming[]; transcriptRevision: string | null }> {
  const [transcript, editList] = await Promise.all([
    readOptionalProjectDocument(project, "transcript.json"),
    readEditList(project),
  ]);
  if (!document) return { timings: [], transcriptRevision: transcript?.revision ?? null };
  const words = transcript ? parseTranscriptWords(transcript.value) : [];
  return {
    timings: visualLayerTimings(document.value, words, editList?.value ?? null),
    transcriptRevision: transcript?.revision ?? null,
  };
}

/**
 * A cheap identity for each module's entry file, keyed by module path.
 *
 * The layers document changes revision when a layer is added or removed, but
 * rewriting a module's HTML changes nothing the document can see — and the
 * review loop is exactly that: the Agent edits a module, the person looks
 * again. The stamp (mtime + size) rides the GET response so the preview can
 * notice the edit and reload just that frame, instead of asking the person to
 * refresh the page to find out whether anything happened.
 */
async function moduleStamps(
  projectDirectory: string,
  document: Awaited<ReturnType<typeof readVisuals>>,
): Promise<Record<string, string>> {
  const stamps: Record<string, string> = {};
  for (const layer of document?.value.layers ?? []) {
    if (stamps[layer.module]) continue;
    try {
      const info = await stat(resolve(projectDirectory, layer.module));
      stamps[layer.module] = `${Math.round(info.mtimeMs)}-${info.size}`;
    } catch {
      // A missing module is already reported where it matters; the stamp only
      // has to be stable so the preview does not reload a frame for nothing.
      stamps[layer.module] = "missing";
    }
  }
  return stamps;
}

/**
 * What a module is allowed to be made of.
 *
 * A module is a small site, not a single file: it carries its own vendored
 * GSAP, its icons, sometimes a font. Serving only the HTML looks like it works
 * — the frame mounts, the page is there — and then every asset 404s and the
 * animation silently never runs. That is exactly how the first version of this
 * failed: a white rectangle where the drawing should be, with nothing in the
 * product reporting a fault.
 *
 * Anything not on this list is refused rather than guessed at. The frame runs
 * project content, and the list is what keeps "serve a file from the project"
 * from becoming "serve any file in the project".
 */
const MODULE_CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
};

/**
 * Serve one file of a module.
 *
 * `resolve` collapses `..` before the check, so a traversal attempt lands
 * outside the project prefix and is refused — checking the raw string would
 * miss `a/../../etc/passwd`.
 */
async function moduleResponse(projectDirectory: string, modulePath: string): Promise<Response> {
  const extension = modulePath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MODULE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new VideocutError("invalid_argument", "That is not a file a visual module may serve", {
      module: modulePath,
    });
  }
  const absolute = resolve(projectDirectory, modulePath);
  if (absolute !== projectDirectory && !absolute.startsWith(`${projectDirectory}${sep}`)) {
    throw new VideocutError("invalid_argument", "A visual module must stay inside the project", {
      module: modulePath,
    });
  }
  let body: Buffer;
  try {
    body = await readFile(absolute);
  } catch {
    throw new VideocutError("project_not_found", "That visual module file is not in the project", {
      module: modulePath,
    });
  }
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // The frame is driven by the player, and a stale module would animate
      // against the wrong timeline without ever looking broken.
      "Cache-Control": "no-store",
    },
  });
}

export function createVideocutVisualsHandler(
  options: VideocutVisualsHandlerOptions,
): VideocutVisualsHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    let route: VisualsRoute | null;
    try {
      route = matchRoute(url.pathname);
    } catch (error) {
      const normalized = asVideocutError(error);
      return errorResponse(errorStatus(normalized), normalized.code, normalized.message, normalized.details);
    }
    if (route === null) return null;

    try {
      assertProjectId(route.projectId);
      const project = await resolveProject(resolve(options.projectsDir, route.projectId));

      if (route.modulePath !== undefined) {
        if (request.method !== "GET") {
          return errorResponse(405, "method_not_allowed", "Only GET is supported for modules");
        }
        return await moduleResponse(project.directory, route.modulePath);
      }

      if (request.method !== "GET" && request.method !== "PUT") {
        return errorResponse(405, "method_not_allowed", "Only GET and PUT are supported");
      }

      if (request.method === "GET") {
        const current = await readVisuals(project);
        const derived = await derivedTimings(project, current);
        const revision = current?.revision ?? "none";
        return jsonResponse(
          {
            schemaVersion: API_SCHEMA_VERSION,
            projectId: project.projectId,
            exists: Boolean(current),
            revision,
            document: current?.value ?? null,
            moduleStamps: await moduleStamps(project.directory, current),
            ...derived,
          },
          200,
          { ETag: `"${revision}"` },
        );
      }

      const body = parsePutBody(await readJsonRequest(request));
      const result = await writeVisuals(project, body.document, {
        expectedRevision: body.expectedRevision,
        actor: "studio-transcript",
      });
      if (result.changed && options.onDocumentChanged) {
        try {
          await options.onDocumentChanged({
            projectId: project.projectId,
            path: result.path,
            revision: result.revision,
          });
        } catch {
          // Persistence already succeeded. A notification failure must not turn
          // a committed write into an apparent request failure and invite retry.
        }
      }
      const derived = await derivedTimings(project, {
        value: result.document,
        revision: result.revision,
        raw: "",
      });
      return jsonResponse(
        {
          schemaVersion: API_SCHEMA_VERSION,
          projectId: project.projectId,
          exists: true,
          changed: result.changed,
          previousRevision: result.previousRevision ?? "none",
          revision: result.revision,
          document: result.document,
          ...derived,
        },
        200,
        { ETag: `"${result.revision}"` },
      );
    } catch (error) {
      const normalized = asVideocutError(error);
      return errorResponse(errorStatus(normalized), normalized.code, normalized.message, normalized.details);
    }
  };
}
