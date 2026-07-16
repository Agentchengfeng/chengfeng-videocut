/// <reference types="node" />

import { join, resolve } from "node:path";
import { VideocutError, asVideocutError } from "@video-workbench/core";
import {
  readOptionalProjectDocument,
  resolveProject,
  writeCutSelection,
} from "@video-workbench/core/node";

const API_SCHEMA_VERSION = 1 as const;
const CUT_SELECTION_FILE = "cut-selection.json" as const;
const REVISION_PATTERN = /^(?:none|[a-f0-9]{64})$/;

export interface VideocutCutsChange {
  projectId: string;
  path: string;
  revision: string;
}

export interface VideocutCutsHandlerOptions {
  projectsDir: string;
  onDocumentChanged?: (change: VideocutCutsChange) => void | Promise<void>;
}

type VideocutCutsHandler = (request: Request) => Promise<Response | null>;

interface CutsPutBody {
  expectedRevision: string;
  cutWordIds: unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
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
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
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
    case "invalid_cut_selection":
      return 400;
    default:
      return 500;
  }
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new VideocutError("invalid_argument", "Project id is not valid URL encoding");
  }
}

function assertProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("\0")
  ) {
    throw new VideocutError("invalid_argument", `Invalid project id: ${projectId}`);
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function cutsProjectId(pathname: string): string | null {
  const segments = pathSegments(pathname);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "v1" ||
    segments[2] !== "projects" ||
    segments[4] !== "cuts"
  ) {
    return null;
  }
  return decodedSegment(segments[3]);
}

function isLegacyCutSelectionPut(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== "PUT") return false;
  const segments = pathSegments(pathname);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "projects" ||
    segments[3] !== "files"
  ) {
    return false;
  }
  try {
    return decodeURIComponent(segments[4]) === CUT_SELECTION_FILE;
  } catch {
    return false;
  }
}

export function isVideocutCutsRequest(method: string, pathname: string): boolean {
  try {
    return cutsProjectId(pathname) !== null || isLegacyCutSelectionPut(method, pathname);
  } catch {
    // A structurally matching route with bad URL encoding still belongs to this
    // handler so it can return a stable invalid_argument response.
    const segments = pathSegments(pathname);
    return (
      (segments.length === 5 &&
        segments[0] === "api" &&
        segments[1] === "v1" &&
        segments[2] === "projects" &&
        segments[4] === "cuts") ||
      isLegacyCutSelectionPut(method, pathname)
    );
  }
}

function parsePutBody(value: unknown): CutsPutBody {
  if (!isObject(value)) {
    throw new VideocutError("invalid_argument", "Cuts request body must be a JSON object");
  }
  const allowedKeys = new Set(["expectedRevision", "cutWordIds"]);
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new VideocutError(
      "invalid_argument",
      "Cuts request body contains unsupported fields",
      { unsupportedFields: unexpectedKeys },
    );
  }
  if (
    typeof value.expectedRevision !== "string" ||
    !REVISION_PATTERN.test(value.expectedRevision)
  ) {
    throw new VideocutError(
      "invalid_argument",
      "expectedRevision is required and must be 'none' or a SHA-256 revision",
    );
  }
  if (!Array.isArray(value.cutWordIds)) {
    throw new VideocutError("invalid_argument", "cutWordIds must be an array");
  }
  return {
    expectedRevision: value.expectedRevision,
    cutWordIds: value.cutWordIds,
  };
}

async function readJsonRequest(request: Request): Promise<unknown> {
  const source = await request.text();
  try {
    return JSON.parse(source || "null") as unknown;
  } catch {
    throw new VideocutError("invalid_json", "Cuts request body is not valid JSON");
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export function createVideocutCutsHandler(
  options: VideocutCutsHandlerOptions,
): VideocutCutsHandler {
  const mutex = new KeyedMutex();

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (isLegacyCutSelectionPut(request.method, url.pathname)) {
      return errorResponse(
        409,
        "managed_document_use_cuts_api",
        "cut-selection.json must be updated through /api/v1/projects/:id/cuts",
      );
    }

    let projectId: string | null;
    try {
      projectId = cutsProjectId(url.pathname);
    } catch (error) {
      const normalized = asVideocutError(error);
      return errorResponse(
        errorStatus(normalized),
        normalized.code,
        normalized.message,
        normalized.details,
      );
    }
    if (projectId === null) return null;
    try {
      assertProjectId(projectId);
    } catch (error) {
      const normalized = asVideocutError(error);
      return errorResponse(
        errorStatus(normalized),
        normalized.code,
        normalized.message,
        normalized.details,
      );
    }

    if (request.method !== "GET" && request.method !== "PUT") {
      return errorResponse(405, "method_not_allowed", "Only GET and PUT are supported");
    }

    try {
      // The route carries a registry id, not a cwd-relative path. Resolve the
      // exact registry entry so an unrelated `./<projectId>` directory can
      // never shadow the product project.
      const project = await resolveProject(resolve(options.projectsDir, projectId));

      if (request.method === "GET") {
        const current = await readOptionalProjectDocument(project, CUT_SELECTION_FILE);
        const revision = current?.revision ?? "none";
        return jsonResponse(
          {
            schemaVersion: API_SCHEMA_VERSION,
            projectId: project.projectId,
            exists: Boolean(current),
            revision,
            document: current?.value ?? null,
          },
          200,
          { ETag: `"${revision}"` },
        );
      }

      const body = parsePutBody(await readJsonRequest(request));
      const lockKey = join(project.directory, CUT_SELECTION_FILE);
      const result = await mutex.run(lockKey, () =>
        writeCutSelection(
          project,
          // The API intentionally forwards only cutWordIds. Metadata, ranges and
          // timestamps supplied by a caller can never replace the stored values.
          { cutWordIds: body.cutWordIds },
          { expectedRevision: body.expectedRevision },
        ),
      );

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

      return jsonResponse(
        {
          schemaVersion: API_SCHEMA_VERSION,
          projectId: project.projectId,
          exists: true,
          changed: result.changed,
          previousRevision: result.previousRevision ?? "none",
          revision: result.revision,
          document: result.document,
        },
        200,
        { ETag: `"${result.revision}"` },
      );
    } catch (error) {
      const normalized = asVideocutError(error);
      return errorResponse(
        errorStatus(normalized),
        normalized.code,
        normalized.message,
        normalized.details,
      );
    }
  };
}
