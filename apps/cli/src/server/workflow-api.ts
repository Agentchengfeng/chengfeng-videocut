import { resolveProject } from "@video-workbench/core/node";
import {
  KouboWorkflowError,
  applyKouboCut,
  readKouboWorkflow,
  transitionKouboWorkflow,
  type ApplyKouboCutOptions,
  type ApplyKouboCutResult,
  type KouboWorkflowAction,
  type KouboWorkflowSnapshot,
  type TransitionKouboWorkflowOptions,
  type TransitionKouboWorkflowResult,
} from "@video-workbench/koubo-adapter";

const SCHEMA_VERSION = 1 as const;
const REVISION = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;

export interface VideocutWorkflowHandlerOptions {
  projectsDir: string;
  onProjectChanged?: (change: {
    projectId: string;
    path: string;
    revision?: string;
  }) => void | Promise<void>;
  applyCut?: (
    directory: string,
    options: ApplyKouboCutOptions,
  ) => Promise<ApplyKouboCutResult>;
  transition?: (
    directory: string,
    action: KouboWorkflowAction,
    options: TransitionKouboWorkflowOptions,
  ) => Promise<TransitionKouboWorkflowResult>;
}

type WorkflowHandler = (request: Request) => Promise<Response | null>;

interface ActionBody {
  action: "apply-cut" | KouboWorkflowAction;
  confirmed: true;
  expectedRevision: string;
  config?: {
    aspectRatio?: "3:4" | "16:9" | "4:3";
    animationStyle?: string;
    requirements?: string;
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: JsonObject,
): Response {
  return response({
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }, status);
}

function statusFor(error: unknown): number {
  const code = isObject(error) && typeof error.code === "string" ? error.code : "";
  if (code === "project_not_found") return 404;
  if (code === "revision_conflict" || code === "invalid_state" ||
      code === "missing_artifact" || code === "task_running") return 409;
  if (code === "workflow_failed" || code === "media_has_no_audio") return 500;
  return 400;
}

function normalizedError(error: unknown): { code: string; message: string; details?: JsonObject } {
  if (error instanceof KouboWorkflowError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (isObject(error)) {
    return {
      code: typeof error.code === "string" ? error.code : "internal_error",
      message: error instanceof Error ? error.message : String(error.message ?? error),
      details: isObject(error.details) ? error.details : undefined,
    };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function decodeProjectId(value: string): string {
  let projectId: string;
  try {
    projectId = decodeURIComponent(value);
  } catch {
    throw new KouboWorkflowError("invalid_argument", "Project id is not valid URL encoding");
  }
  if (!projectId || projectId === "." || projectId === ".." ||
      projectId.includes("/") || projectId.includes("\\") || projectId.includes("\0")) {
    throw new KouboWorkflowError("invalid_argument", `Invalid project id: ${projectId}`);
  }
  return projectId;
}

function route(pathname: string): { projectId: string; resource: "workflow" | "actions" } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 5 || segments[0] !== "api" || segments[1] !== "v1" ||
      segments[2] !== "projects" || (segments[4] !== "workflow" && segments[4] !== "actions")) {
    return null;
  }
  return {
    projectId: decodeProjectId(segments[3]),
    resource: segments[4],
  };
}

function publicSnapshot(
  projectId: string,
  snapshot: KouboWorkflowSnapshot,
  activeTask: boolean,
): JsonObject {
  const project = snapshot.project;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: snapshot.revision,
    activeTask,
    project: {
      ...project,
      config: isObject(project.config) ? project.config : null,
      artifacts: isObject(project.artifacts) ? project.artifacts : null,
      codexContinue: isObject(project.codexContinue) ? project.codexContinue : null,
    },
  };
}

async function readBody(request: Request): Promise<ActionBody> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    throw new KouboWorkflowError("invalid_argument", "Action body is not valid JSON");
  }
  if (!isObject(value)) throw new KouboWorkflowError("invalid_argument", "Action body must be an object");
  const allowedKeys = new Set(["action", "confirmed", "expectedRevision", "config"]);
  const unsupported = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    throw new KouboWorkflowError(
      "invalid_argument",
      "Action body contains unsupported fields",
      { unsupportedFields: unsupported },
    );
  }
  const actions = new Set([
    "apply-cut", "start-final", "confirm-storyboard", "confirm-animation",
    "confirm-timeline", "request-render",
  ]);
  if (typeof value.action !== "string" || !actions.has(value.action)) {
    throw new KouboWorkflowError("invalid_argument", "Action is not supported");
  }
  if (value.confirmed !== true) {
    throw new KouboWorkflowError(
      "confirmation_required",
      "Action requires confirmed: true after explicit user confirmation",
    );
  }
  if (typeof value.expectedRevision !== "string" || !REVISION.test(value.expectedRevision)) {
    throw new KouboWorkflowError(
      "revision_required",
      "Action requires a lowercase SHA-256 expectedRevision",
    );
  }
  if (value.config !== undefined && !isObject(value.config)) {
    throw new KouboWorkflowError("invalid_config", "config must be an object");
  }
  return value as unknown as ActionBody;
}

