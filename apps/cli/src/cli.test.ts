import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeProjectOperation } from "@video-workbench/core/node";
import { runCli, type CliIo } from "./run";
import { startStudioServer } from "./server/start";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(): Promise<{ root: string; projectDir: string; projectsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-cli-"));
  cleanupPaths.push(root);
  const projectDir = join(root, "demo");
  const projectsDir = join(root, "registry");
  await mkdir(projectDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  await mkdir(join(projectDir, "input"), { recursive: true });
  await mkdir(join(projectDir, "剪口播/1_转录"), { recursive: true });
  await mkdir(join(projectDir, "剪口播/2_分析"), { recursive: true });
  await writeFile(join(projectDir, "input/source.mp4"), "fixture-media");
  await writeFile(join(projectDir, "剪口播/1_转录/subtitles_words.json"), JSON.stringify({
    schemaVersion: 1,
    cues: [{ id: "source-cue", words: [
      { id: "w-1", text: "前", start: 0, end: 1 },
      { id: "gap-1", text: "", start: 1, end: 2, isGap: true },
      { id: "w-2", text: "后", start: 2, end: 3 },
    ] }],
  }));
  await writeFile(join(projectDir, "剪口播/2_分析/auto_selected.json"), "[]\n");
  await writeFile(
    join(projectDir, "project.json"),
    JSON.stringify({
      jobId: "demo",
      status: "cut_review_ready",
      inputVideo: "input/source.mp4",
      config: { aspectRatio: "4:3" },
      workbench: { url: "http://localhost:5190/#project/demo" },
    }),
  );
  await writeFile(join(projectDir, "index.html"), "<!doctype html>");
  await writeFile(
    join(projectDir, "transcript.json"),
    JSON.stringify({
      cues: [
        { words: [{ id: "w-1", start: 0, end: 1 }, { id: "w-2", start: 1, end: 2 }] },
      ],
    }),
  );
  return { root, projectDir, projectsDir };
}

async function registerFixture(projectDir: string, projectsDir: string): Promise<void> {
  await symlink(projectDir, join(projectsDir, "demo"), "dir");
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("chengfeng-videocut CLI", () => {
  it("documents the confirmation-gated render command and stable exit codes", async () => {
    const capture = captureIo();
    const code = await runCli(["--help", "--json"], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);

    expect(code, `${capture.stderr.join(" | ")} ${capture.stdout.join(" | ")}`).toBe(0);
    expect(payload).toMatchObject({
      product: "chengfeng-videocut",
      command: "help",
      ok: true,
    });
    expect(payload.data.text).toContain(
      "chengfeng-videocut render run <project> --expected-revision <sha256> --confirmed",
    );
    expect(payload.data.text).toContain(
      "chengfeng-videocut project create <job-dir> --video <task-local-path> --transcript <task-local-path> --aspect-ratio <3:4|4:3|16:9>",
    );
    expect(payload.data.text).toContain(
      "cuts apply <project> --expected-revision <sha256> --expected-edit-list-revision <sha256> --confirmed",
    );
    expect(payload.data.text).toContain("chengfeng-videocut cuts get <project>");
    expect(payload.data.text).toContain("CHENGFENG_VIDEOCUT_RENDERER_PATH");
    expect(payload.data.text).toContain(
      "Render exit codes: 7 missing renderer, 8 renderer failed, 9 verification failed.",
    );
  });

  it("dispatches task-local Volcengine transcription without creating a project", async () => {
    const capture = captureIo();
    const calls: Array<{ jobDir: string; options: { video: string; output: string; language?: string } }> = [];
    const code = await runCli([
      "transcribe", "/tmp/task-01",
      "--video", "uploads/talk.mp4",
      "--output", "cloud/words.json",
      "--language", "zh-CN",
      "--json",
    ], {
      io: capture.io,
      runTranscription: async (jobDir, options) => {
        calls.push({ jobDir, options });
        return {
          provider: "volcengine",
          source: "/tmp/task-01/uploads/talk.mp4",
          output: "/tmp/task-01/cloud/words.json",
          cueCount: 1,
          wordCount: 2,
          duration: 3.2,
        };
      },
    });

    expect(code, capture.stdout.join(" | ")).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.jobDir).toBe("/tmp/task-01");
    // Not an exact match any more: the CLI now also passes whatever credentials
    // are configured on this machine, and a test that pinned the whole options
    // object would pass or fail depending on whether the developer running it
    // has a key set.
    expect(calls[0]?.options).toMatchObject({
      video: "uploads/talk.mp4",
      output: "cloud/words.json",
      language: "zh-CN",
    });
    expect(JSON.parse(capture.stdout[0])).toMatchObject({
      command: "transcribe",
      ok: true,
      data: { provider: "volcengine", cueCount: 1, wordCount: 2, duration: 3.2 },
    });
  });

  it("returns revision_required for the legacy cuts apply syntax instead of filling latest EDL", async () => {
    const capture = captureIo();
    const code = await runCli([
      "cuts", "apply", "demo",
      "--expected-revision", "a".repeat(64),
      "--confirmed",
      "--json",
    ], { io: capture.io });

    expect(code).toBe(2);
    expect(JSON.parse(capture.stdout[0])).toMatchObject({
      command: "cuts.apply",
      ok: false,
      error: {
        code: "revision_required",
        details: { reason: "missing_confirmed_edit_list_revision" },
      },
    });

    const noneCapture = captureIo();
    const noneCode = await runCli([
      "cuts", "apply", "demo",
      "--expected-revision", "a".repeat(64),
      "--expected-edit-list-revision", "none",
      "--confirmed",
      "--json",
    ], { io: noneCapture.io });
    expect(noneCode).toBe(2);
    expect(JSON.parse(noneCapture.stdout[0])).toMatchObject({
      command: "cuts.apply",
      ok: false,
      error: { code: "revision_required", details: { reason: "edit_list_required" } },
    });
  });

  it("returns a stable inspect JSON envelope", async () => {
    const { projectDir } = await fixture();
    const capture = captureIo();
    const code = await runCli(["inspect", projectDir, "--json"], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);

    expect(code).toBe(0);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      command: "inspect",
      ok: true,
      data: { projectId: "demo", status: "cut_review_ready" },
    });
  });

  it("creates, canonicalizes, prepares, and registers a real task in one command", async () => {
    const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-cli-create-"));
    cleanupPaths.push(root);
    const projectDir = join(root, "real-cloud-task");
    const projectsDir = join(root, "registry");
    await mkdir(join(projectDir, "incoming"), { recursive: true });
    await mkdir(join(projectDir, "cloud"), { recursive: true });
    await writeFile(join(projectDir, "incoming/talk.mp4"), "actual-video-bytes");
    await writeFile(join(projectDir, "cloud/words.json"), JSON.stringify({
      schemaVersion: 1,
      cues: [{
        id: "c-1",
        words: [{ id: "w-real", text: "真实", start: 0, end: 2 }],
      }],
    }));
    const capture = captureIo();

    const code = await runCli([
      "project", "create", projectDir,
      "--video", "incoming/talk.mp4",
      "--transcript", "cloud/words.json",
      "--aspect-ratio", "16:9",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);

    expect(code, `${capture.stderr.join(" | ")} ${capture.stdout.join(" | ")}`).toBe(0);
    expect(payload).toMatchObject({
      command: "project.create",
      ok: true,
      data: {
        projectId: "real-cloud-task",
        registered: true,
        canonicalVideo: "input/source.mp4",
        canonicalTranscript: "剪口播/1_转录/subtitles_words.json",
        metadata: { aspectRatio: "16:9", videoSource: "input/source.mp4" },
      },
    });
    expect(await realpath(join(projectsDir, "real-cloud-task"))).toBe(await realpath(projectDir));
    expect(await readFile(join(projectDir, "input/source.mp4"), "utf8"))
      .toBe("actual-video-bytes");
    expect(JSON.parse(await readFile(join(projectDir, "project.json"), "utf8")))
      .toMatchObject({
        jobId: "real-cloud-task",
        status: "cut_review_ready",
        config: { aspectRatio: "16:9" },
      });
  });

  it("fails closed and rolls project creation back when the id is already registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-cli-create-conflict-"));
    cleanupPaths.push(root);
    const requested = join(root, "requested", "same-id");
    const existing = join(root, "existing", "same-id");
    const projectsDir = join(root, "registry");
    await mkdir(join(requested, "incoming"), { recursive: true });
    await mkdir(join(requested, "cloud"), { recursive: true });
    await mkdir(existing, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
    await writeFile(join(requested, "incoming/talk.mp4"), "actual-video-bytes");
    await writeFile(join(requested, "cloud/words.json"), JSON.stringify({
      cues: [{ words: [{ id: "w-real", text: "真实", start: 0, end: 2 }] }],
    }));
    await writeFile(join(existing, "project.json"), JSON.stringify({
      jobId: "same-id",
      status: "cut_review_ready",
    }));
    await symlink(existing, join(projectsDir, "same-id"), "dir");
    const capture = captureIo();

    const code = await runCli([
      "project", "create", requested,
      "--video", "incoming/talk.mp4",
      "--transcript", "cloud/words.json",
      "--aspect-ratio", "4:3",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: capture.io });

    expect(code).toBe(5);
    expect(JSON.parse(capture.stdout[0])).toMatchObject({
      command: "project.create",
      ok: false,
      error: { code: "project_id_conflict" },
    });
    expect(await realpath(join(projectsDir, "same-id"))).toBe(await realpath(existing));
    for (const path of ["project.json", "input/source.mp4", "index.html", "edit-list.json"]) {
      await expect(readFile(join(requested, path), "utf8")).rejects.toThrow();
    }
    expect(await readFile(join(requested, "incoming/talk.mp4"), "utf8"))
      .toBe("actual-video-bytes");
  });

  it("prepares and registers a real task without demo media", async () => {
    const { projectDir, projectsDir } = await fixture();
    await rm(join(projectDir, "index.html"));
    const capture = captureIo();
    const code = await runCli([
      "project", "prepare", projectDir,
      "--duration", "3.5",
      "--force-index",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);
    const index = await readFile(join(projectDir, "index.html"), "utf8");

    expect(code, `${capture.stderr.join(" | ")} ${capture.stdout.join(" | ")}`).toBe(0);
    expect(payload).toMatchObject({
      product: "chengfeng-videocut",
      command: "project.prepare",
      data: {
        projectId: "demo",
        registered: true,
        indexWritten: true,
        metadata: { width: 1440, height: 1080, videoSource: "input/source.mp4" },
      },
    });
    expect(index).toContain("generated-by: chengfeng-videocut");
    expect(index).toContain("A-roll 口播（音画一体）");
    expect(index).toContain("data-edl-segment-id=");
    expect(index).toContain("<video");
    expect(index).not.toContain("<audio");
    expect(index).not.toContain("playsinline muted");
    expect(index).not.toContain("data-timeline-role=\"caption\"");
    expect(await readdir(projectsDir)).toEqual(["demo"]);
  });

  it("waits for the shared project mutation lock before preparing", async () => {
    const { projectDir, projectsDir } = await fixture();
    await rm(join(projectDir, "index.html"));
    let releaseHolder = (): void => undefined;
    let markHolderStarted = (): void => undefined;
    const holderStarted = new Promise<void>((resolveStarted) => {
      markHolderStarted = resolveStarted;
    });
    const holder = serializeProjectOperation(projectDir, async () => {
      markHolderStarted();
      await new Promise<void>((resolveHeld) => {
        releaseHolder = resolveHeld;
      });
    });
    await holderStarted;

    const capture = captureIo();
    let settled = false;
    const preparing = runCli([
      "project", "prepare", projectDir,
      "--duration", "3.5",
      "--force-index",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: capture.io }).then((code) => {
      settled = true;
      return code;
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(settled).toBe(false);

    releaseHolder();
    await holder;
    expect(
      await preparing,
      `${capture.stderr.join(" | ")} ${capture.stdout.join(" | ")}`,
    ).toBe(0);
  });

  it("opens by registering product metadata without changing project files", async () => {
    const { projectDir, projectsDir } = await fixture();
    const before = await readFile(join(projectDir, "project.json"), "utf8");
    const capture = captureIo();
    const code = await runCli(
      ["open", projectDir, "--projects-dir", projectsDir, "--json"],
      { io: capture.io },
    );
    const payload = JSON.parse(capture.stdout[0]);

    expect(code).toBe(0);
    expect(payload.data.url).toBe("http://localhost:5190/#project/demo");
    expect(payload.data.registered).toBe(true);
    expect(await readFile(join(projectDir, "project.json"), "utf8")).toBe(before);
  });

  it("publishes a controlled artifact through CLI revisions", async () => {
    const { root, projectDir } = await fixture();
    await writeFile(join(projectDir, "source_cut.mp4"), "cut-video");
    const project = JSON.parse(await readFile(join(projectDir, "project.json"), "utf8"));
    const projectRaw = `${JSON.stringify({
      ...project,
      status: "codex_continue_required",
      codexContinue: { required: true, stage: "subtitle_rebuild" },
    }, null, 2)}\n`;
    await writeFile(join(projectDir, "project.json"), projectRaw);
    const projectRevision = createHash("sha256").update(projectRaw).digest("hex");
    const source = join(root, "reviewed.srt");
    await writeFile(source, "1\n00:00:00,000 --> 00:00:01,000\n校对字幕\n");
    const capture = captureIo();

    const code = await runCli([
      "artifact", "put", projectDir,
      "--type", "subtitles",
      "--file", source,
      "--expected-project-revision", projectRevision,
      "--expected-artifact-revision", "none",
      "--json",
    ], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);

    expect(code).toBe(0);
    expect(payload).toMatchObject({
      command: "artifact.put",
      data: { type: "subtitles", status: "final_config_ready", changed: true },
    });
    expect(await readFile(join(projectDir, "subtitles.srt"), "utf8"))
      .toContain("校对字幕");
  });

  it("writes cuts through the Core and returns the new revision", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    await rm(join(projectDir, "index.html"));
    const prepareCapture = captureIo();
    expect(await runCli([
      "project", "prepare", projectDir,
      "--duration", "3.5",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: prepareCapture.io }), prepareCapture.stdout.join(" | ")).toBe(0);
    const initialCutsRaw = await readFile(join(projectDir, "cut-selection.json"), "utf8");
    const initialCutsRevision = createHash("sha256").update(initialCutsRaw).digest("hex");
    const initialCuts = JSON.parse(initialCutsRaw);
    const baselineCutWordIds = initialCuts.initialization.baselineCutWordIds as string[];
    const expectedCutWordCount = new Set([...baselineCutWordIds, "w-1"]).size;
    const staticDir = join(root, "static");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
    const server = await startStudioServer({
      port: 0,
      projectsDir,
      dataDir: join(root, "data"),
      staticDir,
    });
    const proposal = join(root, "proposal.json");
    await writeFile(proposal, JSON.stringify({ cutWordIds: ["w-1"] }));
    const capture = captureIo();
    const code = await runCli([
      "cuts",
      "set",
      projectDir,
      "--file",
      proposal,
      "--expected-revision",
      initialCutsRevision,
      "--projects-dir",
      projectsDir,
      "--api-base",
      server.url,
      "--json",
    ], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);
    expect(code, `${capture.stderr.join(" | ")} ${capture.stdout.join(" | ")}`).toBe(0);
    const written = JSON.parse(await readFile(join(projectDir, "cut-selection.json"), "utf8"));

    expect(payload.data).toMatchObject({
      cutWordCount: expectedCutWordCount,
      cutRangeCount: 1,
      changed: true,
    });
    expect(payload.data.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(written.cutWordIds).toEqual(expect.arrayContaining(["w-1", ...baselineCutWordIds]));
    expect(written.initialization.baselineCutWordIds).toEqual(baselineCutWordIds);

    const readCapture = captureIo();
    const readCode = await runCli([
      "cuts", "get", projectDir,
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: readCapture.io });
    await server.stop();
    const readPayload = JSON.parse(readCapture.stdout[0]);
    expect(readCode, `${readCapture.stderr.join(" | ")} ${readCapture.stdout.join(" | ")}`).toBe(0);
    expect(readPayload).toMatchObject({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      command: "cuts.get",
      ok: true,
      data: {
        projectId: "demo",
        exists: true,
        revision: payload.data.revision,
        cutWordCount: expectedCutWordCount,
        cutRangeCount: 1,
        document: {
          schemaVersion: 3,
          cutWordIds: written.cutWordIds,
          cutRanges: written.cutRanges,
        },
      },
    });
  });

  it("edits the timeline segment by segment through the same guarded resource", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    await rm(join(projectDir, "index.html"));
    const prepareCapture = captureIo();
    expect(await runCli([
      "project", "prepare", projectDir,
      "--duration", "3.5",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: prepareCapture.io }), prepareCapture.stdout.join(" | ")).toBe(0);
    const staticDir = join(root, "static");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
    const server = await startStudioServer({
      port: 0,
      projectsDir,
      dataDir: join(root, "data"),
      staticDir,
    });

    const readCapture = captureIo();
    const readCode = await runCli([
      "edit-list", "get", projectDir,
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: readCapture.io });
    expect(readCode, `${readCapture.stderr.join(" | ")}`).toBe(0);
    const read = JSON.parse(readCapture.stdout[0]);
    expect(read).toMatchObject({ ok: true, command: "editList.get" });
    const before = read.data.document.segments as { source: string }[];
    expect(before.length).toBeGreaterThan(0);
    const revision = read.data.revision as string;

    // Trim the tail of the timeline through the same PATCH the editor uses, so
    // the write passes the identical geometry checks, CAS and project lock.
    const last = before[before.length - 1] as unknown as {
      source: string;
      sourceStart: number;
      sourceEnd: number;
    };
    const operation = join(root, "operation.json");
    await writeFile(operation, JSON.stringify({
      type: "delete-range",
      source: last.source,
      sourceStart: (last.sourceStart + last.sourceEnd) / 2,
      sourceEnd: last.sourceEnd,
    }));

    const patchCapture = captureIo();
    const patchCode = await runCli([
      "edit-list", "patch", projectDir,
      "--file", operation,
      "--expected-revision", revision,
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: patchCapture.io });
    expect(patchCode, `${patchCapture.stderr.join(" | ")}`).toBe(0);
    const patched = JSON.parse(patchCapture.stdout[0]);
    expect(patched).toMatchObject({
      ok: true,
      command: "editList.patch",
      data: { projectId: "demo", changed: true, previousRevision: revision },
    });
    expect(patched.data.revision).not.toBe(revision);
    expect(patched.data.duration).toBeLessThan(read.data.duration);

    // Replaying the same operation against the now-stale revision must be
    // refused rather than silently applied twice.
    const staleCapture = captureIo();
    const staleCode = await runCli([
      "edit-list", "patch", projectDir,
      "--file", operation,
      "--expected-revision", revision,
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: staleCapture.io });
    await server.stop();
    expect(staleCode).not.toBe(0);
    expect(JSON.parse(staleCapture.stdout[0])).toMatchObject({
      ok: false,
      error: { code: "revision_conflict" },
    });

    const onDisk = JSON.parse(await readFile(join(projectDir, "edit-list.json"), "utf8"));
    expect(createHash("sha256").update(JSON.stringify(onDisk)).digest("hex")).toBeTruthy();
    expect(onDisk.duration).toBe(patched.data.duration);
  });

  it("reads and transitions workflow through the running product API", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    const prepareCapture = captureIo();
    expect(await runCli([
      "project", "prepare", projectDir,
      "--duration", "3.5",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: prepareCapture.io }), prepareCapture.stdout.join(" | ")).toBe(0);

    const editListRaw = await readFile(join(projectDir, "edit-list.json"), "utf8");
    const editListRevision = createHash("sha256").update(editListRaw).digest("hex");
    const cutVideo = "cut-video";
    await mkdir(join(projectDir, "剪口播/3_审核"), { recursive: true });
    await writeFile(join(projectDir, "剪口播/3_审核/source_cut.mp4"), cutVideo);
    await writeFile(join(projectDir, "subtitles.srt"), "1\n00:00:00,000 --> 00:00:01,000\n字幕\n");
    const project = JSON.parse(await readFile(join(projectDir, "project.json"), "utf8"));
    await writeFile(join(projectDir, "剪口播/3_审核/cut_done.json"), `${JSON.stringify({
      schemaVersion: 1,
      success: true,
      source: "chengfeng-videocut",
      artifactRevision: editListRevision,
      confirmedEditListRevision: editListRevision,
      editListRevision,
      sourceSha256: project.source.sha256,
      outputRelative: "剪口播/3_审核/source_cut.mp4",
      outputSha256: createHash("sha256").update(cutVideo).digest("hex"),
      newDuration: 3.5,
      expectedDuration: 3.5,
      durationDeltaSeconds: 0,
      durationToleranceSeconds: 0.15,
      hasAudio: true,
      width: 1440,
      height: 1080,
    }, null, 2)}\n`);
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({
      ...project,
      status: "final_config_ready",
      artifacts: {
        ...project.artifacts,
        sourceCut: "剪口播/3_审核/source_cut.mp4",
        cutDone: "剪口播/3_审核/cut_done.json",
        subtitles: "subtitles.srt",
      },
    }, null, 2)}\n`);
    const staticDir = join(root, "static-workflow");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
    const server = await startStudioServer({
      port: 0,
      projectsDir,
      dataDir: join(root, "data-workflow"),
      staticDir,
    });
    const getCapture = captureIo();
    expect(await runCli([
      "workflow", "get", projectDir,
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: getCapture.io })).toBe(0);
    const workflow = JSON.parse(getCapture.stdout[0]);
    expect(workflow.data.editListRevision).toBe(editListRevision);
    expect(workflow.data.revision).not.toBe(editListRevision);
    const config = join(root, "final-config.json");
    await writeFile(config, JSON.stringify({
      aspectRatio: "4:3",
      animationStyle: "xiaohei",
      requirements: "真实素材优先",
    }));
    const transitionCapture = captureIo();
    const code = await runCli([
      "workflow", "transition", projectDir,
      "--action", "start-final",
      "--expected-revision", workflow.data.revision,
      "--confirmed",
      "--file", config,
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: transitionCapture.io });
    await server.stop();

    expect(
      code,
      `${transitionCapture.stderr.join(" | ")} ${transitionCapture.stdout.join(" | ")}`,
    ).toBe(0);
    expect(JSON.parse(transitionCapture.stdout[0])).toMatchObject({
      command: "workflow.transition",
      data: {
        action: "start-final",
        project: { status: "codex_continue_required", codexContinue: { stage: "storyboard" } },
      },
    });
  });

  it("passes the confirmed EDL revision unchanged instead of substituting the latest value", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    const prepareCapture = captureIo();
    expect(await runCli([
      "project", "prepare", projectDir,
      "--duration", "3.5",
      "--projects-dir", projectsDir,
      "--json",
    ], { io: prepareCapture.io }), prepareCapture.stdout.join(" | ")).toBe(0);
    const staticDir = join(root, "static-confirmed-edl");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
    const server = await startStudioServer({
      port: 0,
      projectsDir,
      dataDir: join(root, "data-confirmed-edl"),
      staticDir,
    });
    const projectRaw = await readFile(join(projectDir, "project.json"), "utf8");
    const projectRevision = createHash("sha256").update(projectRaw).digest("hex");
    const editListRaw = await readFile(join(projectDir, "edit-list.json"), "utf8");
    const currentEditListRevision = createHash("sha256").update(editListRaw).digest("hex");
    const confirmedEditListRevision = "f".repeat(64);
    const capture = captureIo();

    const code = await runCli([
      "cuts", "apply", projectDir,
      "--expected-revision", projectRevision,
      "--expected-edit-list-revision", confirmedEditListRevision,
      "--confirmed",
      "--projects-dir", projectsDir,
      "--api-base", server.url,
      "--json",
    ], { io: capture.io });
    await server.stop();

    expect(code, `${capture.stderr.join(" | ")} ${capture.stdout.join(" | ")}`).toBe(5);
    expect(JSON.parse(capture.stdout[0])).toMatchObject({
      command: "cuts.apply",
      ok: false,
      error: {
        code: "revision_conflict",
        details: {
          reason: "edit_list_changed_after_confirmation",
          expectedEditListRevision: confirmedEditListRevision,
          currentEditListRevision,
        },
      },
    });
    expect(JSON.parse(await readFile(join(projectDir, "project.json"), "utf8")))
      .toMatchObject({ status: "cut_review_ready" });
  });

  it("runs the verified renderer directly for a registered project id", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    const projectRaw = await readFile(join(projectDir, "project.json"), "utf8");
    const expectedRevision = createHash("sha256").update(projectRaw).digest("hex");
    const renderer = join(root, "export_final_video.cjs");
    await writeFile(renderer, "#!/usr/bin/env node\n");
    const calls: Array<{ directory: string; options: unknown }> = [];
    const finalRevision = "d".repeat(64);
    const capture = captureIo();

    const code = await runCli([
      "render", "run", "demo",
      "--expected-revision", expectedRevision,
      "--confirmed",
      "--renderer", renderer,
      "--projects-dir", projectsDir,
      "--json",
    ], {
      io: capture.io,
      runRender: async (directory, options) => {
        calls.push({ directory, options });
        return {
          directory,
          status: "done",
          previousRevision: expectedRevision,
          revision: finalRevision,
          finalVideoPath: join(directory, "renders/final.mp4"),
          verificationPath: join(directory, "renders/verification.json"),
          verification: {
            passed: true,
            aspectRatio: "4:3",
            frames: {
              global: [{}, {}, {}],
              htmlScenes: [{}, {}],
              unique: [{}, {}, {}, {}],
            },
          },
        };
      },
    });
    const payload = JSON.parse(capture.stdout[0]);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      options: {
        confirmed: true,
        expectedRevision,
        rendererPath: renderer,
      },
    });
    expect(calls[0].directory).toEndWith("/demo");
    expect(payload).toMatchObject({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      command: "render.run",
      ok: true,
      data: {
        projectId: "demo",
        status: "done",
        previousRevision: expectedRevision,
        revision: finalRevision,
        verification: {
          passed: true,
          aspectRatio: "4:3",
          globalFrameCount: 3,
          htmlSceneCount: 2,
          uniqueFrameCount: 4,
        },
      },
    });
  });

  it("uses stable render-specific exit codes and JSON errors", async () => {
    const { projectDir } = await fixture();
    const revision = "e".repeat(64);
    const cases = [
      { errorCode: "missing_renderer", exitCode: 7 },
      { errorCode: "render_failed", exitCode: 8 },
      { errorCode: "verification_failed", exitCode: 9 },
    ];

    for (const scenario of cases) {
      const capture = captureIo();
      const code = await runCli([
        "render", "run", projectDir,
        "--expected-revision", revision,
        "--confirmed",
        "--json",
      ], {
        io: capture.io,
        runRender: async () => {
          throw Object.assign(new Error(`${scenario.errorCode} fixture`), {
            code: scenario.errorCode,
            details: { stable: true },
          });
        },
      });
      expect(code).toBe(scenario.exitCode);
      expect(JSON.parse(capture.stdout[0])).toMatchObject({
        product: "chengfeng-videocut",
        command: "render.run",
        ok: false,
        error: {
          code: scenario.errorCode,
          details: { stable: true },
        },
      });
    }
  });

  it("returns a stable error and leaves the file absent for invalid ids", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    const proposal = join(root, "proposal.json");
    await writeFile(proposal, JSON.stringify({ cutWordIds: ["missing"] }));
    const capture = captureIo();
    const code = await runCli(
      [
        "cuts",
        "set",
        projectDir,
        "--file",
        proposal,
        "--projects-dir",
        projectsDir,
        "--dry-run",
        "--json",
      ],
      { io: capture.io },
    );
    const payload = JSON.parse(capture.stdout[0]);

    expect(code).toBe(4);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      command: "cuts.set",
      ok: false,
      error: { code: "invalid_cut_selection" },
    });
    await expect(readFile(join(projectDir, "cut-selection.json"), "utf8")).rejects.toThrow();
  });

  it("validates an open URL before creating a registry link", async () => {
    const { projectDir, projectsDir } = await fixture();
    const capture = captureIo();
    const code = await runCli(
      [
        "open",
        projectDir,
        "--origin",
        "not-a-url",
        "--projects-dir",
        projectsDir,
        "--json",
      ],
      { io: capture.io },
    );

    expect(code).toBe(2);
    expect(JSON.parse(capture.stdout[0]).error.code).toBe("invalid_argument");
    expect(await readdir(projectsDir)).toEqual([]);
  });

  it("starts without opening a browser unless --open is explicit", async () => {
    const capture = captureIo();
    const started: unknown[] = [];
    const opened: string[] = [];
    const fakeServer = {
      host: "127.0.0.1",
      port: 43123,
      url: "http://127.0.0.1:43123",
      projectsDir: "/tmp/projects",
      dataDir: "/tmp/data",
      events: {} as never,
      stop: async () => undefined,
    };
    const startServer = async (options: unknown) => {
      started.push(options);
      return fakeServer;
    };
    const openBrowser = async (url: string) => {
      opened.push(url);
    };

    expect(
      await runCli(["start", "--port", "0", "--json"], {
        io: capture.io,
        startServer,
        openBrowser,
      }),
    ).toBe(0);
    expect(opened).toEqual([]);
    expect(started[0]).toMatchObject({ port: 0, installSignalHandlers: true });
    expect(JSON.parse(capture.stdout[0])).toMatchObject({
      product: "chengfeng-videocut",
      command: "start",
      data: { brand: "chengfeng-videocut", port: 43123 },
    });

    expect(
      await runCli(["start", "--open"], {
        io: capture.io,
        startServer,
        openBrowser,
      }),
    ).toBe(0);
    expect(opened).toEqual([fakeServer.url]);
  });

  it("routes service ensure through the managed lifecycle and opens only after ready", async () => {
    const capture = captureIo();
    const calls: Array<{ action: string; lines?: number }> = [];
    const opened: string[] = [];
    const code = await runCli(["service", "ensure", "--open", "--json"], {
      io: capture.io,
      runServiceCommand: async (action, options) => {
        calls.push({ action, lines: options?.lines });
        return {
          action,
          changed: false,
          serviceApiVersion: 1,
          label: "com.chengfeng.videocut.studio",
          state: "running",
          installed: true,
          configured: true,
          loaded: true,
          ready: true,
          healthy: true,
          pid: 4321,
          runtimeMode: "launchd",
          productVersion: "0.2.0",
          studioBuildId: "test-build",
          url: "http://127.0.0.1:5190",
          identity: {
            product: "chengfeng-videocut",
            productVersion: "0.2.0",
            pid: 4321,
            runtimeMode: "launchd",
            studioBuildId: "test-build",
          },
          paths: {
            homeDir: "/tmp/home",
            dataDir: "/tmp/home/.chengfeng-videocut",
            launcherPath: "/tmp/home/.chengfeng-videocut/bin/chengfeng-videocut",
            plistPath: "/tmp/home/Library/LaunchAgents/com.chengfeng.videocut.studio.plist",
            stdoutLogPath: "/tmp/home/.chengfeng-videocut/logs/studio.stdout.log",
            stderrLogPath: "/tmp/home/.chengfeng-videocut/logs/studio.stderr.log",
            operationLockPath: "/tmp/home/.chengfeng-videocut/service-operation.lock",
          },
        };
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ action: "ensure", lines: undefined }]);
    expect(opened).toEqual(["http://127.0.0.1:5190"]);
    expect(JSON.parse(capture.stdout[0])).toMatchObject({
      command: "service.ensure",
      ok: true,
      data: {
        ready: true,
        healthy: true,
        pid: 4321,
        runtimeMode: "launchd",
        productVersion: "0.2.0",
      },
    });
  });

  it("reports a stable service_unavailable error instead of writing locally", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    const proposal = join(root, "proposal.json");
    await writeFile(proposal, JSON.stringify({ cutWordIds: ["w-1"] }));
    const capture = captureIo();
    const code = await runCli([
      "cuts",
      "set",
      projectDir,
      "--file",
      proposal,
      "--expected-revision",
      "none",
      "--projects-dir",
      projectsDir,
      "--api-base",
      "http://127.0.0.1:1",
      "--json",
    ], { io: capture.io });

    expect(code).toBe(6);
    expect(JSON.parse(capture.stdout[0]).error.code).toBe("service_unavailable");
    await expect(readFile(join(projectDir, "cut-selection.json"), "utf8")).rejects.toThrow();

    const readCapture = captureIo();
    const readCode = await runCli([
      "cuts", "get", projectDir,
      "--projects-dir", projectsDir,
      "--api-base", "http://127.0.0.1:1",
      "--json",
    ], { io: readCapture.io });
    expect(readCode).toBe(6);
    expect(JSON.parse(readCapture.stdout[0])).toMatchObject({
      command: "cuts.get",
      ok: false,
      error: { code: "service_unavailable" },
    });
    await expect(readFile(join(projectDir, "cut-selection.json"), "utf8")).rejects.toThrow();
  });
  it("transcribes the cut itself instead of demanding an export first", async () => {
    const { projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    await writeFile(join(projectDir, "edit-list.json"), JSON.stringify({
      schemaVersion: 1, projectId: "demo", sourceDuration: 10, mode: "magnetic", duration: 3,
      segments: [
        { id: "a", source: "input/source.mp4", sourceStart: 2, sourceEnd: 3, timelineStart: 0, trackId: "a-roll", playbackRate: 1 },
        { id: "b", source: "input/source.mp4", sourceStart: 6, sourceEnd: 8, timelineStart: 1, trackId: "a-roll", playbackRate: 1 },
      ],
    }));
    const capture = captureIo();
    let seen: { source: string; ranges: readonly { start: number; end: number }[] } | null = null;
    const code = await runCli(
      [
        "transcript", "retranscribe", "demo",
        "--output", join(projectDir, "cut.json"),
        "--projects-dir", projectsDir, "--json",
      ],
      {
        io: capture.io,
        // Subtitles need word times on the *cut* timeline. Sending only the kept
        // ranges' audio makes those times right by construction — there is no
        // mapping between timelines afterwards, and that mapping is the step that
        // keeps being got wrong.
        runCutTranscription: async (options) => {
          seen = { source: options.source, ranges: options.ranges };
          return {
            provider: "volcengine", source: options.source, output: options.output,
            cueCount: 1, wordCount: 3,
            duration: options.ranges.reduce((total, range) => total + (range.end - range.start), 0),
          };
        },
      },
    );

    expect(code, capture.stderr.join(" | ")).toBe(0);
    expect(seen).not.toBeNull();
    // Exactly the kept ranges, in the order they are heard — not the whole source.
    expect(seen!.ranges).toEqual([{ start: 2, end: 3 }, { start: 6, end: 8 }]);
    expect(seen!.source.endsWith("input/source.mp4")).toBe(true);
    const payload = JSON.parse(capture.stdout.join("")) as { data: { duration: number; keptRanges: number } };
    expect(payload.data.keptRanges).toBe(2);
    expect(payload.data.duration).toBe(3);
  });

});
