/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts, type EditListDocument } from "@video-workbench/core";
import {
  createVideocutEditListHandler,
  isVideocutEditListRequest,
} from "./videocutEditListApi";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-edit-list-api-"));
  cleanupPaths.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "project.json"), JSON.stringify({ jobId: "demo" }));
  await writeFile(join(projectDir, "index.html"), "<!doctype html>");
  const editList = buildEditListFromCuts({
    projectId: "demo",
    source: "input/source.mp4",
    sourceDuration: 10,
    cutsRevision: "a".repeat(64),
    transcriptRevision: "b".repeat(64),
    cutRanges: [{ start: 4, end: 6 }],
  });
  await writeFile(join(projectDir, "edit-list.json"), `${JSON.stringify(editList, null, 2)}\n`);
  return { projectsDir, projectDir };
}

function request(method: "GET" | "PATCH", body?: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/projects/demo/edit-list", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function required(value: Promise<Response | null>): Promise<Response> {
  const response = await value;
  if (!response) throw new Error("Expected edit-list handler response");
  return response;
}

describe("videocut edit-list API", () => {
  it("rejects an empty POST immediately without reading a body", async () => {
    const { projectsDir } = await fixture();
    const handle = createVideocutEditListHandler({ projectsDir });

    const response = await required(handle(new Request(
      "http://localhost/api/v1/projects/demo/edit-list",
      { method: "POST" },
    )));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PATCH");
  });

  it("GETs and CAS-patches one magnetic timeline operation", async () => {
    const { projectsDir } = await fixture();
    let materialized = 0;
    const handle = createVideocutEditListHandler({
      projectsDir,
      materializeIndex: async () => { materialized += 1; },
    });
    const get = await required(handle(request("GET")));
    const initial = await get.json();
    expect(initial).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      exists: true,
      document: { duration: 8, mode: "cuts-derived" },
    });
    expect(get.headers.get("etag")).toBe(`"${initial.revision}"`);

    const patched = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: {
        type: "trim",
        clipId: "a-roll-0001",
        sourceStart: 1,
        sourceEnd: 4,
      },
    })));
    const body = await patched.json();
    expect(patched.status).toBe(200);
    expect(body).toMatchObject({
      changed: true,
      previousRevision: initial.revision,
      document: { duration: 7, mode: "manual" },
    });
    expect(materialized).toBe(1);

    const stale = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: { type: "delete", clipId: "a-roll-0002" },
    })));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" } });
  });

  it("CAS-restores a deleted range only at explicit current anchors", async () => {
    const { projectsDir } = await fixture();
    const handle = createVideocutEditListHandler({ projectsDir });
    const initial = await (await required(handle(request("GET")))).json() as {
      revision: string;
    };
    const restored = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: {
        type: "restore",
        sourceStart: 4,
        sourceEnd: 6,
        previousSegmentId: "a-roll-0001",
        nextSegmentId: "a-roll-0002",
      },
    })));
    expect(restored.status).toBe(200);
    const body = await restored.json() as { revision: string; document: { mode: string; segments: unknown[] } };
    expect(body.document.mode).toBe("manual");
    expect(body.document.segments).toHaveLength(3);

    const stale = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: {
        type: "restore",
        sourceStart: 4,
        sourceEnd: 6,
        previousSegmentId: "a-roll-0001",
        nextSegmentId: "a-roll-0002",
      },
    })));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" } });
  });

  it("PATCHes one source-identified delete and only accepts its proven snapshot inverse", async () => {
    const { projectsDir, projectDir } = await fixture();
    let materialized = 0;
    const handle = createVideocutEditListHandler({
      projectsDir,
      materializeIndex: async () => { materialized += 1; },
    });
    const initial = await (await required(handle(request("GET")))).json() as {
      revision: string;
      document: EditListDocument;
    };
    const deleteOperation = {
      type: "delete-range" as const,
      source: "input/source.mp4",
      sourceStart: 1,
      sourceEnd: 2,
    };
    const deleted = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: deleteOperation,
    })));
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json() as {
      revision: string;
      document: EditListDocument;
    };
    expect(materialized).toBe(1);
    const afterDelete = await readFile(join(projectDir, "edit-list.json"), "utf8");

    const stale = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: {
        type: "restore-snapshot",
        expectedSegments: deletedBody.document.segments,
        beforeSegments: initial.document.segments,
        beforeMode: initial.document.mode,
        inverse: deleteOperation,
      },
    })));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" } });
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(afterDelete);

    const invalidInverse = await required(handle(request("PATCH", {
      expectedRevision: deletedBody.revision,
      operation: {
        type: "restore-snapshot",
        expectedSegments: deletedBody.document.segments,
        beforeSegments: initial.document.segments,
        beforeMode: initial.document.mode,
        inverse: { ...deleteOperation, sourceEnd: 2.1 },
      },
    })));
    expect(invalidInverse.status).toBe(400);
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(afterDelete);

    const restored = await required(handle(request("PATCH", {
      expectedRevision: deletedBody.revision,
      operation: {
        type: "restore-snapshot",
        expectedSegments: deletedBody.document.segments,
        beforeSegments: initial.document.segments,
        beforeMode: initial.document.mode,
        inverse: deleteOperation,
      },
    })));
    expect(restored.status).toBe(200);
    expect((await restored.json() as { document: EditListDocument }).document).toEqual(initial.document);
    expect(materialized).toBe(2);
  });

  it("blocks generic edit-list writes", async () => {
    const { projectsDir, projectDir } = await fixture();
    const handle = createVideocutEditListHandler({ projectsDir });
    const path = "/api/projects/demo/files/edit-list.json";
    const before = await readFile(join(projectDir, "edit-list.json"), "utf8");
    expect(isVideocutEditListRequest("PUT", path)).toBe(true);
    const response = await required(handle(new Request(`http://localhost${path}`, {
      method: "PUT",
      body: "{}",
    })));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "managed_document_use_edit_list_api" },
    });
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(before);
  });

  it("rejects a persisted playback-rate change at the API boundary", async () => {
    const { projectsDir, projectDir } = await fixture();
    const path = join(projectDir, "edit-list.json");
    const editList = JSON.parse(await readFile(path, "utf8"));
    editList.segments[0].playbackRate = 1.5;
    const invalid = `${JSON.stringify(editList, null, 2)}\n`;
    await writeFile(path, invalid);
    const handle = createVideocutEditListHandler({ projectsDir });

    const response = await required(handle(request("GET")));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_edit_list",
        details: { playbackRate: 1.5, supportedPlaybackRate: 1 },
      },
    });
    expect(await readFile(path, "utf8")).toBe(invalid);
  });
});
