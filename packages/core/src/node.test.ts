import { afterEach, describe, expect, it } from "bun:test";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  doctor,
  inspectProject,
  projectOperationLockPath,
  registerProject,
  resolveProject,
  serializeProjectOperation,
  sha256,
  patchEditList,
  readEditList,
  writeEditList,
  writeCutSelection,
  writeCutSelectionWithEditList,
} from "./node";
import { buildEditListFromCuts } from "./editList";

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

async function waitForPaths(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(paths.map(async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    }));
    if (ready.every(Boolean)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error(`Timed out waiting for: ${paths.join(", ")}`);
}

interface ConcurrentWriterResult {
  contender: string;
  status: "fulfilled" | "rejected";
  code?: string | null;
  revision?: string;
  sourceStart: number;
}

async function collectWriter(
  processHandle: Bun.ReadableSubprocess,
): Promise<ConcurrentWriterResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Concurrent EDL writer exited ${exitCode}: ${stderr || stdout}`);
  }
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`Concurrent EDL writer returned no result: ${stderr}`);
  return JSON.parse(line) as ConcurrentWriterResult;
}

describe("project store", () => {
  it("advertises the managed Studio service contract to fail-closed Skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "videocut-doctor-contract-"));
    cleanupPaths.push(root);
    const result = await doctor({ projectsDir: join(root, "projects") });
    expect(result.capabilities).toMatchObject({
      runtimeApiVersion: 1,
      serviceApiVersion: 1,
      serviceOperations: ["install", "start", "stop", "restart", "status", "logs", "ensure"],
      managedStudioService: true,
      serviceParentProcessIndependent: true,
      serviceCrashRestart: true,
      cloudTranscriptionProvider: "volcengine",
      cloudTranscriptionTaskLocalOnly: true,
    });
  });
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

  it("keeps the Product pause baseline for semantic overlays but lets full selections restore it", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const cutsPath = join(projectDir, "cut-selection.json");
    await writeFile(cutsPath, JSON.stringify({
      schemaVersion: 3,
      cutWordIds: ["w-1"],
      cutRanges: [{ start: 0, end: 1 }],
      initialization: {
        mode: "delete-or-keep-v2",
        naturalPausePolicy: "natural-pause-v2",
        baselineCutWordIds: ["w-1", "missing", "w-1", 42],
      },
      updatedAt: "2026-07-16T00:00:00.000Z",
    }, null, 2));
    const initialCutsRaw = await readFile(cutsPath, "utf8");
    const transcriptRaw = await readFile(join(projectDir, "transcript.json"), "utf8");
    await writeEditList(project, buildEditListFromCuts({
      projectId: "demo",
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(initialCutsRaw),
      transcriptRevision: sha256(transcriptRaw),
      cutRanges: [{ start: 0, end: 1 }],
    }), { expectedRevision: "none" });

    const overlay = await writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-2"] },
      {
        expectedRevision: sha256(initialCutsRaw),
        mode: "semantic-overlay",
        now: "2026-07-16T01:00:00.000Z",
      },
    );
    expect(overlay.cuts.document.cutWordIds).toEqual(["w-1", "w-2"]);
    expect(overlay.cuts.document.cutRanges).toEqual([{ start: 0, end: 2 }]);
    expect(overlay.editList?.document).toMatchObject({
      duration: 1,
      segments: [{ sourceStart: 2, sourceEnd: 3, timelineStart: 0 }],
    });

    const repeated = await writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-2"] },
      { expectedRevision: overlay.cuts.revision, mode: "semantic-overlay" },
    );
    expect(repeated.cuts.changed).toBe(false);
    expect(repeated.cuts.revision).toBe(overlay.cuts.revision);
    expect(repeated.editList).toBeNull();
    await expect(writeCutSelectionWithEditList(
      project,
      { cutWordIds: [] },
      { expectedRevision: sha256(initialCutsRaw), mode: "semantic-overlay" },
    )).rejects.toMatchObject({ code: "revision_conflict" });

    const fullSelection = await writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-2"] },
      { expectedRevision: overlay.cuts.revision, mode: "full-selection" },
    );
    expect(fullSelection.cuts.document.cutWordIds).toEqual(["w-2"]);
    expect(fullSelection.cuts.document.initialization).toMatchObject({
      naturalPausePolicy: "natural-pause-v2",
      baselineCutWordIds: ["w-1", "missing", "w-1", 42],
    });
    expect(fullSelection.editList?.document.segments).toMatchObject([
      { sourceStart: 0, sourceEnd: 1, timelineStart: 0 },
      { sourceStart: 2, sourceEnd: 3, timelineStart: 1 },
    ]);

  });

  it("absorbs enclosed ASR gaps for semantic overlays but preserves exact full selections", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const transcriptPath = join(projectDir, "transcript.json");
    const cutsPath = join(projectDir, "cut-selection.json");
    await writeFile(transcriptPath, JSON.stringify({
      schemaVersion: 1,
      cues: [
        {
          id: "cue-1",
          words: [
            { id: "w-1", text: "删", start: 0, end: 1, isGap: false },
            { id: "w-2", text: "", start: 1, end: 1.12, isGap: true },
            { id: "w-3", text: "掉", start: 1.12, end: 2, isGap: false },
            { id: "w-4", text: "保留", start: 2, end: 3, isGap: false },
          ],
        },
      ],
    }, null, 2));
    await writeFile(cutsPath, JSON.stringify({
      schemaVersion: 3,
      cutWordIds: [],
      cutRanges: [],
      initialization: {
        mode: "delete-or-keep-v2",
        naturalPausePolicy: "natural-pause-v2",
        baselineCutWordIds: [],
      },
      updatedAt: "2026-07-20T00:00:00.000Z",
    }, null, 2));
    const initialCutsRaw = await readFile(cutsPath, "utf8");
    const transcriptRaw = await readFile(transcriptPath, "utf8");
    await writeEditList(project, buildEditListFromCuts({
      projectId: "demo",
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(initialCutsRaw),
      transcriptRevision: sha256(transcriptRaw),
      cutRanges: [],
    }), { expectedRevision: "none" });

    const overlay = await writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-1", "w-3"] },
      {
        expectedRevision: sha256(initialCutsRaw),
        mode: "semantic-overlay",
        now: "2026-07-20T01:00:00.000Z",
      },
    );
    expect(overlay.cuts.document.cutWordIds).toEqual(["w-1", "w-2", "w-3"]);
    expect(overlay.cuts.document.cutRanges).toEqual([{ start: 0, end: 2 }]);
    expect(overlay.editList?.document.segments).toMatchObject([
      { sourceStart: 2, sourceEnd: 3, timelineStart: 0 },
    ]);

    const fullSelection = await writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-1", "w-3"] },
      {
        expectedRevision: overlay.cuts.revision,
        mode: "full-selection",
        now: "2026-07-20T02:00:00.000Z",
      },
    );
    expect(fullSelection.cuts.document.cutWordIds).toEqual(["w-1", "w-3"]);
    expect(fullSelection.cuts.document.cutRanges).toEqual([
      { start: 0, end: 1 },
      { start: 1.12, end: 2 },
    ]);
    expect(fullSelection.editList?.document.segments).toMatchObject([
      { sourceStart: 1, sourceEnd: 1.12, timelineStart: 0 },
      { sourceStart: 2, sourceEnd: 3, timelineStart: 0.12 },
    ]);
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

  it("CAS-patches the edit list and serializes concurrent timeline edits", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const transcriptRaw = await readFile(join(projectDir, "transcript.json"), "utf8");
    const cutsRaw = await readFile(join(projectDir, "cut-selection.json"), "utf8");
    const created = await writeEditList(project, buildEditListFromCuts({
      projectId: "demo",
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(cutsRaw),
      transcriptRevision: sha256(transcriptRaw),
      cutRanges: [{ start: 0, end: 1 }],
    }), { expectedRevision: "none" });
    expect(created.document.segments).toHaveLength(1);

    const results = await Promise.allSettled([
      patchEditList(project, {
        type: "trim",
        clipId: "a-roll-0001",
        sourceStart: 1.25,
        sourceEnd: 3,
      }, { expectedRevision: created.revision }),
      patchEditList(project, {
        type: "trim",
        clipId: "a-roll-0001",
        sourceStart: 1.5,
        sourceEnd: 3,
      }, { expectedRevision: created.revision }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = await readEditList(project);
    expect(current).not.toBeNull();
    expect(current?.value.mode).toBe("manual");
    expect([1.25, 1.5]).toContain(current!.value.segments[0]!.sourceStart);
    expect(await readdir(projectDir)).not.toContainEqual(expect.stringContaining(".tmp"));
  });

  it("CAS-restores only the exact delete-range inverse without changing a stale file", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const transcriptRaw = await readFile(join(projectDir, "transcript.json"), "utf8");
    const cutsRaw = await readFile(join(projectDir, "cut-selection.json"), "utf8");
    const created = await writeEditList(project, buildEditListFromCuts({
      projectId: "demo",
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(cutsRaw),
      transcriptRevision: sha256(transcriptRaw),
      cutRanges: [{ start: 0, end: 1 }],
    }), { expectedRevision: "none" });
    const inverse = {
      type: "delete-range" as const,
      source: "input/source.mp4",
      sourceStart: 1.5,
      sourceEnd: 2,
    };
    const deleted = await patchEditList(project, inverse, {
      expectedRevision: created.revision,
    });
    const beforeStaleUndo = await readFile(join(projectDir, "edit-list.json"), "utf8");
    await expect(patchEditList(project, {
      type: "restore-snapshot",
      expectedSegments: deleted.document.segments,
      beforeSegments: created.document.segments,
      beforeMode: created.document.mode,
      inverse,
    }, { expectedRevision: created.revision })).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await readFile(join(projectDir, "edit-list.json"), "utf8")).toBe(beforeStaleUndo);

    const restored = await patchEditList(project, {
      type: "restore-snapshot",
      expectedSegments: deleted.document.segments,
      beforeSegments: created.document.segments,
      beforeMode: created.document.mode,
      inverse,
    }, { expectedRevision: deleted.revision });
    expect(restored.document).toEqual(created.document);
  });

  it("CAS-patches an edit list exactly once across two independent Bun processes", async () => {
    const { root, projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const transcriptRaw = await readFile(join(projectDir, "transcript.json"), "utf8");
    const cutsRaw = await readFile(join(projectDir, "cut-selection.json"), "utf8");
    const created = await writeEditList(project, buildEditListFromCuts({
      projectId: "demo",
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(cutsRaw),
      transcriptRevision: sha256(transcriptRaw),
      cutRanges: [{ start: 0, end: 1 }],
    }), { expectedRevision: "none" });
    const barrierDirectory = join(root, "barrier");
    await mkdir(barrierDirectory);
    const workerPath = fileURLToPath(
      new URL("./test-fixtures/concurrent-edl-writer.ts", import.meta.url),
    );
    const startWriter = (contender: string, sourceStart: number) => Bun.spawn({
      cmd: [
        process.execPath,
        workerPath,
        projectDir,
        barrierDirectory,
        contender,
        created.revision,
        String(sourceStart),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const writers = [startWriter("left", 1.25), startWriter("right", 1.5)];

    await waitForPaths([
      join(barrierDirectory, "left.ready"),
      join(barrierDirectory, "right.ready"),
    ]);
    await writeFile(join(barrierDirectory, "go"), "go");
    const results = await Promise.all(writers.map(collectWriter));

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe("revision_conflict");

    const current = await readEditList(project);
    expect(current?.value.segments[0]?.sourceStart).toBe(fulfilled[0]?.sourceStart);
    expect(current?.revision).toBe(fulfilled[0]?.revision);
    expect((await readdir(projectDir)).filter((name) =>
      name.includes("chengfeng-videocut.write.lock"))).toEqual([]);
  });

  it("times out on a live lock and recovers a stale lock without remnants", async () => {
    const { projectDir } = await createFixture();
    const lockPath = projectOperationLockPath(projectDir);
    await mkdir(lockPath);
    // Claim the lock for a process that is genuinely alive — this one. An
    // ownerless lock is now recovered on sight, so it can no longer stand in
    // for a held lock here.
    await writeFile(join(lockPath, "owner"), JSON.stringify({
      version: 1,
      token: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    }), "utf8");

    await expect(serializeProjectOperation(
      projectDir,
      async () => "unreachable",
      { timeoutMs: 30, staleMs: 10_000, pollIntervalMs: 5 },
    )).rejects.toMatchObject({
      code: "io_error",
      details: { reason: "project_lock_timeout" },
    });

    // Hand the lock to another machine so liveness cannot be probed locally,
    // then age it past the stale window: that is the case the full timeout is
    // meant for.
    await writeFile(join(lockPath, "owner"), JSON.stringify({
      version: 1,
      token: "remote-owner",
      pid: 1,
      hostname: `${hostname()}-elsewhere`,
      acquiredAt: new Date().toISOString(),
    }), "utf8");
    const old = new Date(Date.now() - 2_000);
    await utimes(lockPath, old, old);
    const result = await serializeProjectOperation(
      projectDir,
      async () => "recovered",
      { timeoutMs: 500, staleMs: 20, pollIntervalMs: 5, heartbeatIntervalMs: 10 },
    );
    expect(result).toBe("recovered");
    expect((await readdir(projectDir)).filter((name) =>
      name.includes("chengfeng-videocut.write.lock"))).toEqual([]);
  });

  it("recovers an ownerless lock instead of waiting out the full stale window", async () => {
    // A process killed between creating the lock directory and writing the
    // owner leaves a lock nobody can be shown to hold. Treating that as a
    // possibly-live lock froze every write on the project for the whole stale
    // window — five minutes in production — with each attempt first hanging for
    // the full timeout. The lock having no owner is itself the evidence.
    const { projectDir } = await createFixture();
    const lockPath = projectOperationLockPath(projectDir);
    await mkdir(lockPath);
    const old = new Date(Date.now() - 2_000);
    await utimes(lockPath, old, old);

    const result = await serializeProjectOperation(
      projectDir,
      async () => "recovered",
      { timeoutMs: 500, staleMs: 300_000, pollIntervalMs: 5, heartbeatIntervalMs: 10 },
    );
    expect(result).toBe("recovered");
    expect((await readdir(projectDir)).filter((name) =>
      name.includes("chengfeng-videocut.write.lock"))).toEqual([]);
  });

  it("never publishes a lock without its owner record", async () => {
    const { projectDir } = await createFixture();
    const lockPath = projectOperationLockPath(projectDir);
    let ownerSeen: string | null = null;
    await serializeProjectOperation(projectDir, async () => {
      ownerSeen = await readFile(join(lockPath, "owner"), "utf8");
      return "held";
    }, { timeoutMs: 500, pollIntervalMs: 5, heartbeatIntervalMs: 10 });
    expect(ownerSeen).toBeTruthy();
    expect(JSON.parse(ownerSeen as unknown as string)).toMatchObject({
      version: 1,
      pid: process.pid,
    });
    // Staging directories must not survive a successful publish.
    expect((await readdir(projectDir)).filter((name) =>
      name.includes("chengfeng-videocut.write.lock"))).toEqual([]);
  });

  it("rejects an all-deleted derived update before either Cuts or EDL is committed", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const transcriptRaw = await readFile(join(projectDir, "transcript.json"), "utf8");
    const cutsPath = join(projectDir, "cut-selection.json");
    const editListPath = join(projectDir, "edit-list.json");
    const cutsRaw = await readFile(cutsPath, "utf8");
    await writeEditList(project, buildEditListFromCuts({
      projectId: "demo",
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(cutsRaw),
      transcriptRevision: sha256(transcriptRaw),
      cutRanges: [{ start: 0, end: 1 }],
    }), { expectedRevision: "none" });
    const editListRaw = await readFile(editListPath, "utf8");

    await expect(writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-1", "w-2", "w-3"] },
      { expectedRevision: sha256(cutsRaw) },
    )).rejects.toMatchObject({ code: "invalid_edit_list" });

    expect(await readFile(cutsPath, "utf8")).toBe(cutsRaw);
    expect(await readFile(editListPath, "utf8")).toBe(editListRaw);
  });

  it("rejects a Cuts transaction before the project has an EDL", async () => {
    const { projectDir } = await createFixture();
    const project = await resolveProject(projectDir);
    const cutsPath = join(projectDir, "cut-selection.json");
    const cutsRaw = await readFile(cutsPath, "utf8");

    await expect(writeCutSelectionWithEditList(
      project,
      { cutWordIds: ["w-2"] },
      { expectedRevision: sha256(cutsRaw) },
    )).rejects.toMatchObject({
      code: "invalid_edit_list",
      details: { reason: "project_not_prepared", projectId: "demo" },
    });

    expect(await readFile(cutsPath, "utf8")).toBe(cutsRaw);
    await expect(readFile(join(projectDir, "edit-list.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
describe("project event log", () => {
  // Before this existed, a deletion left two numbers in cut-selection.json and
  // nothing else, and events.jsonl only ever held the two lines written when the
  // project was prepared. On 2026-07-26 a real timeline lost two segments and
  // 2.32 seconds and it was impossible to say what had done it — not because the
  // evidence was ambiguous, but because none was recorded.
  const readEvents = async (projectDir: string) => {
    const raw = await readFile(join(projectDir, "events.jsonl"), "utf8").catch(() => "");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      ts: string; type: string; actor: string; payload: Record<string, unknown>;
    });
  };

  it("records every committed cut-selection change with who asked", async () => {
    const fixture = await createFixture();
    const project = await resolveProject(fixture.projectDir);

    const before = await readEvents(fixture.projectDir);
    await writeCutSelection(project, { cutWordIds: ["w-1", "w-2"] }, { actor: "cli" });
    const after = await readEvents(fixture.projectDir);

    expect(after).toHaveLength(before.length + 1);
    const event = after.at(-1)!;
    expect(event.type).toBe("cuts_written");
    expect(event.actor).toBe("cli");
    expect(event.payload.projectId).toBe(project.projectId);
    expect(event.payload.changed).toBe(true);
    expect(event.payload.cutWordCount).toBe(2);
    // The revision pair is what makes an incident traceable: it says which state
    // this change moved the project from, and to.
    expect(event.payload.previousRevision).not.toBe(event.payload.revision);
    expect(String(event.payload.revision)).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(event.ts)).toBeGreaterThan(0);
  });

  it("records which timeline operation was asked for, and who by", async () => {
    const fixture = await createFixture();
    const project = await resolveProject(fixture.projectDir);
    const cuts = await readFile(join(fixture.projectDir, "cut-selection.json"), "utf8");
    const transcript = await readFile(join(fixture.projectDir, "transcript.json"), "utf8");
    await writeEditList(project, buildEditListFromCuts({
      projectId: project.projectId,
      source: "input/source.mp4",
      sourceDuration: 3,
      cutsRevision: sha256(cuts),
      transcriptRevision: sha256(transcript),
      cutRanges: [{ start: 0, end: 1 }],
    }), {});
    const listed = await readEditList(project);

    await patchEditList(project, {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 2,
      sourceEnd: 3,
    }, { expectedRevision: listed!.revision, actor: "studio-transcript" });

    const events = await readEvents(fixture.projectDir);
    const patched = events.filter((event) => event.type === "edit_list_patched");
    expect(patched).toHaveLength(1);
    expect(patched[0]!.actor).toBe("studio-transcript");
    const operation = patched[0]!.payload.operation as Record<string, unknown>;
    expect(operation.type).toBe("delete-range");
    expect(operation.sourceStart).toBe(2);
    expect(operation.sourceEnd).toBe(3);
    // The write that created the list is its own line, so the two are not confused.
    expect(events.filter((event) => event.type === "edit_list_written")).toHaveLength(1);
  });

  it("says unknown rather than guessing when the caller does not declare itself", async () => {
    const fixture = await createFixture();
    const project = await resolveProject(fixture.projectDir);
    await writeCutSelection(project, { cutWordIds: ["w-1", "w-3"] }, {});
    expect((await readEvents(fixture.projectDir)).at(-1)!.actor).toBe("unknown");
  });

  it("does not record a dry run or a write that changed nothing", async () => {
    const fixture = await createFixture();
    const project = await resolveProject(fixture.projectDir);

    await writeCutSelection(project, { cutWordIds: ["w-1"] }, { dryRun: true, actor: "cli" });
    expect(await readEvents(fixture.projectDir)).toHaveLength(0);

    // Same ids as the fixture already holds: nothing committed, nothing to say.
    await writeCutSelection(project, { cutWordIds: ["w-1"] }, { actor: "cli" });
    const events = await readEvents(fixture.projectDir);
    expect(events.filter((event) => event.payload.changed === false)).toHaveLength(0);
  });
});
