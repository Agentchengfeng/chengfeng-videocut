/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts } from "@video-workbench/core";
import { sha256 } from "@video-workbench/core/node";
import {
  createVideocutCutsHandler,
  isVideocutCutsRequest,
} from "./videocutCutsApi";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const storedSelection = {
  schemaVersion: 3,
  cutWordIds: ["w-1"],
  cutRanges: [{ start: 0, end: 1 }],
  initialization: {
    mode: "delete-or-keep-v2",
    naturalPausePolicy: "natural-pause-v2",
    baselineCutWordIds: ["w-1"],
  },
  productMetadata: { owner: "studio" },
  updatedAt: "2026-07-16T00:00:00.000Z",
};

async function createFixture(): Promise<{
  projectsDir: string;
  projectDir: string;
  cutsPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "videocut-cuts-api-"));
  cleanupPaths.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  const cutsPath = join(projectDir, "cut-selection.json");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "project.json"),
    JSON.stringify({ jobId: "demo", status: "cut_review_ready" }),
  );
  await writeFile(join(projectDir, "index.html"), "<!doctype html>");
  await writeFile(
    join(projectDir, "transcript.json"),
    JSON.stringify({
      schemaVersion: 1,
      cues: [
        {
          id: "cue-1",
          words: [
            { id: "w-1", start: 0, end: 1 },
            { id: "w-2", start: 1, end: 2 },
          ],
        },
      ],
    }),
  );
  await writeFile(cutsPath, `${JSON.stringify(storedSelection, null, 2)}\n`);
  return { projectsDir, projectDir, cutsPath };
}

async function addEditListFixture(
  projectDir: string,
  mode: "cuts-derived" | "manual" = "cuts-derived",
  sourceDuration = 2,
): Promise<string> {
  const cutsRaw = await readFile(join(projectDir, "cut-selection.json"), "utf8");
  const transcriptRaw = await readFile(join(projectDir, "transcript.json"), "utf8");
  const editList = buildEditListFromCuts({
    projectId: "demo",
    source: "input/source.mp4",
    sourceDuration,
    cutsRevision: sha256(cutsRaw),
    transcriptRevision: sha256(transcriptRaw),
    cutRanges: [{ start: 0, end: 1 }],
  });
  editList.mode = mode;
  const raw = `${JSON.stringify(editList, null, 2)}\n`;
  await writeFile(join(projectDir, "edit-list.json"), raw);
  return raw;
}

function cutsRequest(
  method: "GET" | "PUT",
  body?: Record<string, unknown>,
): Request {
  const requestBody = method === "PUT" && body
    ? { mode: "full-selection", ...body }
    : body;
  return new Request("http://localhost/api/v1/projects/demo/cuts", {
    method,
    headers: requestBody ? { "Content-Type": "application/json" } : undefined,
    body: requestBody ? JSON.stringify(requestBody) : undefined,
  });
}

async function requiredResponse(response: Promise<Response | null>): Promise<Response> {
  const resolved = await response;
  if (!resolved) throw new Error("Expected cuts handler to handle the request");
  return resolved;
}

