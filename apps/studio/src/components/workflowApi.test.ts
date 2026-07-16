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
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/demo/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "apply-cut",
          confirmed: true,
          expectedRevision: "b".repeat(64),
        }),
      }),
    );
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
});
