import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { MediaCutResult, MediaProbe } from "./mediaCut";
import {
  applyKouboCut,
  readKouboWorkflow,
  transitionKouboWorkflow,
  type KouboMediaCutterInput,
  type KouboWorkflowAction,
} from "./workflow";

const cleanup: string[] = [];
const fixedNow = () => new Date("2026-07-16T01:02:03.000Z");

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FixtureOptions {
  status?: string;
  failedAt?: string;
  artifacts?: Record<string, string>;
  config?: Record<string, unknown>;
  cutRanges?: Array<{ start: number; end: number }>;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-workflow-"));
  cleanup.push(root);
  const job = join(root, "fixture-job");
  await mkdir(join(job, "input"), { recursive: true });
  await writeFile(join(job, "input/source.mp4"), "fixture-source");
  await writeFile(join(job, "cut-selection.json"), `${JSON.stringify({
    schemaVersion: 3,
    cutWordIds: [],
    cutRanges: options.cutRanges ?? [{ start: 1, end: 2.5 }],
  }, null, 2)}\n`);
  await writeFile(join(job, "project.json"), `${JSON.stringify({
    jobId: "fixture-job",
    status: options.status ?? "cut_review_ready",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    inputVideo: "input/source.mp4",
    artifacts: {
      workbenchCutSelection: "cut-selection.json",
      ...(options.artifacts ?? {}),
    },
    codexContinue: { required: false, stage: "", prompt: "", reason: "" },
    ...(options.config ? { config: options.config } : {}),
    ...(options.failedAt ? {
      failedAt: options.failedAt,
      error: "previous failure",
      recoverable: true,
    } : {}),
  }, null, 2)}\n`);
  return job;
}

async function writeArtifact(job: string, path: string, content = "fixture"): Promise<void> {
  const target = join(job, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function healthyProbe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    duration: 8.5,
    hasVideo: true,
    hasAudio: true,
    videoBitrate: 1_000_000,
    videoProfile: "high",
    pixelFormat: "yuv420p",
    width: 1440,
    height: 1080,
    ...overrides,
  };
}