async function waitForCutStart(
  directory: string,
  operation: Promise<ApplyKouboCutResult>,
): Promise<{ result?: ApplyKouboCutResult; error?: unknown }> {
  const settled = operation.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const started = (async () => {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const snapshot = await readKouboWorkflow(directory);
      if (snapshot.status === "cutting") return {};
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return {};
  })();
  return Promise.race([settled, started]);
}

export function createVideocutWorkflowHandler(
  options: VideocutWorkflowHandlerOptions,
): WorkflowHandler {
  const activeCuts = new Map<string, Promise<ApplyKouboCutResult>>();
  const runCut = options.applyCut ?? applyKouboCut;
  const runTransition = options.transition ?? transitionKouboWorkflow;

  return async (request: Request): Promise<Response | null> => {
    let matched: ReturnType<typeof route>;
    try {
      matched = route(new URL(request.url).pathname);
    } catch (error) {
      const normalized = normalizedError(error);
      return errorResponse(statusFor(error), normalized.code, normalized.message, normalized.details);
    }
    if (!matched) return null;
    try {
      const project = await resolveProject(matched.projectId, {
        projectsDir: options.projectsDir,
        outputDir: options.projectsDir,
      });
      if (matched.resource === "workflow") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
        }
        const snapshot = await readKouboWorkflow(project.directory);
        return response(publicSnapshot(
          matched.projectId,
          snapshot,
          activeCuts.has(matched.projectId),
        ));
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      const body = await readBody(request);
      if (body.action === "apply-cut") {
        if (activeCuts.has(matched.projectId)) {
          throw new KouboWorkflowError(
            "invalid_state",
            "A physical cut is already running for this project",
            { projectId: matched.projectId },
          );
        }
        // Validate the optimistic revision before scheduling an expensive task.
        const before = await readKouboWorkflow(project.directory);
        if (before.revision !== body.expectedRevision) {
          throw new KouboWorkflowError(
            "revision_conflict",
            "project.json changed after it was inspected",
            { expectedRevision: body.expectedRevision, currentRevision: before.revision },
          );
        }
        const operation = runCut(project.directory, {
          confirmed: true,
          expectedRevision: body.expectedRevision,
          rootSourceCut: "symlink",
        });
        activeCuts.set(matched.projectId, operation);
        void operation.then(
          async (result) => {
            await options.onProjectChanged?.({
              projectId: matched.projectId,
              path: result.projectPath,
              revision: result.revision,
            });
          },
          async () => {
            const failed = await readKouboWorkflow(project.directory).catch(() => null);
            if (failed) {
              await options.onProjectChanged?.({
                projectId: matched.projectId,
                path: failed.projectPath,
                revision: failed.revision,
              });
            }
          },
        ).finally(() => {
          if (activeCuts.get(matched.projectId) === operation) activeCuts.delete(matched.projectId);
        }).catch(() => undefined);
        const early = await waitForCutStart(project.directory, operation);
        if (early.error) throw early.error;
        const snapshot = early.result ?? await readKouboWorkflow(project.directory);
        await options.onProjectChanged?.({
          projectId: matched.projectId,
          path: snapshot.projectPath,
          revision: snapshot.revision,
        });
        return response({
          ...publicSnapshot(matched.projectId, snapshot, !early.result),
          accepted: !early.result,
          action: body.action,
        }, early.result ? 200 : 202);
      }

      const result = await runTransition(
        project.directory,
        body.action,
        {
          confirmed: true,
          expectedRevision: body.expectedRevision,
          config: body.config,
        },
      );
      await options.onProjectChanged?.({
        projectId: matched.projectId,
        path: result.projectPath,
        revision: result.revision,
      });
      return response({
        ...publicSnapshot(matched.projectId, result, false),
        accepted: false,
        action: body.action,
      });
    } catch (error) {
      const normalized = normalizedError(error);
      return errorResponse(statusFor(error), normalized.code, normalized.message, normalized.details);
    }
  };
}
