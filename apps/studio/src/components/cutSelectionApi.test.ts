import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CutSelectionApiError,
  getProjectCutSelection,
  putProjectCutSelection,
} from "./cutSelectionApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cutSelectionApi", () => {
  it("loads the versioned cuts resource", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: 1,
        projectId: "demo",
        exists: false,
        revision: "none",
        document: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectCutSelection("demo")).resolves.toMatchObject({
      projectId: "demo",
      revision: "none",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/demo/cuts",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("sends the revision and authoritative Studio full selection", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: 1,
        projectId: "a/b",
        exists: true,
        revision: "a".repeat(64),
        document: { cutWordIds: ["w-1"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await putProjectCutSelection("a/b", "before", ["w-1"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/a%2Fb/cuts",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: "before",
          cutWordIds: ["w-1"],
          mode: "full-selection",
        }),
      }),
    );
  });

  it("surfaces revision conflicts with a stable code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            schemaVersion: 1,
            ok: false,
            error: { code: "revision_conflict", message: "changed" },
          },
          { status: 409 },
        ),
      ),
    );

    const error = await putProjectCutSelection("demo", "stale", ["w-1"]).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(CutSelectionApiError);
    expect(error).toMatchObject({ status: 409, code: "revision_conflict" });
  });

  it("reports an unavailable local service", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));

    await expect(getProjectCutSelection("demo")).rejects.toMatchObject({
      status: 0,
      code: "service_unavailable",
    });
  });

  it("rejects a malformed revision before it can be reused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: 1,
          projectId: "demo",
          exists: true,
          revision: "not-a-revision",
          document: { cutWordIds: [] },
        }),
      ),
    );

    await expect(getProjectCutSelection("demo")).rejects.toMatchObject({
      code: "invalid_service_response",
    });
  });
});