function cutResult(input: KouboMediaCutterInput): MediaCutResult {
  return {
    input: input.input,
    output: input.output,
    originalDuration: 10,
    newDuration: 8.5,
    deletedDuration: 1.5,
    savedPercent: 15,
    cutRanges: input.ranges.map((range) => ({ ...range })),
    keepSegments: [{ start: 0, end: 1 }, { start: 2.5, end: 10 }],
    hasAudio: true,
    width: 1440,
    height: 1080,
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
        const digest = createHash("sha256").update(bytes).digest("hex");
        output.push(`f:${key}:${bytes.byteLength}:${digest}`);
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

describe("Koubo workflow snapshot and cut application", () => {
  it("reads status with a SHA-256 revision of the exact project.json bytes", async () => {
    const job = await fixture();
    const raw = await readFile(join(job, "project.json"), "utf8");
    const snapshot = await readKouboWorkflow(job);

    expect(snapshot.status).toBe("cut_review_ready");
    expect(snapshot.jobId).toBe("fixture-job");
    expect(snapshot.revision).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("has zero side effects when the cut is not explicitly confirmed", async () => {
    const job = await fixture();
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: false,
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({ code: "confirmation_required" });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("cuts into the canonical review artifact, verifies audio, and requests subtitle rebuild", async () => {
    const job = await fixture();
    const before = await readKouboWorkflow(job);
    const result = await applyKouboCut(job, {
      confirmed: true,
      expectedRevision: before.revision,
      rootSourceCut: "symlink",
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "fixture-cut-with-audio");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
      },
    });

    expect(result.previousRevision).toBe(before.revision);
    expect(result.status).toBe("codex_continue_required");
    expect(result.project.codexContinue).toMatchObject({
      required: true,
      stage: "subtitle_rebuild",
      prompt: "继续 fixture-job",
    });
    expect(result.project.artifacts).toMatchObject({
      sourceCut: "剪口播/3_审核/source_cut.mp4",
      cutDone: "剪口播/3_审核/cut_done.json",
    });
    expect(await readlink(join(job, "source_cut.mp4"))).toBe("剪口播/3_审核/source_cut.mp4");
    expect((await lstat(join(job, "source_cut.mp4"))).isSymbolicLink()).toBe(true);
    const done = JSON.parse(await readFile(result.cutDonePath, "utf8"));
    expect(done).toMatchObject({
      success: true,
      source: "chengfeng-videocut",
      outputRelative: "剪口播/3_审核/source_cut.mp4",
      hasAudio: true,
      nextStep: "subtitle_rebuild",
    });
    expect(await eventTypes(job)).toEqual([
      "status_changed",
      "cut_done",
      "status_changed",
      "codex_continue_required",
    ]);
  });

  it("rejects a stale cut revision before writing or invoking the cutter", async () => {
    const job = await fixture();
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: "0".repeat(64),
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({ code: "revision_conflict" });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("allows only cut_review_ready or failed-at-cutting as cut start states", async () => {
    const job = await fixture({ status: "storyboard_review_ready" });
    const before = await treeSnapshot(job);
    await expect(applyKouboCut(job, { confirmed: true })).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("persists media failures as recoverable cutting failures", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      now: fixedNow,
      dependencies: {
        mediaCutter: async () => {
          throw new Error("fixture ffmpeg failure");
        },
      },
    })).rejects.toMatchObject({ code: "workflow_failed" });

    const failed = await readKouboWorkflow(job);
    expect(failed.project).toMatchObject({
      status: "failed",
      failedAt: "cutting",
      error: "fixture ffmpeg failure",
      recoverable: true,
    });
    expect(await eventTypes(job)).toEqual(["status_changed", "failed"]);
  });

  it("fails the workflow when ffprobe reports that cut audio is missing", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "silent-video");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe({ hasAudio: false }),
      },
    })).rejects.toMatchObject({ code: "media_has_no_audio" });

    const failed = await readKouboWorkflow(job);
    expect(failed.project).toMatchObject({
      status: "failed",
      failedAt: "cutting",
      recoverable: true,
    });
  });

  it("serializes same-project writes so one shared revision commits only once", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);
    let cutterCalls = 0;
    const dependencies = {
      mediaCutter: async (input: KouboMediaCutterInput) => {
        cutterCalls += 1;
        await writeArtifact(job, relative(job, input.output), "serialized-cut");
        return cutResult(input);
      },
      mediaProbe: async () => healthyProbe(),
    };
    const results = await Promise.allSettled([
      applyKouboCut(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        dependencies,
      }),
      applyKouboCut(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        dependencies,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "revision_conflict" });
    }
    expect(cutterCalls).toBe(1);
  });
});

interface TransitionScenario {
  action: KouboWorkflowAction;
  status: string;
  stage: string;
  artifacts: Array<[string, string]>;
  event: string;
}

const transitionScenarios: TransitionScenario[] = [
  {
    action: "confirm-storyboard",
    status: "storyboard_review_ready",
    stage: "animation",
    artifacts: [["visualPlan", "visual-plan.json"]],
    event: "storyboard_confirmed",
  },
  {
    action: "confirm-animation",
    status: "animation_review_ready",
    stage: "timeline",
    artifacts: [["animationManifest", "动画/manifest.json"]],
    event: "animation_confirmed",
  },
  {
    action: "confirm-timeline",
    status: "timeline_review_ready",
    stage: "render",
    artifacts: [
      ["timeline", "timeline.json"],
      ["finalPlayer", "final-player.html"],
    ],
    event: "render_requested",
  },
  {
    action: "request-render",
    status: "render_requested",
    stage: "render",
    artifacts: [
      ["timeline", "timeline.json"],
      ["finalPlayer", "final-player.html"],
    ],
    event: "render_requested",
  },
];

