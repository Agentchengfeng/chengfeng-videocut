/// <reference types="node" />

import { dirname, resolve } from "node:path";
import {
  VideocutError,
  asVideocutError,
  parseEditListOperation,
  type EditListOperation,
} from "@video-workbench/core";
import {
  patchEditList,
  readEditList,
  resolveProject,
} from "@video-workbench/core/node";

const API_SCHEMA_VERSION = 1 as const;
const EDIT_LIST_FILE = "edit-list.json" as const;
const REVISION_PATTERN = /^(?:none|[a-f0-9]{64})$/;

export interface VideocutEditListChange {
  projectId: string;
  path: string;
  revision: string;
}

export interface VideocutEditListHandlerOptions {
  projectsDir: string;
  materializeIndex?: (change: VideocutEditListChange) => void | Promise<void>;
  onDocumentChanged?: (change: VideocutEditListChange) => void | Promise<void>;
}

type VideocutEditListHandler = (request: Request) => Promise<Response | null>;

interface EditListPatchBody {
  expectedRevision: string;
  operation: EditListOperation;
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
  return jsonResponse({
    schemaVersion: API_SCHEMA_VERSION,
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }, status);
}

function errorStatus(error: VideocutError): number {
  if (error.code === "project_not_found") return 404;
  if (error.code === "revision_conflict") return 409;
  if (
    error.code === "invalid_argument" ||
    error.code === "invalid_json" ||
    error.code === "invalid_project" ||
    error.code === "invalid_edit_list"
  ) return 400;
  return 500;
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

function editListProjectId(pathname: string): string | null {
  const segments = pathSegments(pathname);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "v1" ||
    segments[2] !== "projects" ||
    segments[4] !== "edit-list"
  ) return null;
  return decodedSegment(segments[3]);
}

function isManagedFilePut(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== "PUT") return false;
  const segments = pathSegments(pathname);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "projects" ||
    segments[3] !== "files"
  ) return false;
  try {
    return decodeURIComponent(segments[4]) === EDIT_LIST_FILE;
  } catch {
    return false;
  }
}

export function isVideocutEditListRequest(method: string, pathname: string): boolean {
  try {
    return editListProjectId(pathname) !== null || isManagedFilePut(method, pathname);
  } catch {
    return true;
  }
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse((await request.text()) || "null") as unknown;
  } catch {
    throw new VideocutError("invalid_json", "Edit-list request body is not valid JSON");
  }
}

function patchBody(value: unknown): EditListPatchBody {
  if (!isObject(value)) {
    throw new VideocutError("invalid_argument", "Edit-list request body must be an object");
  }
  const allowed = new Set(["expectedRevision", "operation"]);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new VideocutError(
      "invalid_argument",
      "Edit-list request body contains unsupported fields",
      { unsupportedFields: unsupported },
    );
  }
  if (typeof value.expectedRevision !== "string" || !REVISION_PATTERN.test(value.expectedRevision)) {
    throw new VideocutError(
      "invalid_argument",
      "expectedRevision is required and must be 'none' or a SHA-256 revision",
    );
  }
  return {
    expectedRevision: value.expectedRevision,
    operation: parseEditListOperation(value.operation),
  };
}

export function createVideocutEditListHandler(
  options: VideocutEditListHandlerOptions,
): VideocutEditListHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (isManagedFilePut(request.method, url.pathname)) {
      return errorResponse(
        409,
        "managed_document_use_edit_list_api",
        "edit-list.json must be updated through /api/v1/projects/:id/edit-list",
      );
    }

    try {
      const projectId = editListProjectId(url.pathname);
      if (projectId === null) return null;
      assertProjectId(projectId);
      if (request.method !== "GET" && request.method !== "PATCH") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, PATCH" },
        });
      }
      const project = await resolveProject(resolve(options.projectsDir, projectId));
      if (request.method === "GET") {
        const current = await readEditList(project);
        const currentRevision = current?.revision ?? "none";
        return jsonResponse({
          schemaVersion: API_SCHEMA_VERSION,
          projectId: project.projectId,
          exists: Boolean(current),
          revision: currentRevision,
          document: current?.value ?? null,
        }, 200, { ETag: `"${currentRevision}"` });
      }

      const body = patchBody(await requestJson(request));
      const result = await patchEditList(project, body.operation, {
        expectedRevision: body.expectedRevision,
      });
      const change = {
        projectId: project.projectId,
        path: result.path,
        revision: result.revision,
      };
      if (result.changed && options.materializeIndex) {
        try {
          await options.materializeIndex(change);
        } catch (error) {
          throw new VideocutError(
            "io_error",
            "The edit list was saved, but index.html could not be regenerated",
            {
              committed: true,
              revision: result.revision,
              projectDirectory: dirname(result.path),
              cause: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      if (result.changed && options.onDocumentChanged) {
        try {
          await options.onDocumentChanged(change);
        } catch {
          // The persisted edit and materialized index are already current.
        }
      }
      return jsonResponse({
        schemaVersion: API_SCHEMA_VERSION,
        projectId: project.projectId,
        exists: true,
        changed: result.changed,
        previousRevision: result.previousRevision ?? "none",
        revision: result.revision,
        document: result.document,
      }, 200, { ETag: `"${result.revision}"` });
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