describe("videocut cuts API", () => {
  it("returns the current revision and represents a missing selection as none", async () => {
    const { projectsDir, cutsPath } = await createFixture();
    const handle = createVideocutCutsHandler({ projectsDir });

    const existing = await requiredResponse(handle(cutsRequest("GET")));
    const existingBody = await existing.json();
    expect(existing.status).toBe(200);
    expect(existingBody).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      exists: true,
      document: { cutWordIds: ["w-1"] },
    });
    expect(existingBody.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(existing.headers.get("etag")).toBe(`"${existingBody.revision}"`);

    await rm(cutsPath);
    const missing = await requiredResponse(handle(cutsRequest("GET")));
    expect(await missing.json()).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      exists: false,
      revision: "none",
      document: null,
    });
  });

  it("rejects metadata injection while a Studio full selection can restore a baseline pause", async () => {
    const { projectsDir, projectDir, cutsPath } = await createFixture();
    await addEditListFixture(projectDir);
    const handle = createVideocutCutsHandler({ projectsDir });
    const getResponse = await requiredResponse(handle(cutsRequest("GET")));
    const revision = (await getResponse.json()).revision as string;
    const before = await readFile(cutsPath, "utf8");

    const missingRevision = await requiredResponse(
      handle(cutsRequest("PUT", { cutWordIds: ["w-2"] })),
    );
    expect(missingRevision.status).toBe(400);
    expect(await missingRevision.json()).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(await readFile(cutsPath, "utf8")).toBe(before);

    const injected = await requiredResponse(
      handle(
        cutsRequest("PUT", {
          expectedRevision: revision,
          cutWordIds: ["w-2"],
          initialization: { mode: "foreign" },
        }),
      ),
    );
    expect(injected.status).toBe(400);
    expect(await injected.json()).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "invalid_argument",
        details: { unsupportedFields: ["initialization"] },
      },
    });
    expect(await readFile(cutsPath, "utf8")).toBe(before);

    const valid = await requiredResponse(
      handle(cutsRequest("PUT", { expectedRevision: revision, cutWordIds: ["w-2"] })),
    );
    const validBody = await valid.json();
    const written = JSON.parse(await readFile(cutsPath, "utf8"));
    expect(valid.status).toBe(200);
    expect(validBody).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      exists: true,
      changed: true,
      document: { cutWordIds: ["w-2"], cutRanges: [{ start: 1, end: 2 }] },
    });
    expect(validBody.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(written.initialization).toEqual(storedSelection.initialization);
    expect(written.productMetadata).toEqual(storedSelection.productMetadata);
    expect(written.cutWordIds).not.toContain("w-1");
  });

  it("merges a semantic overlay with the natural-pause baseline under CAS and refreshes EDL", async () => {
    const { projectsDir, projectDir, cutsPath } = await createFixture();
    await writeFile(
      join(projectDir, "transcript.json"),
      JSON.stringify({
        schemaVersion: 1,
        cues: [{
          id: "cue-1",
          words: [
            { id: "w-1", start: 0, end: 1 },
            { id: "w-2", start: 1, end: 2 },
            { id: "w-3", start: 2, end: 3 },
          ],
        }],
      }),
    );
    await addEditListFixture(projectDir, "cuts-derived", 3);
    const handle = createVideocutCutsHandler({ projectsDir });
    const initialRevision = sha256(await readFile(cutsPath, "utf8"));

    const response = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: initialRevision,
      cutWordIds: ["w-2"],
      mode: "semantic-overlay",
    })));
    const body = await response.json();
    const written = JSON.parse(await readFile(cutsPath, "utf8"));
    const editList = JSON.parse(await readFile(join(projectDir, "edit-list.json"), "utf8"));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      changed: true,
      document: {
        cutWordIds: ["w-1", "w-2"],
        cutRanges: [{ start: 0, end: 2 }],
      },
    });
    expect(written.initialization.baselineCutWordIds).toEqual(["w-1"]);
    expect(editList).toMatchObject({
      mode: "cuts-derived",
      baseCutsRevision: body.revision,
      duration: 1,
      segments: [{ sourceStart: 2, sourceEnd: 3, timelineStart: 0 }],
    });

    const repeated = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: body.revision,
      cutWordIds: ["w-2"],
      mode: "semantic-overlay",
    })));
    expect(await repeated.json()).toMatchObject({
      changed: false,
      revision: body.revision,
      document: { cutWordIds: ["w-1", "w-2"] },
    });

    const stale = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: initialRevision,
      cutWordIds: [],
      mode: "semantic-overlay",
    })));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" } });
  });

  it("fails closed for a missing or unknown Cuts write mode", async () => {
    const { projectsDir, projectDir, cutsPath } = await createFixture();
    await addEditListFixture(projectDir);
    const handle = createVideocutCutsHandler({ projectsDir });
    const beforeCuts = await readFile(cutsPath, "utf8");
    const beforeEditList = await readFile(join(projectDir, "edit-list.json"), "utf8");
    const expectedRevision = sha256(beforeCuts);

    for (const body of [
      { expectedRevision, cutWordIds: ["w-2"] },
      { expectedRevision, cutWordIds: ["w-2"], mode: "replace" },
    ]) {
      const response = await requiredResponse(handle(new Request(
        "http://localhost/api/v1/projects/demo/cuts",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "invalid_argument",
          details: { supportedModes: ["semantic-overlay", "full-selection"] },
        },
      });
      expect(await readFile(cutsPath, "utf8")).toBe(beforeCuts);
      expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(beforeEditList);
    }
  });

  it("blocks the generic file PUT for cut-selection.json", async () => {
    const { projectsDir, cutsPath } = await createFixture();
    const handle = createVideocutCutsHandler({ projectsDir });
    const before = await readFile(cutsPath, "utf8");
    const pathname = "/api/projects/demo/files/cut-selection.json";

    expect(isVideocutCutsRequest("PUT", pathname)).toBe(true);
    expect(isVideocutCutsRequest("GET", pathname)).toBe(false);
    expect(
      await handle(new Request(`http://localhost${pathname}`, { method: "GET" })),
    ).toBeNull();
    const response = await requiredResponse(
      handle(
        new Request(`http://localhost${pathname}`, {
          method: "PUT",
          body: JSON.stringify({ cutWordIds: ["w-2"] }),
        }),
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "managed_document_use_cuts_api" },
    });
    expect(await readFile(cutsPath, "utf8")).toBe(before);
  });

  it("allows exactly one writer for two concurrent requests with one revision", async () => {
    const { projectsDir, projectDir, cutsPath } = await createFixture();
    await addEditListFixture(projectDir);
    const handle = createVideocutCutsHandler({ projectsDir });
    const emptySelection = {
      ...storedSelection,
      cutWordIds: [],
      cutRanges: [],
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await writeFile(cutsPath, `${JSON.stringify(emptySelection, null, 2)}\n`);
      const getResponse = await requiredResponse(handle(cutsRequest("GET")));
      const revision = (await getResponse.json()).revision as string;
      const responses = await Promise.all([
        requiredResponse(
          handle(cutsRequest("PUT", { expectedRevision: revision, cutWordIds: ["w-1"] })),
        ),
        requiredResponse(
          handle(cutsRequest("PUT", { expectedRevision: revision, cutWordIds: ["w-2"] })),
        ),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const conflict = responses.find((response) => response.status === 409);
      expect(conflict).toBeDefined();
      expect(await conflict?.json()).toMatchObject({
        schemaVersion: 1,
        ok: false,
        error: {
          code: "revision_conflict",
          details: { expectedRevision: revision },
        },
      });
      const finalDocument = JSON.parse(await readFile(cutsPath, "utf8"));
      expect([["w-1"], ["w-2"]]).toContainEqual(finalDocument.cutWordIds);
    }
  });

  it("refreshes a Cuts-derived EDL and materializes its new revision", async () => {
    const { projectsDir, projectDir } = await createFixture();
    await addEditListFixture(projectDir);
    const projections: Array<{ projectId: string; revision: string }> = [];
    const handle = createVideocutCutsHandler({
      projectsDir,
      materializeIndex(change) {
        projections.push({ projectId: change.projectId, revision: change.revision });
      },
    });
    const current = await requiredResponse(handle(cutsRequest("GET")));
    const currentRevision = (await current.json()).revision as string;

    const response = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: currentRevision,
      cutWordIds: ["w-2"],
    })));
    const body = await response.json();
    const editListRaw = await readFile(join(projectDir, "edit-list.json"), "utf8");
    const editList = JSON.parse(editListRaw);
    expect(response.status).toBe(200);
    expect(body.editListRevision).toBe(sha256(editListRaw));
    expect(editList).toMatchObject({
      mode: "cuts-derived",
      baseCutsRevision: body.revision,
      segments: [{ sourceStart: 0, sourceEnd: 1, timelineStart: 0 }],
    });
    expect(projections).toEqual([{ projectId: "demo", revision: body.editListRevision }]);
  });

  it("rejects a Cuts write when the project has not been prepared", async () => {
    const { projectsDir, cutsPath } = await createFixture();
    const before = await readFile(cutsPath, "utf8");
    const handle = createVideocutCutsHandler({ projectsDir });
    const response = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: sha256(before),
      cutWordIds: ["w-2"],
    })));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_edit_list",
        details: { reason: "project_not_prepared", projectId: "demo" },
      },
    });
    expect(await readFile(cutsPath, "utf8")).toBe(before);
  });

  it("carves new deletions out of a manual EDL instead of refusing or rebuilding", async () => {
    // Refusing this outright left semantic review with no way in once the user
    // had touched the timeline even once. Rebuilding from Cuts would discard the
    // arrangement. So only the newly deleted range is carved out, one operation
    // at a time, and the hand-arranged timeline otherwise stands.
    const { projectsDir, projectDir, cutsPath } = await createFixture();
    // The shared fixture keeps only 1-2s, so deleting w-2 would empty the
    // timeline and be refused for that reason instead. Give the project a
    // hand-arranged timeline with room to lose a range.
    const editListPath = join(projectDir, "edit-list.json");
    await writeFile(editListPath, `${JSON.stringify({
      schemaVersion: 1,
      projectId: "demo",
      sourceDuration: 2,
      baseCutsRevision: sha256(await readFile(cutsPath, "utf8")),
      baseTranscriptRevision: sha256(await readFile(join(projectDir, "transcript.json"), "utf8")),
      mode: "manual",
      duration: 2,
      segments: [
        {
          id: "a-roll-0001", source: "input/source.mp4",
          sourceStart: 0, sourceEnd: 1, timelineStart: 0, trackId: "a-roll", playbackRate: 1,
        },
        {
          id: "a-roll-0002", source: "input/source.mp4",
          sourceStart: 1, sourceEnd: 2, timelineStart: 1, trackId: "a-roll", playbackRate: 1,
        },
      ],
    }, null, 2)}\n`);
    const before = JSON.parse(await readFile(editListPath, "utf8")) as {
      mode: string;
      duration: number;
      segments: { sourceStart: number; sourceEnd: number }[];
    };
    expect(before.mode).toBe("manual");
    const cutsBefore = await readFile(cutsPath, "utf8");

    const handle = createVideocutCutsHandler({ projectsDir });
    const response = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: sha256(cutsBefore),
      cutWordIds: ["w-2"],
    })));

    expect(response.status).toBe(200);
    const after = JSON.parse(await readFile(editListPath, "utf8")) as typeof before;
    expect(after.mode).toBe("manual");
    expect(after.duration).toBeLessThan(before.duration);
    // Cuts recorded the reason as well, so the deletion is still explainable.
    expect(JSON.parse(await readFile(cutsPath, "utf8")).cutWordIds).toContain("w-2");
  });

  it("leaves a manual EDL untouched when the deletion is already off the timeline", async () => {
    // Ranges Cuts already claimed, and ranges the user restored on purpose, are
    // both skipped: an explicit user action outranks a suggestion.
    const { projectsDir, projectDir, cutsPath } = await createFixture();
    const editListBefore = await addEditListFixture(projectDir, "manual");
    const cutsBefore = JSON.parse(await readFile(cutsPath, "utf8")) as { cutWordIds: string[] };
    const handle = createVideocutCutsHandler({ projectsDir });
    const response = await requiredResponse(handle(cutsRequest("PUT", {
      expectedRevision: sha256(await readFile(cutsPath, "utf8")),
      cutWordIds: cutsBefore.cutWordIds,
    })));

    expect(response.status).toBe(200);
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(editListBefore);
  });
});