describe("controlled Koubo workflow transitions", () => {
  it("writes final config and advances final_config_ready directly to the storyboard continuation", async () => {
    const job = await fixture({
      status: "final_config_ready",
      artifacts: {
        sourceCut: "剪口播/3_审核/source_cut.mp4",
        subtitles: "subtitles.srt",
      },
    });
    await writeArtifact(job, "剪口播/3_审核/source_cut.mp4", "cut-video");
    await writeArtifact(job, "subtitles.srt", "1\n00:00:00,000 --> 00:00:01,000\n字幕\n");
    const before = await readKouboWorkflow(job);

    const result = await transitionKouboWorkflow(job, "start-final", {
      confirmed: true,
      expectedRevision: before.revision,
      config: { aspectRatio: "4:3", animationStyle: "xiaohei", requirements: "保留音画一体" },
      now: fixedNow,
    });

    expect(result.status).toBe("codex_continue_required");
    expect(result.project.codexContinue).toMatchObject({ required: true, stage: "storyboard" });
    expect(result.project.config).toEqual({
      aspectRatio: "4:3",
      animationStyle: "xiaohei",
      requirements: "保留音画一体",
    });
    expect(JSON.parse(await readFile(join(job, "成片配置/config.json"), "utf8"))).toEqual(
      result.project.config,
    );
    expect(await eventTypes(job)).toEqual([
      "final_config_confirmed",
      "status_changed",
      "codex_continue_required",
    ]);
  });

  for (const scenario of transitionScenarios) {
    it(`${scenario.action} advances ${scenario.status} directly to ${scenario.stage}`, async () => {
      const artifacts = Object.fromEntries(scenario.artifacts);
      const job = await fixture({ status: scenario.status, artifacts });
      await Promise.all(scenario.artifacts.map(([, path]) => writeArtifact(job, path)));
      const before = await readKouboWorkflow(job);

      const result = await transitionKouboWorkflow(job, scenario.action, {
        confirmed: true,
        expectedRevision: before.revision,
        now: fixedNow,
      });

      expect(result.status).toBe("codex_continue_required");
      expect(result.project.codexContinue).toMatchObject({
        required: true,
        stage: scenario.stage,
        prompt: "继续 fixture-job",
      });
      expect(await eventTypes(job)).toEqual([
        scenario.event,
        "status_changed",
        "codex_continue_required",
      ]);
    });
  }

  it("does not mutate a transition when confirmation is absent", async () => {
    const job = await fixture({ status: "storyboard_review_ready" });
    await writeArtifact(job, "visual-plan.json");
    const before = await treeSnapshot(job);

    await expect(transitionKouboWorkflow(job, "confirm-storyboard", {
      confirmed: false,
      expectedRevision: "0".repeat(64),
    })).rejects.toMatchObject({ code: "confirmation_required" });

    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("rejects a stale transition revision before any write", async () => {
    const job = await fixture({ status: "storyboard_review_ready" });
    await writeArtifact(job, "visual-plan.json");
    const before = await treeSnapshot(job);

    await expect(transitionKouboWorkflow(job, "confirm-storyboard", {
      confirmed: true,
      expectedRevision: "0".repeat(64),
    })).rejects.toMatchObject({ code: "revision_conflict" });

    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("requires action artifacts before writing project state or events", async () => {
    const job = await fixture({ status: "timeline_review_ready" });
    await writeArtifact(job, "timeline.json");
    const before = await treeSnapshot(job);
    const snapshot = await readKouboWorkflow(job);

    await expect(transitionKouboWorkflow(job, "confirm-timeline", {
      confirmed: true,
      expectedRevision: snapshot.revision,
    })).rejects.toMatchObject({ code: "missing_artifact" });

    expect(await treeSnapshot(job)).toEqual(before);
  });
});
