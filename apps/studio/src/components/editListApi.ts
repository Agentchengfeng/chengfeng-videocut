import {
  parseEditListDocument,
  type EditListDocument,
  type EditListOperation,
} from "@video-workbench/core";

export interface EditListResource {
  schemaVersion: 1;
  projectId: string;
  exists: boolean;
  revision: string;
  document: EditListDocument | null;
  changed?: boolean;
  previousRevision?: string | null;
}

interface EditListErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export class EditListApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: { status: number; code?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "EditListApiError";
    this.status = options.status;
    this.code = options.code ?? "edit_list_api_error";
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
    throw new EditListApiError(`Edit-list service returned invalid JSON (${response.status})`, {
      status: response.status,
      code: "invalid_service_response",
    });
  }
}

function parseResource(payload: unknown, status: number): EditListResource {
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
    throw new EditListApiError("Edit-list service returned an invalid resource", {
      status,
      code: "invalid_service_response",
    });
  }

  let document: EditListDocument | null = null;
  if (payload.document !== null) {
    try {
      document = parseEditListDocument(payload.document);
    } catch (cause) {
      throw new EditListApiError("Edit-list service returned an invalid document", {
        status,
        code: "invalid_service_response",
        details: cause instanceof Error ? { cause: cause.message } : undefined,
      });
    }
  }

  return {
    schemaVersion: 1,
    projectId: payload.projectId,
    exists: payload.exists,
    revision: payload.revision,
    document,
    ...(typeof payload.changed === "boolean" ? { changed: payload.changed } : {}),
    ...(payload.previousRevision === null || typeof payload.previousRevision === "string"
      ? { previousRevision: payload.previousRevision }
      : {}),
  };
}

async function requestEditList(url: string, init?: RequestInit): Promise<EditListResource> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new EditListApiError("Cannot reach the local chengfeng-videocut service", {
      status: 0,
      code: "service_unavailable",
      details: cause instanceof Error ? { cause: cause.message } : undefined,
    });
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const envelope = isRecord(payload) ? (payload as EditListErrorEnvelope) : {};
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    throw new EditListApiError(
      typeof error?.message === "string"
        ? error.message
        : `Edit-list request failed (${response.status})`,
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
  return `/api/v1/projects/${encodeURIComponent(projectId)}/edit-list`;
}

export function getProjectEditList(projectId: string): Promise<EditListResource> {
  return requestEditList(resourceUrl(projectId), {
    headers: { Accept: "application/json" },
  });
}

/** Which surface asked for the edit; recorded in the project's event log. */
export type EditListActor = "studio-transcript" | "studio-timeline";

export function patchProjectEditList(
  projectId: string,
  expectedRevision: string,
  operation: EditListOperation,
  actor?: EditListActor,
): Promise<EditListResource> {
  return requestEditList(resourceUrl(projectId), {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expectedRevision, operation, ...(actor ? { actor } : {}) }),
  });
}
