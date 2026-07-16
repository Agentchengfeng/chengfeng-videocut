/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    mode: "delete-or-keep-v1",
    naturalPausePolicy: "natural-pause-v2",
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

function cutsRequest(
  method: "GET" | "PUT",
  body?: Record<string, unknown>,
): Request {
  return new Request("http://localhost/api/v1/projects/demo/cuts", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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

  it("rejects metadata injection and preserves stored metadata on valid writes", async () => {
    const { projectsDir, cutsPath } = await createFixture();
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
    const { projectsDir, cutsPath } = await createFixture();
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
});
