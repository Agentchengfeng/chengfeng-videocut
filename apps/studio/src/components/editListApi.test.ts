import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditListApiError,
  getProjectEditList,
  patchProjectEditList,
} from "./editListApi";

const revision = "a".repeat(64);
const document = {
  schemaVersion: 1,
  projectId: "demo",
  sourceDuration: 10,
  baseCutsRevision: revision,
  baseTranscriptRevision: revision,
  mode: "cuts-derived",
  duration: 10,
  segments: [
    {
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("edit-list API client", () => {
  it("loads the canonical project resource", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      projectId: "demo",
      exists: true,
      revision,
      document,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const resource = await getProjectEditList("demo");

    expect(resource.document?.segments[0]?.id).toBe("a-roll-0001");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/demo/edit-list",
      { headers: { Accept: "application/json" } },
    );
  });

  it("sends only expectedRevision and one operation on PATCH", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      projectId: "demo",
      exists: true,
      revision,
      document,
      changed: false,
      previousRevision: revision,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await patchProjectEditList("demo", revision, {
      type: "move",
      clipId: "a-roll-0001",
      start: 3,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: revision,
      operation: { type: "move", clipId: "a-roll-0001", start: 3 },
    });
  });

  it("preserves revision conflict details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "revision_conflict",
        message: "edit-list.json changed after it was inspected",
        details: { currentRevision: revision },
      },
    }), { status: 409, headers: { "content-type": "application/json" } })));

    await expect(
      patchProjectEditList("demo", "b".repeat(64), {
        type: "delete",
        clipId: "a-roll-0001",
      }),
    ).rejects.toMatchObject<Partial<EditListApiError>>({
      code: "revision_conflict",
      status: 409,
      details: { currentRevision: revision },
    });
  });
});
