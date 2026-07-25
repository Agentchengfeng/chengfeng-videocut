import { readEditList, resolveProject } from "@video-workbench/core/node";
import {
  KouboWorkflowError,
  applyKouboCut,
  readKouboCutArtifactStatus,
  readKouboWorkflow,
  transitionKouboWorkflow,
  type ApplyKouboCutOptions,
  type ApplyKouboCutResult,
  type KouboCutArtifactStatus,
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
  expectedEditListRevision?: string;
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
  editListRevision: string,
  artifact: KouboCutArtifactStatus,
): JsonObject {
  const project = snapshot.project;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: snapshot.revision,
    editListRevision,
    artifact,
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
  const allowedKeys = new Set([
    "action",
    "confirmed",
    "expectedRevision",
    "expectedEditListRevision",
    "config",
  ]);
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
  if (
    value.expectedEditListRevision !== undefined &&
    (typeof value.expectedEditListRevision !== "string" ||
      !REVISION.test(value.expectedEditListRevision))
  ) {
    throw new KouboWorkflowError(
      "revision_required",
      "expectedEditListRevision must be a lowercase SHA-256 revision",
      {
        reason: value.expectedEditListRevision === "none"
          ? "edit_list_required"
          : "invalid_edit_list_revision",
      },
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
        const editList = await readEditList(project);
        const editListRevision = editList?.revision ?? "none";
        const artifact = await readKouboCutArtifactStatus(
          project.directory,
          editList?.revision ?? null,
        );
        return response(publicSnapshot(
          matched.projectId,
          snapshot,
          activeCuts.has(matched.projectId),
          editListRevision,
          artifact,
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
        if (body.expectedEditListRevision === undefined) {
          throw new KouboWorkflowError(
            "revision_required",
            "apply-cut requires expectedEditListRevision from explicit user confirmation",
            { reason: "missing_confirmed_edit_list_revision" },
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
        const editList = await readEditList(project);
        if (!editList) {
          throw new KouboWorkflowError(
            "revision_required",
            "apply-cut requires project prepare to create edit-list.json",
            { reason: "edit_list_required" },
          );
        }
        const currentEditListRevision = editList.revision;
        if (body.expectedEditListRevision !== currentEditListRevision) {
          throw new KouboWorkflowError(
            "revision_conflict",
            "edit-list.json changed after the cut was confirmed",
            {
              reason: "edit_list_changed_after_confirmation",
              expectedEditListRevision: body.expectedEditListRevision,
              currentEditListRevision,
            },
          );
        }
        const operation = runCut(project.directory, {
          confirmed: true,
          expectedRevision: body.expectedRevision,
          expectedEditListRevision: body.expectedEditListRevision,
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
        const artifact = await readKouboCutArtifactStatus(
          project.directory,
          currentEditListRevision,
        );
        return response({
          ...publicSnapshot(
            matched.projectId,
            snapshot,
            !early.result,
            currentEditListRevision,
            artifact,
          ),
          accepted: !early.result,
          action: body.action,
        }, early.result ? 200 : 202);
      }

      if (body.action === "start-final") {
        const before = await readKouboWorkflow(project.directory);
        if (before.revision !== body.expectedRevision) {
          throw new KouboWorkflowError(
            "revision_conflict",
            "project.json changed after it was inspected",
            { expectedRevision: body.expectedRevision, currentRevision: before.revision },
          );
        }
        const editList = await readEditList(project);
        const artifact = await readKouboCutArtifactStatus(
          project.directory,
          editList?.revision ?? null,
        );
        if (artifact.state !== "current") {
          throw new KouboWorkflowError(
            "invalid_state",
            "start-final requires a verified cut artifact for the current edit list",
            {
              reason: "cut_artifact_not_current",
              artifactState: artifact.state,
              artifactEditListRevision: artifact.editListRevision,
              currentEditListRevision: editList?.revision ?? null,
              artifactPath: artifact.path,
            },
          );
        }
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
      const editList = await readEditList(project);
      const artifact = await readKouboCutArtifactStatus(
        project.directory,
        editList?.revision ?? null,
      );
      return response({
        ...publicSnapshot(
          matched.projectId,
          result,
          false,
          editList?.revision ?? "none",
          artifact,
        ),
        accepted: false,
        action: body.action,
      });
    } catch (error) {
      const normalized = normalizedError(error);
      return errorResponse(statusFor(error), normalized.code, normalized.message, normalized.details);
    }
  };
}
