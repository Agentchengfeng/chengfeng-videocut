import type {
  SubtitleCueTiming,
  SubtitleDocument,
} from "@video-workbench/core";

/** One screen the cut broke, and what it lost. Always specific, never a blanket warning. */
export interface SubtitleStaleCue {
  cueId: string;
  index: number;
  missingWordIds: string[];
  cutWordIds: string[];
  cutText: string;
  orphaned: boolean;
}

export interface SubtitleResource {
  schemaVersion: 1;
  projectId: string;
  exists: boolean;
  revision: string;
  document: SubtitleDocument | null;
  /** Recomputed by the server on every read; never stored. */
  timings: SubtitleCueTiming[];
  stale: SubtitleStaleCue[];
  transcriptRevision: string | null;
  changed?: boolean;
  previousRevision?: string | null;
}

export class SubtitlesApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: { status: number; code?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "SubtitlesApiError";
    this.status = options.status;
    this.code = options.code ?? "subtitles_api_error";
    this.details = options.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const REVISION_PATTERN = /^(?:none|[a-f0-9]{64})$/;

function parseResource(payload: unknown, status: number): SubtitleResource {
  if (
    !isRecord(payload)
    || payload.schemaVersion !== 1
    || typeof payload.projectId !== "string"
    || typeof payload.exists !== "boolean"
    || typeof payload.revision !== "string"
    || !REVISION_PATTERN.test(payload.revision)
    || !(payload.document === null || isRecord(payload.document))
    || !Array.isArray(payload.timings)
    || !Array.isArray(payload.stale)
    // A document and a revision must agree about whether anything is stored.
    // Disagreement here would let the editor save against a revision that does
    // not describe what it is looking at.
    || (payload.exists && (payload.revision === "none" || !isRecord(payload.document)))
    || (!payload.exists && (payload.revision !== "none" || payload.document !== null))
  ) {
    throw new SubtitlesApiError("Subtitle service returned an invalid resource", {
      status,
      code: "invalid_service_response",
    });
  }
  return payload as unknown as SubtitleResource;
}

async function request(url: string, init?: RequestInit): Promise<SubtitleResource> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new SubtitlesApiError("Cannot reach the local chengfeng-videocut service", {
      status: 0,
      code: "service_unavailable",
      details: cause instanceof Error ? { cause: cause.message } : undefined,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SubtitlesApiError(
      `Subtitle service returned invalid JSON (${response.status})`,
      { status: response.status, code: "invalid_service_response" },
    );
  }
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    throw new SubtitlesApiError(
      typeof error?.message === "string"
        ? error.message
        : `Subtitle request failed (${response.status})`,
      {
        status: response.status,
        code: typeof error?.code === "string" ? error.code : undefined,
        details: isRecord(error?.details) ? error.details : undefined,
      },
    );
  }
  return parseResource(payload, response.status);
}

function resourceUrl(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/subtitles`;
}

export function getProjectSubtitles(projectId: string): Promise<SubtitleResource> {
  return request(resourceUrl(projectId), { headers: { Accept: "application/json" } });
}

export function putProjectSubtitles(
  projectId: string,
  expectedRevision: string,
  document: SubtitleDocument,
): Promise<SubtitleResource> {
  return request(resourceUrl(projectId), {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision, document }),
  });
}
