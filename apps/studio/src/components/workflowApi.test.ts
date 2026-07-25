import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProjectWorkflow,
  postProjectWorkflowAction,
  WorkflowApiError,
} from "./workflowApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function workflowPayload(projectId = "demo") {
  return {
    schemaVersion: 1,
    projectId,
    revision: "a".repeat(64),
    editListRevision: "none",
    artifact: {
      state: "legacy",
      editListRevision: null,
      path: "剪口播/3_审核/source_cut.mp4",
    },
    project: {
      status: "cut_review_ready",
      config: null,
      artifacts: { review: "review.html" },
      codexContinue: null,
    },
  };
}

describe("workflowApi", () => {
  it("loads the fixed versioned workflow resource", async () => {
    const fetchMock = vi.fn(async () => Response.json(workflowPayload("a/b")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectWorkflow("a/b")).resolves.toMatchObject({
      schemaVersion: 1,
      projectId: "a/b",
      revision: "a".repeat(64),
      artifact: { state: "legacy" },
      project: { status: "cut_review_ready" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/a%2Fb/workflow",
      { headers: { Accept: "application/json" } },
    );
  });

  it("posts an explicitly confirmed revision-bound cut action", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await postProjectWorkflowAction({
      projectId: "demo",
      action: "apply-cut",
      expectedRevision: "b".repeat(64),
      expectedEditListRevision: "e".repeat(64),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/demo/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "apply-cut",
          confirmed: true,
          expectedRevision: "b".repeat(64),
          expectedEditListRevision: "e".repeat(64),
        }),
      }),
    );
  });

  it("fails closed before fetch when a cut confirmation omits the EDL revision", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await postProjectWorkflowAction({
      projectId: "demo",
      action: "apply-cut",
      expectedRevision: "b".repeat(64),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(WorkflowApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "revision_required",
      details: { reason: "missing_confirmed_edit_list_revision" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before fetch when the inspected project reports no EDL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await postProjectWorkflowAction({
      projectId: "demo",
      action: "apply-cut",
      expectedRevision: "b".repeat(64),
      expectedEditListRevision: "none",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(WorkflowApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "revision_required",
      details: { reason: "edit_list_required" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes only the compact final-video config for start-final", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await postProjectWorkflowAction({
      projectId: "demo",
      action: "start-final",
      expectedRevision: "c".repeat(64),
      config: {
        aspectRatio: "4:3",
        animationStyle: "xiaohei",
        requirements: "保留真人画面",
      },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      action: "start-final",
      confirmed: true,
      expectedRevision: "c".repeat(64),
      config: {
        aspectRatio: "4:3",
        animationStyle: "xiaohei",
        requirements: "保留真人画面",
      },
    });
  });

  it("surfaces 409 conflicts so the hook can refresh before retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        code: "revision_conflict",
        message: "project changed",
      },
    }, { status: 409 })));

    const error = await postProjectWorkflowAction({
      projectId: "demo",
      action: "confirm-storyboard",
      expectedRevision: "d".repeat(64),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(WorkflowApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
  });

  it("rejects workflow payloads that omit fixed project fields", async () => {
    const malformed = workflowPayload();
    delete (malformed.project as { artifacts?: unknown }).artifacts;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(malformed)));

    await expect(getProjectWorkflow("demo")).rejects.toMatchObject({
      code: "invalid_service_response",
    });
  });

  it("rejects missing or internally inconsistent physical artifact state", async () => {
    const missing = workflowPayload();
    delete (missing as { artifact?: unknown }).artifact;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(missing)));
    await expect(getProjectWorkflow("demo")).rejects.toMatchObject({
      code: "invalid_service_response",
    });

    const inconsistent = workflowPayload();
    inconsistent.editListRevision = "c".repeat(64);
    inconsistent.artifact = {
      state: "current",
      editListRevision: "d".repeat(64),
      path: "剪口播/3_审核/source_cut.mp4",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(inconsistent)));
    await expect(getProjectWorkflow("demo")).rejects.toMatchObject({
      code: "invalid_service_response",
    });
  });
});
