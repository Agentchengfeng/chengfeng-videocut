import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    expect(code).toBe(0);
    expect(payload).toMatchObject({
      product: "chengfeng-VideoCut",
      command: "help",
      ok: true,
    });
    expect(payload.data.text).toContain(
      "chengfeng-videocut render run <project> --expected-revision <sha256> --confirmed",
    );
    expect(payload.data.text).toContain("CHENGFENG_VIDEOCUT_RENDERER_PATH");
    expect(payload.data.text).toContain(
      "Render exit codes: 7 missing renderer, 8 renderer failed, 9 verification failed.",
    );
  });

  it("returns a stable inspect JSON envelope", async () => {
    const { projectDir } = await fixture();
    const capture = captureIo();
    const code = await runCli(["inspect", projectDir, "--json"], { io: capture.io });
    const payload = JSON.parse(capture.stdout[0]);

    expect(code).toBe(0);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      product: "chengfeng-VideoCut",
      command: "inspect",
      ok: true,
      data: { projectId: "demo", status: "cut_review_ready" },
    });
  });

  it("prepares and registers a real task without demo media", async () => {
    const { projectDir, projectsDir } = await fixture();
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

    expect(code).toBe(0);
    expect(payload).toMatchObject({
      product: "chengfeng-VideoCut",
      command: "project.prepare",
      data: {
        projectId: "demo",
        registered: true,
        indexWritten: true,
        metadata: { width: 1440, height: 1080, videoSource: "input/source.mp4" },
      },
    });
    expect(index).toContain("generated-by: chengfeng-videocut");
    expect(index).toContain("A-roll 口播原片（音画一体）");
    expect(index).toContain("<video");
    expect(index).not.toContain("<audio");
    expect(index).not.toContain("playsinline muted");
    expect(index).not.toContain("data-timeline-role=\"caption\"");
    expect(await readdir(projectsDir)).toEqual(["demo"]);
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
    await writeFile(proposal, JSON.stringify({ cutWordIds: ["w-1", "w-2"] }));
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
      server.url,
      "--json",
    ], { io: capture.io });
    await server.stop();
    const payload = JSON.parse(capture.stdout[0]);
    const written = JSON.parse(await readFile(join(projectDir, "cut-selection.json"), "utf8"));

    expect(code).toBe(0);
    expect(payload.data).toMatchObject({ cutWordCount: 2, cutRangeCount: 1, changed: true });
    expect(payload.data.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(written.cutRanges).toEqual([{ start: 0, end: 2 }]);
  });

  it("reads and transitions workflow through the running product API", async () => {
    const { root, projectDir, projectsDir } = await fixture();
    await registerFixture(projectDir, projectsDir);
    await mkdir(join(projectDir, "剪口播/3_审核"), { recursive: true });
    await writeFile(join(projectDir, "剪口播/3_审核/source_cut.mp4"), "cut-video");
    await writeFile(join(projectDir, "subtitles.srt"), "1\n00:00:00,000 --> 00:00:01,000\n字幕\n");
    const project = JSON.parse(await readFile(join(projectDir, "project.json"), "utf8"));
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({
      ...project,
      status: "final_config_ready",
      artifacts: {
        sourceCut: "剪口播/3_审核/source_cut.mp4",
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
      product: "chengfeng-VideoCut",
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
        product: "chengfeng-VideoCut",
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
      product: "chengfeng-VideoCut",
      command: "start",
      data: { brand: "chengfeng-VideoCut", port: 43123 },
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
  });
});
