export type WorkbenchWorkflowAction =
  | "apply-cut"
  | "start-final"
  | "confirm-storyboard"
  | "confirm-animation"
  | "confirm-timeline";

export type WorkbenchAspectRatio = "3:4" | "16:9" | "4:3";

export interface WorkbenchFinalConfig {
  aspectRatio: WorkbenchAspectRatio;
  animationStyle: string;
  requirements: string;
}

export interface WorkbenchCodexContinue extends Record<string, unknown> {
  required?: boolean;
  stage?: string;
  prompt?: string;
  reason?: string;
}

export interface WorkbenchWorkflowProject {
  status: string;
  config: Record<string, unknown> | null;
  artifacts: Record<string, unknown> | null;
  codexContinue: WorkbenchCodexContinue | null;
}

export interface WorkbenchWorkflowResource {
  schemaVersion: 1;
  projectId: string;
  revision: string;
  project: WorkbenchWorkflowProject;
}

interface WorkflowErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export class WorkflowApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "WorkflowApiError";
    this.status = options.status;
    this.code = options.code ?? "workflow_api_error";
    this.details = options.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new WorkflowApiError(
      `Workflow service returned invalid JSON (${response.status})`,
      { status: response.status, code: "invalid_service_response" },
    );
  }
}

function parseWorkflowResource(
  payload: unknown,
  status: number,
): WorkbenchWorkflowResource {
  const project = isRecord(payload) && isRecord(payload.project)
    ? payload.project
    : null;
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    typeof payload.projectId !== "string" ||
    typeof payload.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.revision) ||
    !project ||
    typeof project.status !== "string" ||
    !project.status.trim() ||
    !("config" in project) ||
    !(project.config === null || isRecord(project.config)) ||
    !("artifacts" in project) ||
    !(project.artifacts === null || isRecord(project.artifacts)) ||
    !("codexContinue" in project) ||
    !(project.codexContinue === null || isRecord(project.codexContinue))
  ) {
    throw new WorkflowApiError(
      "Workflow service returned an invalid resource",
      { status, code: "invalid_service_response" },
    );
  }
  return payload as unknown as WorkbenchWorkflowResource;
}

function workflowUrl(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/workflow`;
}

function actionsUrl(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/actions`;
}

async function fetchResponse(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new WorkflowApiError(
      "Cannot reach the local chengfeng-videocut service",
      {
        status: 0,
        code: "service_unavailable",
        details: cause instanceof Error ? { cause: cause.message } : undefined,
      },
    );
  }
}

async function throwResponseError(response: Response): Promise<never> {
  const payload = await readJson(response);
  const envelope = isRecord(payload) ? payload as WorkflowErrorEnvelope : {};
  const error = isRecord(envelope.error) ? envelope.error : undefined;
  throw new WorkflowApiError(
    typeof error?.message === "string"
      ? error.message
      : `Workflow request failed (${response.status})`,
    {
      status: response.status,
      code: typeof error?.code === "string" ? error.code : undefined,
      details: isRecord(error?.details) ? error.details : undefined,
    },
  );
}

export async function getProjectWorkflow(
  projectId: string,
): Promise<WorkbenchWorkflowResource> {
  const response = await fetchResponse(workflowUrl(projectId), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return throwResponseError(response);
  const resource = parseWorkflowResource(await readJson(response), response.status);
  if (resource.projectId !== projectId) {
    throw new WorkflowApiError(
      "Workflow service returned a different project",
      { status: response.status, code: "invalid_service_response" },
    );
  }
  return resource;
}

export async function postProjectWorkflowAction(input: {
  projectId: string;
  action: WorkbenchWorkflowAction;
  expectedRevision: string;
  config?: WorkbenchFinalConfig;
}): Promise<void> {
  const body: {
    action: WorkbenchWorkflowAction;
    confirmed: true;
    expectedRevision: string;
    config?: WorkbenchFinalConfig;
  } = {
    action: input.action,
    confirmed: true,
    expectedRevision: input.expectedRevision,
  };
  if (input.config) body.config = input.config;

  const response = await fetchResponse(actionsUrl(input.projectId), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return throwResponseError(response);
}
