/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

async function fixture(cutRanges = [{ start: 4, end: 6 }]) {
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
    cutRanges,
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

  it("preserves an explicit trim and unrelated source boundaries with automatic placement configured", async () => {
    const { projectsDir, projectDir } = await fixture([
      { start: 2, end: 4 },
      { start: 6, end: 8 },
    ]);
    const placeBoundaries = vi.fn(async (
      _projectDir: string,
      ranges: readonly { start: number; end: number }[],
    ) => ranges.map((range) => ({ start: range.start + 0.05, end: range.end - 0.05 })));
    const handle = createVideocutEditListHandler({ projectsDir, placeBoundaries });
    const initial = await (await required(handle(request("GET")))).json() as {
      revision: string;
      document: EditListDocument;
    };
    const operation = {
      type: "trim",
      clipId: "a-roll-0002",
      sourceStart: 4.26,
      sourceEnd: 5.93,
    };

    const response = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation,
    })));
    expect(response.status).toBe(200);
    const trimmed = await response.json() as { revision: string; document: EditListDocument };
    expect(trimmed.document.segments).toEqual([
      initial.document.segments[0],
      { ...initial.document.segments[1], sourceStart: 4.26, sourceEnd: 5.93 },
      { ...initial.document.segments[2], timelineStart: 3.67 },
    ]);
    expect(trimmed.document.duration).toBe(5.67);
    expect(trimmed.document.mode).toBe("manual");
    expect(trimmed.document.baseCutsRevision).toBe(initial.document.baseCutsRevision);
    expect(trimmed.document.baseTranscriptRevision).toBe(initial.document.baseTranscriptRevision);
    expect(placeBoundaries).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(projectDir, "edit-list.json"), "utf8")))
      .toEqual(trimmed.document);

    const beforeRepeat = await readFile(join(projectDir, "edit-list.json"), "utf8");
    const repeated = await required(handle(request("PATCH", {
      expectedRevision: trimmed.revision,
      operation,
    })));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ changed: false, revision: trimmed.revision });
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(beforeRepeat);
    expect(placeBoundaries).not.toHaveBeenCalled();
  });

  it("restores every source boundary through inverse trim without applying automatic placement", async () => {
    const { projectsDir } = await fixture([
      { start: 2, end: 4 },
      { start: 6, end: 8 },
    ]);
    const placeBoundaries = vi.fn(async (
      _projectDir: string,
      ranges: readonly { start: number; end: number }[],
    ) => ranges.map((range) => ({ start: range.start + 0.05, end: range.end - 0.05 })));
    const handle = createVideocutEditListHandler({ projectsDir, placeBoundaries });
    const initial = await (await required(handle(request("GET")))).json() as {
      revision: string;
      document: EditListDocument;
    };
    const response = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: { type: "trim", clipId: "a-roll-0002", sourceStart: 4.26, sourceEnd: 5.93 },
    })));
    expect(response.status).toBe(200);
    const trimmed = await response.json() as { revision: string };
    const restored = await required(handle(request("PATCH", {
      expectedRevision: trimmed.revision,
      operation: { type: "trim", clipId: "a-roll-0002", sourceStart: 4, sourceEnd: 6 },
    })));
    expect(restored.status).toBe(200);
    const body = await restored.json() as { document: EditListDocument };
    expect(body.document.segments).toEqual(initial.document.segments);
    expect(body.document.duration).toBe(initial.document.duration);
    // A reverse trim restores the physical ranges; it remains a manual timeline.
    expect(body.document.mode).toBe("manual");
    expect(placeBoundaries).not.toHaveBeenCalled();
  });

  it("rejects stale and invalid trims before placement and preserves the committed bytes", async () => {
    const { projectsDir, projectDir } = await fixture();
    const placeBoundaries = vi.fn(async (
      _projectDir: string,
      ranges: readonly { start: number; end: number }[],
    ) => [...ranges]);
    const handle = createVideocutEditListHandler({ projectsDir, placeBoundaries });
    const initial = await (await required(handle(request("GET")))).json() as { revision: string };
    const response = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: { type: "trim", clipId: "a-roll-0001", sourceStart: 0.26, sourceEnd: 4 },
    })));
    expect(response.status).toBe(200);
    const trimmed = await response.json() as { revision: string };
    const committed = await readFile(join(projectDir, "edit-list.json"), "utf8");
    placeBoundaries.mockClear();

    const stale = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: { type: "trim", clipId: "a-roll-0001", sourceStart: 0.5, sourceEnd: 4 },
    })));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" } });
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(committed);

    for (const operation of [
      { type: "trim", clipId: "missing", sourceStart: 0.26, sourceEnd: 4 },
      { type: "trim", clipId: "a-roll-0001", sourceStart: -0.1, sourceEnd: 4 },
      { type: "trim", clipId: "a-roll-0001", sourceStart: 0.26, sourceEnd: 11 },
      { type: "trim", clipId: "a-roll-0001", sourceStart: 0.26, sourceEnd: 6.1 },
      { type: "trim", clipId: "a-roll-0001", sourceStart: 3.99, sourceEnd: 4 },
      { type: "trim", clipId: "a-roll-0001", sourceStart: null, sourceEnd: 4 },
    ]) {
      const invalid = await required(handle(request("PATCH", {
        expectedRevision: trimmed.revision,
        operation,
      })));
      expect(invalid.status).toBe(400);
      expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(committed);
    }
    expect(placeBoundaries).not.toHaveBeenCalled();
    expect((await (await required(handle(request("GET")))).json() as { revision: string }).revision)
      .toBe(trimmed.revision);
  });

  it("continues placing boundaries for a non-trim operation", async () => {
    const { projectsDir, projectDir } = await fixture();
    const placeBoundaries = vi.fn(async (
      _projectDir: string,
      ranges: readonly { start: number; end: number }[],
    ) => ranges.map((range) => ({ start: range.start + 0.05, end: range.end - 0.05 })));
    const handle = createVideocutEditListHandler({ projectsDir, placeBoundaries });
    const initial = await (await required(handle(request("GET")))).json() as { revision: string };
    const response = await required(handle(request("PATCH", {
      expectedRevision: initial.revision,
      operation: { type: "delete", clipId: "a-roll-0001" },
    })));
    expect(response.status).toBe(200);
    expect(placeBoundaries).toHaveBeenCalledExactlyOnceWith(await realpath(projectDir), [{ start: 6, end: 10 }]);
    const body = await response.json() as { document: EditListDocument };
    expect(body.document.duration).toBeCloseTo(3.9);
    expect(body.document.segments).toMatchObject([
      { id: "a-roll-0002", sourceStart: 6.05, sourceEnd: 9.95, timelineStart: 0 },
    ]);
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

  it("persists split and exact snapshot undo without acoustic re-placement, then repeats the split", async () => {
    const {projectsDir, projectDir} = await fixture();
    const placeBoundaries = vi.fn(async (_dir: string, ranges: readonly {start:number;end:number}[]) => ranges.map(r=>({start:r.start+0.1,end:r.end-0.1})));
    const handle = createVideocutEditListHandler({projectsDir, placeBoundaries});
    const get = async () => await (await required(handle(request("GET")))).json() as {revision:string;document:EditListDocument};
    const before = await get();
    const inverse = {type:"split" as const,clipId:before.document.segments[0].id,offset:1,newClipId:"precise-right"};
    const split = await required(handle(request("PATCH",{expectedRevision:before.revision,operation:inverse})));
    expect(split.status).toBe(200);
    const after=await get(), bytes=await readFile(join(projectDir,"edit-list.json"),"utf8");
    const undo={type:"restore-snapshot",expectedSegments:after.document.segments,beforeSegments:before.document.segments,beforeMode:before.document.mode,inverse};
    const stale=await required(handle(request("PATCH",{expectedRevision:before.revision,operation:undo})));
    expect(stale.status).toBe(409);expect(await readFile(join(projectDir,"edit-list.json"),"utf8")).toBe(bytes);
    const restored=await required(handle(request("PATCH",{expectedRevision:after.revision,operation:undo})));
    expect(restored.status).toBe(200);expect((await get()).document).toEqual(before.document);
    const redo=await required(handle(request("PATCH",{expectedRevision:(await get()).revision,operation:inverse})));
    expect(redo.status).toBe(200);expect((await get()).document).toEqual(after.document);
    expect(placeBoundaries).not.toHaveBeenCalled();
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
