/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts } from "@video-workbench/core";
import {
  createVideocutProjectSurfaceHandler,
  isVideocutProjectSurfaceRequest,
} from "./videocutProjectSurfaceApi";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readSnapshot(projectDir: string): Promise<Record<string, string>> {
  const files = [
    "project.json",
    "workbench.json",
    "transcript.json",
    "cut-selection.json",
    "edit-list.json",
    "index.html",
    "input/source.mp4",
  ];
  return Object.fromEntries(await Promise.all(files.map(async (file) => [
    file,
    await readFile(join(projectDir, file), "utf8"),
  ]))) as Record<string, string>;
}

async function fixture(options: {
  projectId?: string;
  jobId?: string;
  surface?: "koubo" | "other" | undefined;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "videocut-project-surface-"));
  cleanupPaths.push(root);
  const projectsDir = join(root, "projects");
  const projectId = options.projectId ?? "demo";
  const jobId = options.jobId ?? projectId;
  const projectDir = join(projectsDir, projectId);
  const source = "input/source.mp4";
  const sourceBytes = "fixture immutable source";
  const sourceSha256 = digest(sourceBytes);
  await mkdir(join(projectDir, "input"), { recursive: true });
  await writeFile(join(projectDir, source), sourceBytes);

  const transcript = {
    schemaVersion: 1,
    cues: [{
      id: "cue-1",
      start: 0,
      end: 10,
      words: [{ id: "word-1", text: "测试", start: 0, end: 1 }],
    }],
  };
  const transcriptRaw = `${JSON.stringify(transcript, null, 2)}\n`;
  const cuts = {
    schemaVersion: 3,
    cutWordIds: [],
    cutRanges: [],
  };
  const cutsRaw = `${JSON.stringify(cuts, null, 2)}\n`;
  const editList = buildEditListFromCuts({
    projectId: jobId,
    source,
    sourceDuration: 10,
    transcriptRevision: digest(transcriptRaw),
    cutsRevision: digest(cutsRaw),
    cutRanges: [],
  });
  const editListRaw = `${JSON.stringify(editList, null, 2)}\n`;
  const index = `<!doctype html>
<!-- generated-by: chengfeng-videocut -->
<main data-edit-list-revision="${digest(editListRaw)}" data-videocut-projection-schema="1" data-videocut-projection-runtime="5"></main>
`;
  const workbench = {
    schemaVersion: 1,
    projectId: jobId,
    videoSource: source,
    sourceSha256,
  };
  const project = {
    jobId,
    source: { path: source, sha256: sourceSha256, immutable: true },
    artifacts: {
      workbenchEntry: "index.html",
      workbenchTranscript: "transcript.json",
      workbenchCutSelection: "cut-selection.json",
      workbenchEditList: "edit-list.json",
    },
    workbench: {
      projectId: jobId,
      url: `http://127.0.0.1:5190/#project/${projectId}`,
      ...(options.surface === undefined ? {} : { surface: options.surface }),
    },
  };
  await Promise.all([
    writeFile(join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`),
    writeFile(join(projectDir, "workbench.json"), `${JSON.stringify(workbench, null, 2)}\n`),
    writeFile(join(projectDir, "transcript.json"), transcriptRaw),
    writeFile(join(projectDir, "cut-selection.json"), cutsRaw),
    writeFile(join(projectDir, "edit-list.json"), editListRaw),
    writeFile(join(projectDir, "index.html"), index),
  ]);
  return { root, projectsDir, projectDir, projectId };
}

async function required(value: Promise<Response | null>): Promise<Response> {
  const response = await value;
  if (!response) throw new Error("Expected project-surface handler response");
  return response;
}

function surfaceUrl(projectId = "demo"): string {
  return `http://localhost/api/projects/${encodeURIComponent(projectId)}/surface`;
}

describe("videocut project surface API", () => {
  it("positively classifies a complete legacy Koubo project without writing it", async () => {
    const { projectsDir, projectDir } = await fixture();
    const before = await readSnapshot(projectDir);
    const entriesBefore = await readdir(projectDir);
    const handler = createVideocutProjectSurfaceHandler({ projectsDir });

    const response = await required(handler(new Request(surfaceUrl())));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      projectId: "demo",
      surface: "koubo",
    });
    expect(await readSnapshot(projectDir)).toEqual(before);
    expect(await readdir(projectDir)).toEqual(entriesBefore);
  });

  it("accepts the explicit new marker but rejects a conflicting surface declaration", async () => {
    const marked = await fixture({ projectId: "marked", surface: "koubo" });
    const conflict = await fixture({ projectId: "conflict", surface: "other" });
    const handler = createVideocutProjectSurfaceHandler({ projectsDir: marked.projectsDir });
    // The fixtures use separate project registries.  Add the conflicting
    // project under the same registry to exercise the two manifest forms.
    await mkdir(join(marked.projectsDir, "conflict"), { recursive: true });
    for (const file of await readdir(conflict.projectDir)) {
      if (file === "input") continue;
      await writeFile(
        join(marked.projectsDir, "conflict", file),
        await readFile(join(conflict.projectDir, file)),
      );
    }
    await mkdir(join(marked.projectsDir, "conflict", "input"), { recursive: true });
    await writeFile(
      join(marked.projectsDir, "conflict", "input/source.mp4"),
      "fixture immutable source",
    );

    expect((await required(handler(new Request(surfaceUrl("marked"))))).status).toBe(200);
    const rejected = await required(handler(new Request(surfaceUrl("conflict"))));
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({
      error: { code: "project_surface_unknown" },
    });
  });

  it("fails closed for generic, malformed, mismatched, and escaped lookalikes", async () => {
    const { root, projectsDir, projectDir } = await fixture();
    const genericDir = join(projectsDir, "generic");
    await mkdir(genericDir, { recursive: true });
    await writeFile(join(genericDir, "project.json"), JSON.stringify({ jobId: "generic" }));
    await writeFile(join(genericDir, "index.html"), "<!doctype html><main data-hf-composition>generic</main>");

    const mismatchDir = join(projectsDir, "mismatch");
    await mkdir(mismatchDir, { recursive: true });
    for (const file of await readdir(projectDir)) {
      if (file === "input") continue;
      await writeFile(join(mismatchDir, file), await readFile(join(projectDir, file)));
    }
    await mkdir(join(mismatchDir, "input"), { recursive: true });
    await writeFile(join(mismatchDir, "input/source.mp4"), "fixture immutable source");
    const mismatchProject = JSON.parse(await readFile(join(mismatchDir, "project.json"), "utf8"));
    mismatchProject.jobId = "different-job";
    await writeFile(join(mismatchDir, "project.json"), `${JSON.stringify(mismatchProject, null, 2)}\n`);

    const escapedDir = join(projectsDir, "escaped");
    await mkdir(escapedDir, { recursive: true });
    for (const file of await readdir(projectDir)) {
      if (file === "index.html" || file === "input") continue;
      await writeFile(join(escapedDir, file), await readFile(join(projectDir, file)));
    }
    await mkdir(join(escapedDir, "input"), { recursive: true });
    await writeFile(join(escapedDir, "input/source.mp4"), "fixture immutable source");
    const escapedProject = JSON.parse(await readFile(join(escapedDir, "project.json"), "utf8"));
    escapedProject.jobId = "escaped";
    escapedProject.workbench.projectId = "escaped";
    const escapedWorkbench = JSON.parse(await readFile(join(escapedDir, "workbench.json"), "utf8"));
    escapedWorkbench.projectId = "escaped";
    const escapedEdit = JSON.parse(await readFile(join(escapedDir, "edit-list.json"), "utf8"));
    escapedEdit.projectId = "escaped";
    await writeFile(join(escapedDir, "project.json"), `${JSON.stringify(escapedProject, null, 2)}\n`);
    await writeFile(join(escapedDir, "workbench.json"), `${JSON.stringify(escapedWorkbench, null, 2)}\n`);
    await writeFile(join(escapedDir, "edit-list.json"), `${JSON.stringify(escapedEdit, null, 2)}\n`);
    const outsideIndex = join(root, "outside-index.html");
    await writeFile(outsideIndex, "<!-- generated-by: chengfeng-videocut -->");
    await symlink(outsideIndex, join(escapedDir, "index.html"));

    const handler = createVideocutProjectSurfaceHandler({ projectsDir });
    for (const id of ["generic", "mismatch", "escaped", "missing"]) {
      const response = await required(handler(new Request(surfaceUrl(id))));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "project_surface_unknown" },
      });
    }
  });

  it("owns the route and rejects invalid encodings, identifiers, and writes", async () => {
    const { projectsDir } = await fixture();
    const handler = createVideocutProjectSurfaceHandler({ projectsDir });

    expect(isVideocutProjectSurfaceRequest("GET", "/api/projects/demo/surface")).toBe(true);
    expect(isVideocutProjectSurfaceRequest("POST", "/api/projects/demo/surface")).toBe(true);
    expect(isVideocutProjectSurfaceRequest("GET", "/api/projects/demo/cuts")).toBe(false);

    const method = await required(handler(new Request(surfaceUrl(), { method: "POST" })));
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect((await required(handler(new Request(
      "http://localhost/api/projects/%2Fetc/surface",
    )))).status).toBe(400);
    expect((await required(handler(new Request(
      "http://localhost/api/projects/%E0%A4%A/surface",
    )))).status).toBe(400);
  });
});
