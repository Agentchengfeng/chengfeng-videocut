import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectProject,
  registerProject,
  resolveProject,
  sha256,
  writeCutSelection,
} from "./node";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function createFixture(): Promise<{
  root: string;
  projectDir: string;
  projectsDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-core-"));
  cleanupPaths.push(root);
  const projectDir = join(root, "demo");
  const projectsDir = join(root, "registry");
  await mkdir(join(projectDir, "input"), { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    join(projectDir, "project.json"),
    JSON.stringify(
      {
        jobId: "demo",
        status: "cut_review_ready",
        inputVideo: "input/source.mp4",
        config: { aspectRatio: "4:3" },
        workbench: { url: "http://localhost:5190/#project/demo" },
      },
      null,
      2,
    ),
  );
  await writeFile(join(projectDir, "input/source.mp4"), "fixture");
  await writeFile(join(projectDir, "index.html"), "<!doctype html><title>demo</title>");
  await writeFile(
    join(projectDir, "transcript.json"),
    JSON.stringify({
      schemaVersion: 1,
      cues: [
        {
          id: "cue-1",
          words: [
            { id: "w-1", text: "", start: 0, end: 1, isGap: true },
            { id: "w-2", text: "你", start: 1, end: 2, isGap: false },
            { id: "w-3", text: "好", start: 2, end: 3, isGap: false },
          ],
        },
      ],
    }),
  );
  await writeFile(
    join(projectDir, "cut-selection.json"),
    JSON.stringify(
      {
        schemaVersion: 3,
        cutWordIds: ["w-1"],
        cutRanges: [{ start: 0, end: 1 }],
        initialization: { mode: "delete-or-keep-v1" },
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
      null,
      2,
    ),
  );
  return { root, projectDir, projectsDir };
}

describe("project store", () => {
  it("resolves and inspects a legacy project without changing it", async () => {
    const { projectDir } = await createFixture();
    const before = await readFile(join(projectDir, "project.json"), "utf8");
    const project = await resolveProject(projectDir);
    const result = await inspectProject(project);

    expect(result.projectId).toBe("demo");
    expect(result.status).toBe("cut_review_ready");
    expect((result.documents as Record<string, any>).transcript.wordCount).toBe(3);
    expect((result.documents as Record<string, any>).cuts.rangesMatchTranscript).toBe(true);
    expect(await readFile(join(projectDir, "project.json"), "utf8")).toBe(before);
  });

  it("registers a project once and resolves it by id", async () => {
    const { projectDir, projectsDir } = await createFixture();
    const project = await resolveProject(projectDir);
    expect((await registerProject(project, projectsDir)).registered).toBe(true);
    expect((await registerProject(project, projectsDir)).registered).toBe(false);
    expect((await resolveProject("demo", { projectsDir })).directory).toBe(
      await realpath(projectDir),
    );
  });

  it("resolves a bare id from the registry before a cwd shadow", async () => {
    const { root, projectDir, projectsDir } = await createFixture();
    const project = await resolveProject(projectDir);
    await registerProject(project, projectsDir);

    const cwd = join(root, "cwd");
    const shadowDir = join(cwd, "demo");
    await mkdir(shadowDir, { recursive: true });
    await writeFile(
      join(shadowDir, "project.json"),
      JSON.stringify({ jobId: "cwd-shadow", status: "uploaded" }),
    );

    expect((await resolveProject("demo", { cwd, projectsDir })).directory).toBe(
      await realpath(projectDir),
    );
    expect((await resolveProject("./demo", { cwd, projectsDir })).directory).toBe(
      await realpath(shadowDir),
    );
  });

  it("resolves a bare id from output before a cwd shadow when unregistered", async () => {
    const { root, projectsDir } = await createFixture();
    const outputDir = join(root, "output");
    const outputProjectDir = join(outputDir, "output-demo");
    const cwd = join(root, "cwd-output");
    const shadowDir = join(cwd, "output-demo");
    await mkdir(outputProjectDir, { recursive: true });
    await mkdir(shadowDir, { recursive: true });
    await writeFile(
      join(outputProjectDir, "project.json"),
      JSON.stringify({ jobId: "output-demo", status: "uploaded" }),
    );
    await writeFile(
      join(shadowDir, "project.json"),
      JSON.stringify({ jobId: "cwd-output-shadow", status: "uploaded" }),
    );

    expect(
      (await resolveProject("output-demo", { cwd, projectsDir, outputDir })).directory,
    ).toBe(await realpath(outputProjectDir));
  });

  it("atomically writes derived cuts and preserves initialization", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const result = await writeCutSelection(
      project,
      { cutWordIds: ["w-2", "w-3"], cutRanges: [{ start: 88, end: 99 }] },
      { now: "2026-07-16T01:00:00.000Z" },
    );
    const written = JSON.parse(await readFile(join(projectDir, "cut-selection.json"), "utf8"));

    expect(result.changed).toBe(true);
    expect(written.cutRanges).toEqual([{ start: 1, end: 3 }]);
    expect(written.initialization).toEqual({ mode: "delete-or-keep-v1" });
    expect(await readdir(projectDir)).not.toContainEqual(expect.stringContaining(".tmp"));
  });

  it("rejects stale revisions and invalid ids without modifying the file", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const path = join(projectDir, "cut-selection.json");
    const before = await readFile(path, "utf8");

    await expect(
      writeCutSelection(
        project,
        { cutWordIds: ["w-2"] },
        { expectedRevision: sha256("stale") },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      writeCutSelection(project, { cutWordIds: ["missing"] }),
    ).rejects.toMatchObject({ code: "invalid_cut_selection" });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("serializes concurrent writes so the same expected revision commits once", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const path = join(projectDir, "cut-selection.json");
    const expectedRevision = sha256(await readFile(path, "utf8"));

    const results = await Promise.allSettled([
      writeCutSelection(
        project,
        { cutWordIds: ["w-2"] },
        { expectedRevision, now: "2026-07-16T01:00:00.000Z" },
      ),
      writeCutSelection(
        project,
        { cutWordIds: ["w-3"] },
        { expectedRevision, now: "2026-07-16T01:00:01.000Z" },
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "revision_conflict" });
    }
    const written = JSON.parse(await readFile(path, "utf8"));
    expect([["w-2"], ["w-3"]]).toContainEqual(written.cutWordIds);
  });

  it("supports a dry run without touching the project", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const path = join(projectDir, "cut-selection.json");
    const before = await readFile(path, "utf8");
    const result = await writeCutSelection(
      project,
      { cutWordIds: ["w-2"] },
      { dryRun: true, now: "2026-07-16T02:00:00.000Z" },
    );

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
