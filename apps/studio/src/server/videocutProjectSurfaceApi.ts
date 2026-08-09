/// <reference types="node" />

/**
 * Read-only compatibility classifier for the Studio entry point.
 *
 * A legacy `#project/<id>` URL is also a valid generic HyperFrames URL.  The
 * Studio must therefore never infer its surface from the hash alone.  This
 * endpoint names a project `koubo` only after independently checking the
 * immutable source binding, the Koubo documents and the generated projection.
 * It deliberately does not call `prepare`, materialize an index, or repair
 * anything: opening an old bookmark is not permission to mutate a project.
 */

import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseEditListDocument } from "@video-workbench/core";
import { resolveProject } from "@video-workbench/core/node";

const API_SCHEMA_VERSION = 1 as const;
const SURFACE = "koubo" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SURFACE_ROUTE = /^\/api\/projects\/([^/]+)\/surface$/;
const GENERATED_INDEX_MARKERS = [
  "generated-by: chengfeng-videocut",
  // The older generator used this marker.  It is still a product-generated
  // Koubo projection and needs legacy-link compatibility too.
  "generated-by: koubo-video-workbench",
] as const;

const REQUIRED_ARTIFACTS = {
  workbenchEntry: "index.html",
  workbenchTranscript: "transcript.json",
  workbenchCutSelection: "cut-selection.json",
  workbenchEditList: "edit-list.json",
} as const;

export interface VideocutProjectSurfaceHandlerOptions {
  projectsDir: string;
}

export type VideocutProjectSurfaceHandler = (
  request: Request,
) => Promise<Response | null>;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function validProjectId(value: string): boolean {
  return Boolean(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0");
}

function validProjectRelativePath(value: unknown): value is string {
  return typeof value === "string" &&
    Boolean(value) &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((segment) => segment === "." || segment === "..");
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return jsonResponse({
    schemaVersion: API_SCHEMA_VERSION,
    ok: false,
    error: { code, message },
  }, status, headers);
}

function surfaceProjectId(pathname: string): string | null {
  const match = SURFACE_ROUTE.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    throw new Error("invalid_project_id_encoding");
  }
}

/** Whether this URL belongs to the product-owned project-surface API. */
export function isVideocutProjectSurfaceRequest(_method: string, pathname: string): boolean {
  // Claim every structurally matching route so unsupported methods receive the
  // product API's 405 rather than falling through into a generic file route.
  return SURFACE_ROUTE.test(pathname);
}

/**
 * Resolve a constant project-local path without ever following it outside the
 * resolved project directory.  Existing projects may themselves be registered
 * by symlink; that is fine because `projectDirectory` is already its real path.
 */
async function safeProjectFile(
  projectDirectory: string,
  relativePath: string,
): Promise<{ content: string } | null> {
  if (!validProjectRelativePath(relativePath)) return null;
  try {
    const root = await realpath(projectDirectory);
    const file = await realpath(resolve(root, relativePath));
    if (!isWithin(root, file)) return null;
    if (!(await stat(file)).isFile()) return null;
    return { content: await readFile(file, "utf8") };
  } catch {
    return null;
  }
}

