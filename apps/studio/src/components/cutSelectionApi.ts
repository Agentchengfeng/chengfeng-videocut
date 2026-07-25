export interface CutSelectionResource {
  schemaVersion: 1;
  projectId: string;
  exists: boolean;
  revision: string;
  document: unknown | null;
  changed?: boolean;
  previousRevision?: string | null;
}

interface CutSelectionErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export class CutSelectionApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: { status: number; code?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "CutSelectionApiError";
    this.status = options.status;
    this.code = options.code ?? "cuts_api_error";
    this.details = options.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CutSelectionApiError(
      `Cut selection service returned invalid JSON (${response.status})`,
      { status: response.status, code: "invalid_service_response" },
    );
  }
}

function parseResource(payload: unknown, status: number): CutSelectionResource {
  const revisionPattern = /^(?:none|[a-f0-9]{64})$/;
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    typeof payload.projectId !== "string" ||
    typeof payload.exists !== "boolean" ||
    typeof payload.revision !== "string" ||
    !revisionPattern.test(payload.revision) ||
    !(payload.document === null || isRecord(payload.document)) ||
    (payload.exists && (payload.revision === "none" || !isRecord(payload.document))) ||
    (!payload.exists && (payload.revision !== "none" || payload.document !== null)) ||
    (payload.changed !== undefined && typeof payload.changed !== "boolean") ||
    (payload.previousRevision !== undefined &&
      payload.previousRevision !== null &&
      (typeof payload.previousRevision !== "string" ||
        !revisionPattern.test(payload.previousRevision)))
  ) {
    throw new CutSelectionApiError("Cut selection service returned an invalid resource", {
      status,
      code: "invalid_service_response",
    });
  }
  return payload as unknown as CutSelectionResource;
}

async function requestCuts(url: string, init?: RequestInit): Promise<CutSelectionResource> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new CutSelectionApiError("Cannot reach the local chengfeng-videocut service", {
      status: 0,
      code: "service_unavailable",
      details: cause instanceof Error ? { cause: cause.message } : undefined,
    });
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const envelope = isRecord(payload) ? (payload as CutSelectionErrorEnvelope) : {};
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    throw new CutSelectionApiError(
      typeof error?.message === "string"
        ? error.message
        : `Cut selection request failed (${response.status})`,
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
  return `/api/v1/projects/${encodeURIComponent(projectId)}/cuts`;
}

export function getProjectCutSelection(projectId: string): Promise<CutSelectionResource> {
  return requestCuts(resourceUrl(projectId), {
    headers: { Accept: "application/json" },
  });
}

export function putProjectCutSelection(
  projectId: string,
  expectedRevision: string,
  cutWordIds: readonly string[],
): Promise<CutSelectionResource> {
  return requestCuts(resourceUrl(projectId), {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    // Studio submits the complete visible delete/keep state. Unlike the Skill
    // semantic overlay, this mode intentionally allows a user to restore a
    // natural-pause baseline word.
    body: JSON.stringify({
      expectedRevision,
      cutWordIds,
      mode: "full-selection",
    }),
  });
}
