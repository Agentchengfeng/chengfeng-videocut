import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  runKouboRender,
  verifyKouboFinal,
  type KouboFrameExtraction,
  type KouboRenderDependencies,
  type KouboRendererInvocation,
  type KouboRenderProbe,
} from "./render";
import { readKouboWorkflow } from "./workflow";

const cleanup: string[] = [];
const fixedNow = () => new Date("2026-07-16T02:03:04.000Z");

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FixtureOptions {
  status?: string;
  failedAt?: string;
  aspectRatio?: "3:4" | "16:9" | "4:3";
  player?: string;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-render-"));
  cleanup.push(root);
  const job = join(root, "render-job");
  await mkdir(join(job, "剪口播/3_审核"), { recursive: true });
  await mkdir(join(job, "成片配置"), { recursive: true });
  await mkdir(join(job, "动画"), { recursive: true });
  await writeFile(join(job, "剪口播/3_审核/source_cut.mp4"), "source-video-with-audio");
  await writeFile(
    join(job, "subtitles.srt"),
    "1\n00:00:00,000 --> 00:00:10,000\n测试字幕\n",
  );
  await writeFile(join(job, "成片配置/config.json"), `${JSON.stringify({
    aspectRatio: options.aspectRatio ?? "4:3",
    animationStyle: "xiaohei",
    requirements: "",
  }, null, 2)}\n`);
  await writeFile(join(job, "timeline.json"), `${JSON.stringify({
    schemaVersion: 1,
    totalDuration: 10,
    scenes: [
      { id: "scene-video-a", kind: "video", src: "剪口播/3_审核/source_cut.mp4", start: 0, end: 2 },
      { id: "scene-html-a", kind: "html", src: "动画/module-a.html", start: 2, end: 4 },
      { id: "scene-html-b", kind: "html", src: "动画/module-b.html", start: 4, end: 6 },
      { id: "scene-video-b", kind: "video", src: "剪口播/3_审核/source_cut.mp4", start: 6, end: 10 },
    ],
  }, null, 2)}\n`);
  await writeFile(join(job, "动画/manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    modules: [
      { id: "module-a", src: "动画/module-a.html" },
      { id: "module-b", src: "动画/module-b.html" },
    ],
  }, null, 2)}\n`);
  await writeFile(
    join(job, "final-player.html"),
    options.player ?? "<!doctype html><script>const finalCaptions=[{\"id\":\"1\",\"start\":0,\"end\":10,\"text\":\"测试字幕\"}];window.finalCaptions=finalCaptions;window.finalVideo={totalDuration:10};window.seekTo=async()=>{};</script>",
  );
  const status = options.status ?? "codex_continue_required";
  await writeFile(join(job, "project.json"), `${JSON.stringify({
    jobId: "render-job",
    status,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    artifacts: {
      sourceCut: "剪口播/3_审核/source_cut.mp4",
      subtitles: "subtitles.srt",
      finalConfig: "成片配置/config.json",
      timeline: "timeline.json",
      animationManifest: "动画/manifest.json",
      finalPlayer: "final-player.html",
    },
    config: {
      aspectRatio: options.aspectRatio ?? "4:3",
      animationStyle: "xiaohei",
      requirements: "",
    },
    codexContinue: status === "codex_continue_required"
      ? { required: true, stage: "render", prompt: "继续 render-job", reason: "导出" }
      : { required: false, stage: "", prompt: "", reason: "" },
    ...(options.failedAt ? {
      failedAt: options.failedAt,
      error: "previous render failure",
      recoverable: true,
    } : {}),
  }, null, 2)}\n`);
  return job;
}

function probe(overrides: Partial<KouboRenderProbe> = {}): KouboRenderProbe {
  return {
    duration: 10,
    hasVideo: true,
    hasAudio: true,
    width: 1440,
    height: 1080,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    ...overrides,
  };
}

function dependencies(input: {
  finalProbe?: Partial<KouboRenderProbe>;
  sourceProbe?: Partial<KouboRenderProbe>;
  runner?: (invocation: KouboRendererInvocation) => Promise<void>;
  onFrame?: (frame: KouboFrameExtraction) => void;
} = {}): KouboRenderDependencies {
  return {
    runner: input.runner ?? (async (invocation) => {
      await mkdir(dirname(invocation.outputPath), { recursive: true });
      await writeFile(invocation.outputPath, "rendered-final-video");
    }),
    probe: async (path) => basename(path) === "final.mp4"
      ? probe(input.finalProbe)
      : probe({ width: 1920, height: 1080, ...input.sourceProbe }),
    frameExtractor: async (frame) => {
      input.onFrame?.(frame);
      await mkdir(dirname(frame.outputPath), { recursive: true });
      await writeFile(frame.outputPath, `png-at-${frame.time.toFixed(3)}`);
    },
  };
}

async function treeSnapshot(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const key = relative(root, path).split("/").join("/");
      if (entry.isDirectory()) {
        output.push(`d:${key}`);
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        output.push(`l:${key}:${await readlink(path)}`);
      } else {
        const bytes = await readFile(path);
        output.push(
          `f:${key}:${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`,
        );
      }
    }
  }
  await visit(root);
  return output;
}

async function eventTypes(job: string): Promise<string[]> {
  const content = await readFile(join(job, "events.jsonl"), "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line).type as string);
}

describe("Koubo render and verification gate", () => {
  it("has zero side effects when rendering is not explicitly confirmed", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let runnerCalls = 0;

    await expect(runKouboRender(job, {
      confirmed: false,
      expectedRevision: snapshot.revision,
      dependencies: {
        runner: async () => { runnerCalls += 1; },
      },
    })).rejects.toMatchObject({ code: "confirmation_required" });

    expect(runnerCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("rejects a stale revision before invoking the renderer or writing state", async () => {
    const job = await fixture();
    const before = await treeSnapshot(job);
    let runnerCalls = 0;

    await expect(runKouboRender(job, {
      confirmed: true,
      expectedRevision: "0".repeat(64),
      dependencies: {
        runner: async () => { runnerCalls += 1; },
      },
    })).rejects.toMatchObject({ code: "revision_conflict" });

    expect(runnerCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("spawns the fixed high-quality contract and reaches done only after frame evidence", async () => {
    const job = await fixture({ aspectRatio: "4:3" });
    const snapshot = await readKouboWorkflow(job);
    const invocations: KouboRendererInvocation[] = [];
    const frameTimes: number[] = [];
    const deps = dependencies({
      runner: async (value) => {
        invocations.push(value);
        await mkdir(dirname(value.outputPath), { recursive: true });
        await writeFile(value.outputPath, "rendered-final-video");
      },
      sourceProbe: { duration: 10.05 },
      onFrame: (frame) => frameTimes.push(frame.time),
    });

    const result = await runKouboRender(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      now: fixedNow,
      dependencies: deps,
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0].args).toEqual([
      "--project-dir", result.directory,
      "--input-video", join(result.directory, "剪口播/3_审核/source_cut.mp4"),
      "--config", join(result.directory, "成片配置/config.json"),
      "--player", "final-player.html",
      "--output", "renders/final.mp4",
      "--frame-format", "png",
      "--fps", "30",
      "--crf", "14",
      "--preset", "slow",
    ]);
    expect(result.status).toBe("done");
    expect(result.project.artifacts).toMatchObject({
      finalVideo: "renders/final.mp4",
      verification: "renders/verification.json",
    });
    expect(result.verification).toMatchObject({
      passed: true,
      aspectRatio: "4:3",
      expected: { width: 1440, height: 1080, fps: 30, maxDurationDelta: 0.1 },
      checks: {
        hasVideo: true,
        hasAudio: true,
        fps: true,
        dimensions: true,
        duration: true,
        finalPlayerCaptions: true,
      },
    });
    expect(result.verification.frames.global).toHaveLength(3);
    expect(result.verification.frames.htmlScenes).toHaveLength(2);
    // scene-html-b at 5s reuses the 50% global frame.
    expect(result.verification.frames.unique).toHaveLength(4);
    expect(frameTimes).toHaveLength(4);
    for (const frame of result.verification.frames.unique) {
      expect((await readFile(join(job, frame.path))).byteLength).toBeGreaterThan(0);
    }
    expect(JSON.parse(await readFile(join(job, "renders/verification.json"), "utf8"))).toEqual(
      result.verification,
    );
    expect(await eventTypes(job)).toEqual([
      "status_changed",
      "status_changed",
      "verification_completed",
      "render_done",
      "status_changed",
    ]);
  });

  const verificationFailures: Array<{
    name: string;
    finalProbe: Partial<KouboRenderProbe>;
    message: string;
  }> = [
    {
      name: "missing audio",
      finalProbe: { hasAudio: false },
      message: "no audio stream",
    },
    {
      name: "wrong ratio dimensions",
      finalProbe: { width: 1620, height: 2160 },
      message: "expected 1440x1080",
    },
    {
      name: "duration drift above 0.10 seconds",
      finalProbe: { duration: 10.2 },
      message: "maximum is 0.10s",
    },
  ];

  for (const failure of verificationFailures) {
    it(`fails in verifying for ${failure.name} and records a failed report`, async () => {
      const job = await fixture({ aspectRatio: "4:3" });
      const snapshot = await readKouboWorkflow(job);
      let frameCalls = 0;

      await expect(runKouboRender(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        now: fixedNow,
        dependencies: dependencies({
          finalProbe: failure.finalProbe,
          onFrame: () => { frameCalls += 1; },
        }),
      })).rejects.toMatchObject({ code: "verification_failed" });

      const failed = await readKouboWorkflow(job);
      expect(failed.project).toMatchObject({
        status: "failed",
        failedAt: "verifying",
        recoverable: true,
      });
      expect(String(failed.project.error)).toContain(failure.message);
      const report = JSON.parse(await readFile(join(job, "renders/verification.json"), "utf8"));
      expect(report.passed).toBe(false);
      expect(report.errors.join(" ")).toContain(failure.message);
      expect(failed.project.artifacts).not.toHaveProperty("finalVideo");
      expect(frameCalls).toBe(0);
    });
  }

  it("rejects a final player that omits the canonical subtitle payload", async () => {
    const job = await fixture({
      player: "<!doctype html><script>window.finalVideo={totalDuration:10};window.seekTo=async()=>{};</script>",
    });
    const snapshot = await readKouboWorkflow(job);

    await expect(runKouboRender(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      now: fixedNow,
      dependencies: dependencies(),
    })).rejects.toMatchObject({ code: "verification_failed" });

    const failed = await readKouboWorkflow(job);
    expect(failed.project).toMatchObject({
      status: "failed",
      failedAt: "verifying",
      recoverable: true,
    });
    expect(String(failed.project.error)).toContain("canonical subtitles.srt cues");
  });

  it("marks renderer process failures at rendering", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);

    await expect(runKouboRender(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      now: fixedNow,
      dependencies: dependencies({
        runner: async () => { throw new Error("fixture renderer crashed"); },
      }),
    })).rejects.toMatchObject({ code: "render_failed" });

    const failed = await readKouboWorkflow(job);
    expect(failed.project).toMatchObject({
      status: "failed",
      failedAt: "rendering",
      error: "fixture renderer crashed",
      recoverable: true,
    });
  });

  it("recovers a failed-at-rendering project through the same verified gate", async () => {
    const job = await fixture({ status: "failed", failedAt: "rendering" });
    const snapshot = await readKouboWorkflow(job);
    const result = await runKouboRender(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      now: fixedNow,
      dependencies: dependencies(),
    });

    expect(result.status).toBe("done");
    expect(result.project.failedAt).toBeNull();
    expect(result.project.recoverable).toBeNull();
  });

  it("does not admit failed-at-verifying through the renderer recovery edge", async () => {
    const job = await fixture({ status: "failed", failedAt: "verifying" });
    const snapshot = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);

    await expect(runKouboRender(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      dependencies: dependencies(),
    })).rejects.toMatchObject({ code: "invalid_state" });

    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("serializes concurrent render attempts so one revision renders once", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);
    let runnerCalls = 0;
    const deps = dependencies({
      runner: async (invocation) => {
        runnerCalls += 1;
        await mkdir(dirname(invocation.outputPath), { recursive: true });
        await writeFile(invocation.outputPath, "rendered-final-video");
      },
    });
    const results = await Promise.allSettled([
      runKouboRender(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        dependencies: deps,
      }),
      runKouboRender(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        dependencies: deps,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "revision_conflict" });
    }
    expect(runnerCalls).toBe(1);
  });

  it("exports verifyKouboFinal as a standalone evidence writer", async () => {
    const job = await fixture({ status: "verifying" });
    await mkdir(join(job, "renders"), { recursive: true });
    await writeFile(join(job, "renders/final.mp4"), "already-rendered-final");
    const result = await verifyKouboFinal(job, {
      now: fixedNow,
      dependencies: dependencies(),
    });

    expect(result.report.passed).toBe(true);
    expect(result.report.frames.global).toHaveLength(3);
    expect(await readFile(result.verificationPath, "utf8")).toContain('"passed": true');
    expect((await readKouboWorkflow(job)).status).toBe("verifying");
  });
});