async function safeProjectFileExists(
  projectDirectory: string,
  relativePath: string,
): Promise<boolean> {
  if (!validProjectRelativePath(relativePath)) return false;
  try {
    const root = await realpath(projectDirectory);
    const file = await realpath(resolve(root, relativePath));
    return isWithin(root, file) && (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function parseJsonObject(content: string): JsonObject | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function exactArtifacts(value: unknown): boolean {
  if (!isObject(value)) return false;
  return Object.entries(REQUIRED_ARTIFACTS).every(([key, expected]) => value[key] === expected);
}

function sourceBinding(project: JsonObject): { path: string; sha256: string } | null {
  if (!isObject(project.source)) return null;
  const path = project.source.path;
  const sha256 = nonEmptyString(project.source.sha256);
  if (!validProjectRelativePath(path) || !sha256 || !SHA256_PATTERN.test(sha256)) return null;
  if (project.source.immutable !== true) return null;
  return { path, sha256 };
}

/**
 * Positive proof for a complete Koubo project.  Every failure returns false:
 * callers must retain the generic Studio rather than guess or repair state.
 */
async function isCompleteKouboProject(
  requestedProjectId: string,
  projectDirectory: string,
  project: JsonObject,
): Promise<boolean> {
  const source = sourceBinding(project);
  const manifestWorkbench = isObject(project.workbench) ? project.workbench : null;
  if (!source || !manifestWorkbench || !exactArtifacts(project.artifacts)) return false;
  if (manifestWorkbench.projectId !== requestedProjectId) return false;
  // New project manifests carry the explicit marker.  Old manifests do not,
  // so its absence is accepted only after all the legacy evidence below passes.
  if (manifestWorkbench.surface !== undefined && manifestWorkbench.surface !== SURFACE) return false;

  const [sourceExists, workbenchFile, transcriptFile, cutsFile, editListFile, indexFile] =
    await Promise.all([
      safeProjectFileExists(projectDirectory, source.path),
      safeProjectFile(projectDirectory, "workbench.json"),
      safeProjectFile(projectDirectory, REQUIRED_ARTIFACTS.workbenchTranscript),
      safeProjectFile(projectDirectory, REQUIRED_ARTIFACTS.workbenchCutSelection),
      safeProjectFile(projectDirectory, REQUIRED_ARTIFACTS.workbenchEditList),
      safeProjectFile(projectDirectory, REQUIRED_ARTIFACTS.workbenchEntry),
    ]);
  if (!sourceExists || !workbenchFile || !transcriptFile || !cutsFile || !editListFile || !indexFile) {
    return false;
  }

  const workbench = parseJsonObject(workbenchFile.content);
  const transcript = parseJsonObject(transcriptFile.content);
  const cuts = parseJsonObject(cutsFile.content);
  if (!workbench || !transcript || !cuts) return false;
  if (
    workbench.schemaVersion !== 1 ||
    workbench.projectId !== requestedProjectId ||
    workbench.videoSource !== source.path ||
    workbench.sourceSha256 !== source.sha256
  ) return false;
  if (transcript.schemaVersion !== 1 || !Array.isArray(transcript.cues)) return false;
  if (
    cuts.schemaVersion !== 3 ||
    !Array.isArray(cuts.cutWordIds) ||
    !Array.isArray(cuts.cutRanges)
  ) return false;

  let editList: ReturnType<typeof parseEditListDocument>;
  try {
    editList = parseEditListDocument(JSON.parse(editListFile.content) as unknown);
  } catch {
    return false;
  }
  if (
    editList.projectId !== requestedProjectId ||
    editList.baseTranscriptRevision !== digest(transcriptFile.content) ||
    editList.baseCutsRevision !== digest(cutsFile.content)
  ) return false;

  const indexRevision = digest(editListFile.content);
  return GENERATED_INDEX_MARKERS.some((marker) => indexFile.content.includes(marker)) &&
    indexFile.content.includes(`data-edit-list-revision="${indexRevision}"`) &&
    indexFile.content.includes('data-videocut-projection-schema="1"') &&
    indexFile.content.includes("data-videocut-projection-runtime=");
}

export function createVideocutProjectSurfaceHandler(
  options: VideocutProjectSurfaceHandlerOptions,
): VideocutProjectSurfaceHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    let projectId: string | null;
    try {
      projectId = surfaceProjectId(url.pathname);
    } catch {
      return errorResponse(400, "invalid_project_id", "Project id is not valid URL encoding");
    }
    if (projectId === null) return null;
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "Only GET is supported", { Allow: "GET" });
    }
    if (!validProjectId(projectId)) {
      return errorResponse(400, "invalid_project_id", "Project id is invalid");
    }

    try {
      const project = await resolveProject(resolve(options.projectsDir, projectId));
      // A directory name is a registry locator, not an identity assertion.
      // A mismatched jobId must never be classified for the URL that named it.
      if (project.projectId !== projectId) {
        return errorResponse(404, "project_surface_unknown", "Project surface is not Koubo");
      }
      if (!await isCompleteKouboProject(projectId, project.directory, project.project)) {
        return errorResponse(404, "project_surface_unknown", "Project surface is not Koubo");
      }
      return jsonResponse({
        schemaVersion: API_SCHEMA_VERSION,
        projectId,
        surface: SURFACE,
      });
    } catch {
      // This endpoint is a router hint, not an inspection endpoint.  Read
      // failures, malformed records and unknown IDs are deliberately one
      // fail-closed answer so a generic project never leaks into Koubo.
      return errorResponse(404, "project_surface_unknown", "Project surface is not Koubo");
    }
  };
}
