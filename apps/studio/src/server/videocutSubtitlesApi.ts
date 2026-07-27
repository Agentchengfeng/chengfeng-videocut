/// <reference types="node" />

/**
 * `/api/v1/projects/:id/subtitles` — read and write the subtitle document.
 *
 * A GET returns three things, and only the first is stored:
 *
 * ```text
 * document   the cues and the style          read from subtitles.json
 * timings    when each screen shows          computed from transcript + edit list
 * stale      which screens the cut broke     computed from transcript + edit list
 * ```
 *
 * Timing and staleness are recomputed on every read on purpose. A stored answer
 * about "when" would go wrong the instant someone edits the cut, and a stored
 * answer about "what is broken" would go wrong in the direction that matters:
 * claiming everything is fine when it is not.
 *
 * PUT replaces the whole document under a revision check. There is no operation
 * reducer here as there is for the edit list, because every change to subtitles
 * is a person editing text; a whole-document write is the honest model of that,
 * and the revision check is what stops two open tabs overwriting each other.
 */

import { resolve } from "node:path";
import {
  VideocutError,
  asVideocutError,
  parseTranscriptWords,
  subtitleCueTimings,
  subtitleStaleness,
  type SubtitleCueTiming,
} from "@video-workbench/core";
import {
  readEditList,
  readOptionalProjectDocument,
  readSubtitles,
  resolveProject,
  writeSubtitles,
} from "@video-workbench/core/node";

const API_SCHEMA_VERSION = 1 as const;
const REVISION_PATTERN = /^(?:none|[a-f0-9]{64})$/;

export interface VideocutSubtitlesChange {
  projectId: string;
  path: string;
  revision: string;
}

export interface VideocutSubtitlesHandlerOptions {
  projectsDir: string;
  onDocumentChanged?: (change: VideocutSubtitlesChange) => void | Promise<void>;
}

type VideocutSubtitlesHandler = (request: Request) => Promise<Response | null>;

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
    case "invalid_subtitles":
      return 400;
    default:
      return 500;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function matchesRoute(segments: readonly string[]): boolean {
  return segments.length === 5
    && segments[0] === "api"
    && segments[1] === "v1"
    && segments[2] === "projects"
    && segments[4] === "subtitles";
}

function subtitlesProjectId(pathname: string): string | null {
  const segments = pathSegments(pathname);
  if (!matchesRoute(segments)) return null;
  try {
    return decodeURIComponent(segments[3] as string);
  } catch {
    throw new VideocutError("invalid_argument", "Project id is not valid URL encoding");
  }
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

export function isVideocutSubtitlesRequest(_method: string, pathname: string): boolean {
  // A structurally matching route with bad URL encoding still belongs here, so
  // it gets a stable invalid_argument rather than falling through to the SPA.
  return matchesRoute(pathSegments(pathname));
}

async function readJsonRequest(request: Request): Promise<unknown> {
  const source = await request.text();
  try {
    return JSON.parse(source || "null") as unknown;
  } catch {
    throw new VideocutError("invalid_json", "Subtitles request body is not valid JSON");
  }
}

interface SubtitlesPutBody {
  expectedRevision: string;
  document: unknown;
}

function parsePutBody(value: unknown): SubtitlesPutBody {
  if (!isObject(value)) {
    throw new VideocutError("invalid_argument", "Subtitles request body must be a JSON object");
  }
  const allowed = new Set(["expectedRevision", "document"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new VideocutError(
      "invalid_argument",
      "Subtitles request body contains unsupported fields",
      { unsupportedFields: unexpected },
    );
  }
  if (typeof value.expectedRevision !== "string" || !REVISION_PATTERN.test(value.expectedRevision)) {
    throw new VideocutError(
      "invalid_argument",
      "expectedRevision is required and must be 'none' or a SHA-256 revision",
    );
  }
  if (!isObject(value.document)) {
    throw new VideocutError("invalid_argument", "document must be a subtitle document object");
  }
  return { expectedRevision: value.expectedRevision, document: value.document };
}

/** Everything derived, in one shape, so the two methods cannot answer differently. */
async function derivedState(
  project: Awaited<ReturnType<typeof resolveProject>>,
  document: Awaited<ReturnType<typeof readSubtitles>>,
): Promise<{
  timings: SubtitleCueTiming[];
  stale: ReturnType<typeof subtitleStaleness>;
  transcriptRevision: string | null;
}> {
  const [transcript, editList] = await Promise.all([
    readOptionalProjectDocument(project, "transcript.json"),
    readEditList(project),
  ]);
  if (!document) {
    return { timings: [], stale: [], transcriptRevision: transcript?.revision ?? null };
  }
  const words = transcript ? parseTranscriptWords(transcript.value) : [];
  return {
    timings: subtitleCueTimings(document.value, words, editList?.value ?? null),
    stale: subtitleStaleness(document.value, words, editList?.value ?? null),
    transcriptRevision: transcript?.revision ?? null,
  };
}

export function createVideocutSubtitlesHandler(
  options: VideocutSubtitlesHandlerOptions,
): VideocutSubtitlesHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    let projectId: string | null;
    try {
      projectId = subtitlesProjectId(url.pathname);
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
      if (request.method !== "GET" && request.method !== "PUT") {
        return errorResponse(405, "method_not_allowed", "Only GET and PUT are supported");
      }
      // The route carries a registry id, not a cwd-relative path.
      const project = await resolveProject(resolve(options.projectsDir, projectId));

      if (request.method === "GET") {
        const current = await readSubtitles(project);
        const derived = await derivedState(project, current);
        const revision = current?.revision ?? "none";
        return jsonResponse(
          {
            schemaVersion: API_SCHEMA_VERSION,
            projectId: project.projectId,
            exists: Boolean(current),
            revision,
            document: current?.value ?? null,
            ...derived,
          },
          200,
          { ETag: `"${revision}"` },
        );
      }

      const body = parsePutBody(await readJsonRequest(request));
      const result = await writeSubtitles(project, body.document, {
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
      const derived = await derivedState(project, {
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
      return errorResponse(
        errorStatus(normalized),
        normalized.code,
        normalized.message,
        normalized.details,
      );
    }
  };
}
