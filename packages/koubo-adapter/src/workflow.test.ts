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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildEditListFromCuts } from "@video-workbench/core";
import type { MediaCutRange, MediaCutResult, MediaProbe } from "./mediaCut";
import {
  applyKouboCut,
  readKouboWorkflow,
  transitionKouboWorkflow,
  type KouboMediaCutterInput,
  type KouboWorkflowAction,
} from "./workflow";

const cleanup: string[] = [];
const fixedNow = () => new Date("2026-07-16T01:02:03.000Z");
const FIXTURE_SOURCE_SHA256 = createHash("sha256").update("fixture-source").digest("hex");

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FixtureOptions {
  status?: string;
  failedAt?: string;
  artifacts?: Record<string, string>;
  config?: Record<string, unknown>;
  cutRanges?: Array<{ start: number; end: number }>;
  includeEditList?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-workflow-"));
  cleanup.push(root);
  const job = join(root, "fixture-job");
  await mkdir(join(job, "input"), { recursive: true });
  await writeFile(join(job, "input/source.mp4"), "fixture-source");
  const cutSelectionRaw = `${JSON.stringify({
    schemaVersion: 3,
    cutWordIds: [],
    cutRanges: options.cutRanges ?? [{ start: 1, end: 2.5 }],
  }, null, 2)}\n`;
  await writeFile(join(job, "cut-selection.json"), cutSelectionRaw);
  const transcriptRaw = `${JSON.stringify({
    schemaVersion: 1,
    cues: [{
      id: "cue-1",
      words: [
        { id: "w-1", text: "前", start: 0, end: 1 },
        { id: "w-2", text: "后", start: 2.5, end: 10 },
      ],
    }],
  }, null, 2)}\n`;
  await writeFile(join(job, "transcript.json"), transcriptRaw);
  if (options.includeEditList !== false) {
    const editList = buildEditListFromCuts({
      projectId: "fixture-job",
      source: "input/source.mp4",
      sourceDuration: 10,
      cutsRevision: createHash("sha256").update(cutSelectionRaw).digest("hex"),
      transcriptRevision: createHash("sha256").update(transcriptRaw).digest("hex"),
      cutRanges: options.cutRanges ?? [{ start: 1, end: 2.5 }],
    });
    await writeFile(join(job, "edit-list.json"), `${JSON.stringify(editList, null, 2)}\n`);
  }
  await writeFile(join(job, "project.json"), `${JSON.stringify({
    jobId: "fixture-job",
    status: options.status ?? "cut_review_ready",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    inputVideo: "input/source.mp4",
    source: {
      path: "input/source.mp4",
      sha256: FIXTURE_SOURCE_SHA256,
      immutable: true,
    },
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

async function editListRevision(job: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(job, "edit-list.json"), "utf8"))
    .digest("hex");
}

async function writeArtifact(job: string, path: string, content = "fixture"): Promise<void> {
  const target = join(job, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function writeCurrentCutPair(
  job: string,
  source = "previous-source-cut",
  done = '{"artifactRevision":"previous"}\n',
): Promise<void> {
  await writeArtifact(job, "剪口播/3_审核/source_cut.mp4", source);
  await writeArtifact(job, "剪口播/3_审核/cut_done.json", done);
}

async function writeVerifiedCurrentCutPair(
  job: string,
  revision?: string,
): Promise<void> {
  const resolvedRevision = revision ?? await editListRevision(job);
  await writeCurrentCutPair(job, "verified-source-cut", `${JSON.stringify({
    schemaVersion: 1,
    success: true,
    source: "chengfeng-videocut",
    artifactRevision: resolvedRevision,
    confirmedEditListRevision: resolvedRevision,
    editListRevision: resolvedRevision,
    sourceSha256: FIXTURE_SOURCE_SHA256,
    outputRelative: "剪口播/3_审核/source_cut.mp4",
    outputSha256: createHash("sha256").update("verified-source-cut").digest("hex"),
    newDuration: 8.5,
    expectedDuration: 8.5,
    durationDeltaSeconds: 0,
    durationToleranceSeconds: 0.15,
    hasAudio: true,
    width: 1440,
    height: 1080,
  }, null, 2)}\n`);
}

async function readCurrentCutPair(job: string): Promise<{ source: Buffer; done: Buffer }> {
  return {
    source: await readFile(join(job, "剪口播/3_审核/source_cut.mp4")),
    done: await readFile(join(job, "剪口播/3_审核/cut_done.json")),
  };
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
    keepSegments: (input.segments ?? [{ start: 0, end: 1 }, { start: 2.5, end: 10 }])
      .map((segment) => ({ ...segment })),
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

  it("fails closed when a confirmed legacy call omits the EDL revision", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({
      code: "revision_required",
      details: { reason: "missing_confirmed_edit_list_revision" },
    });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("rejects an explicit none EDL revision before invoking the cutter", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: "none",
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({
      code: "revision_required",
      details: { reason: "edit_list_required" },
    });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("requires project prepare when edit-list.json is absent", async () => {
    const job = await fixture({ includeEditList: false });
    const snapshot = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: "a".repeat(64),
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({
      code: "revision_required",
      details: { reason: "edit_list_required" },
    });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("cuts into the canonical review artifact, verifies audio, and requests subtitle rebuild", async () => {
    const job = await fixture();
    const before = await readKouboWorkflow(job);
    const confirmedEditListRevision = await editListRevision(job);
    const result = await applyKouboCut(job, {
      confirmed: true,
      expectedRevision: before.revision,
      expectedEditListRevision: confirmedEditListRevision,
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
      artifactRevision: confirmedEditListRevision,
      confirmedEditListRevision,
      sourcePath: "input/source.mp4",
      sourceSha256: FIXTURE_SOURCE_SHA256,
      outputRelative: "剪口播/3_审核/source_cut.mp4",
      outputSha256: createHash("sha256").update("fixture-cut-with-audio").digest("hex"),
      expectedDuration: 8.5,
      durationDeltaSeconds: 0,
      durationToleranceSeconds: 0.15,
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

  it("replaces the previous current pair only after the candidate pair is valid", async () => {
    const job = await fixture();
    await writeCurrentCutPair(job);
    const snapshot = await readKouboWorkflow(job);
    const confirmedEditListRevision = await editListRevision(job);

    await applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: confirmedEditListRevision,
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          expect(input.output).toContain(
            `.cut-transactions/${confirmedEditListRevision}-`,
          );
          expect(input.output).toEndWith("/candidate/source_cut.mp4");
          await writeArtifact(job, relative(job, input.output), "new-source-cut");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
      },
    });

    const current = await readCurrentCutPair(job);
    expect(current.source.toString("utf8")).toBe("new-source-cut");
    expect(JSON.parse(current.done.toString("utf8"))).toMatchObject({
      artifactRevision: confirmedEditListRevision,
      confirmedEditListRevision,
      outputRelative: "剪口播/3_审核/source_cut.mp4",
    });
    expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
  });

  it("keeps the previous current pair byte-for-byte when candidate probing fails", async () => {
    const job = await fixture();
    await writeCurrentCutPair(job, "old-media-bytes", "old-provenance-bytes");
    const previous = await readCurrentCutPair(job);
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "unverified-new-media");
          return cutResult(input);
        },
        mediaProbe: async () => {
          throw new Error("fixture probe failure");
        },
      },
    })).rejects.toMatchObject({ code: "workflow_failed" });

    expect(await readCurrentCutPair(job)).toEqual(previous);
    expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
  });

  it("keeps the previous pair when candidate provenance cannot be committed", async () => {
    const job = await fixture();
    await writeCurrentCutPair(job, "old-media", "old-provenance");
    const previous = await readCurrentCutPair(job);
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "new-candidate-media");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
        artifactPromotionHook: async (stage) => {
          if (stage === "candidate_pair_ready") {
            throw new Error("injected candidate provenance failure");
          }
        },
      },
    })).rejects.toMatchObject({ code: "workflow_failed" });

    expect(await readCurrentCutPair(job)).toEqual(previous);
    expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
  });

  it("rolls back the exact previous pair when either promotion rename is followed by failure", async () => {
    for (const failedStage of ["source_cut_promoted", "cut_done_promoted"] as const) {
      const job = await fixture();
      await writeCurrentCutPair(
        job,
        `old-media-${failedStage}`,
        `old-provenance-${failedStage}`,
      );
      const previous = await readCurrentCutPair(job);
      const snapshot = await readKouboWorkflow(job);

      await expect(applyKouboCut(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        expectedEditListRevision: await editListRevision(job),
        now: fixedNow,
        dependencies: {
          mediaCutter: async (input) => {
            await writeArtifact(job, relative(job, input.output), `new-media-${failedStage}`);
            return cutResult(input);
          },
          mediaProbe: async () => healthyProbe(),
          artifactPromotionHook: async (stage) => {
            if (stage === failedStage) throw new Error(`injected ${failedStage} failure`);
          },
        },
      })).rejects.toMatchObject({ code: "workflow_failed" });

      expect(await readCurrentCutPair(job)).toEqual(previous);
      expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
    }
  });

  it("removes a first-run root symlink when a post-promotion project commit fails", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      rootSourceCut: "symlink",
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "first-run-candidate");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
        artifactPromotionHook: async (stage) => {
          if (stage === "before_final_project_commit") {
            throw new Error("injected final project failure");
          }
        },
      },
    })).rejects.toMatchObject({ code: "workflow_failed" });

    await expect(lstat(join(job, "source_cut.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(job, "剪口播/3_审核/source_cut.mp4")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(job, "剪口播/3_审核/cut_done.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
    expect((await readKouboWorkflow(job)).project).toMatchObject({
      status: "failed",
      failedAt: "cutting",
      recoverable: true,
    });
  });

  it("restores the previous root symlink target together with the previous pair", async () => {
    const job = await fixture();
    await writeArtifact(job, "legacy/previous.mp4", "legacy-root-target");
    await symlink("legacy/previous.mp4", join(job, "source_cut.mp4"));
    await writeCurrentCutPair(job, "old-current-media", "old-current-provenance");
    const previous = await readCurrentCutPair(job);
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      rootSourceCut: "symlink",
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "replacement-media");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
        artifactPromotionHook: async (stage) => {
          if (stage === "before_final_project_commit") {
            throw new Error("injected final project failure");
          }
        },
      },
    })).rejects.toMatchObject({ code: "workflow_failed" });

    expect(await readlink(join(job, "source_cut.mp4"))).toBe("legacy/previous.mp4");
    expect(await readCurrentCutPair(job)).toEqual(previous);
  });

  it("rejects a source changed after prepare before status writes or cutter invocation", async () => {
    const job = await fixture();
    await writeFile(join(job, "input/source.mp4"), "mutated-source");
    const snapshot = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({
      code: "revision_conflict",
      details: { reason: "source_changed_after_prepare" },
    });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("discards the candidate when the immutable source changes while cutting", async () => {
    const job = await fixture();
    await writeCurrentCutPair(job, "old-concurrent-source-media", "old-concurrent-source-done");
    const previous = await readCurrentCutPair(job);
    const snapshot = await readKouboWorkflow(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          await writeArtifact(job, relative(job, input.output), "candidate-from-old-source");
          await writeFile(join(job, "input/source.mp4"), "source-mutated-during-cut");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
      },
    })).rejects.toMatchObject({
      code: "revision_conflict",
      details: { reason: "source_changed_during_cut" },
    });

    expect(cutterCalls).toBe(1);
    expect(await readCurrentCutPair(job)).toEqual(previous);
    expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
  });

  it("does not promote a candidate whose duration differs from the EDL duration", async () => {
    const job = await fixture();
    await writeCurrentCutPair(job, "old-duration-media", "old-duration-provenance");
    const previous = await readCurrentCutPair(job);
    const snapshot = await readKouboWorkflow(job);

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: await editListRevision(job),
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "wrong-duration-media");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe({ duration: 1 }),
      },
    })).rejects.toMatchObject({
      code: "workflow_failed",
      details: {
        reason: "cut_duration_mismatch",
        expectedDuration: 8.5,
        actualDuration: 1,
        toleranceSeconds: 0.15,
      },
    });

    expect(await readCurrentCutPair(job)).toEqual(previous);
    expect(await readdir(join(job, "剪口播/3_审核"))).not.toContain(".cut-transactions");
  });

  it("keeps a committed current pair when success notifications cannot be appended", async () => {
    const job = await fixture();
    const snapshot = await readKouboWorkflow(job);
    const confirmedEditListRevision = await editListRevision(job);

    const result = await applyKouboCut(job, {
      confirmed: true,
      expectedRevision: snapshot.revision,
      expectedEditListRevision: confirmedEditListRevision,
      dependencies: {
        mediaCutter: async (input) => {
          await writeArtifact(job, relative(job, input.output), "event-failure-media");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
        artifactPromotionHook: async (stage) => {
          if (stage === "before_success_events") {
            throw new Error("injected event append failure");
          }
        },
      },
    });

    expect(result.status).toBe("codex_continue_required");
    expect(JSON.parse(await readFile(result.cutDonePath, "utf8"))).toMatchObject({
      editListRevision: confirmedEditListRevision,
      outputSha256: createHash("sha256").update("event-failure-media").digest("hex"),
    });
    expect(await eventTypes(job)).toEqual(["status_changed"]);
  });

  it("exports the current EDL order and records the exact edit-list revision", async () => {
    const job = await fixture();
    const cutsRaw = await readFile(join(job, "cut-selection.json"), "utf8");
    const transcriptRaw = await readFile(join(job, "transcript.json"), "utf8");
    const editList = buildEditListFromCuts({
      projectId: "fixture-job",
      source: "input/source.mp4",
      sourceDuration: 10,
      cutsRevision: createHash("sha256").update(cutsRaw).digest("hex"),
      transcriptRevision: createHash("sha256").update(transcriptRaw).digest("hex"),
      cutRanges: [{ start: 1, end: 2.5 }],
    });
    editList.mode = "manual";
    editList.segments = [editList.segments[1]!, editList.segments[0]!].map(
      (segment, index) => ({ ...segment, timelineStart: index === 0 ? 0 : 7.5 }),
    );
    const editListRaw = `${JSON.stringify(editList, null, 2)}\n`;
    const editListRevision = createHash("sha256").update(editListRaw).digest("hex");
    await writeFile(join(job, "edit-list.json"), editListRaw);
    const before = await readKouboWorkflow(job);
    const captured: { segments?: MediaCutRange[] } = {};

    const result = await applyKouboCut(job, {
      confirmed: true,
      expectedRevision: before.revision,
      expectedEditListRevision: editListRevision,
      now: fixedNow,
      dependencies: {
        mediaCutter: async (input) => {
          captured.segments = input.segments?.map((segment) => ({ ...segment }));
          await writeArtifact(job, relative(job, input.output), "reordered-cut");
          return cutResult(input);
        },
        mediaProbe: async () => healthyProbe(),
      },
    });

    expect(captured.segments).toEqual([
      { start: 2.5, end: 10 },
      { start: 0, end: 1 },
    ]);
    expect(result.cut.keepSegments).toEqual([
      { start: 2.5, end: 10 },
      { start: 0, end: 1 },
    ]);
    expect(JSON.parse(await readFile(result.cutDonePath, "utf8"))).toMatchObject({
      editListRevision,
      editListMode: "manual",
      keepSegments: [
        { start: 2.5, end: 10 },
        { start: 0, end: 1 },
      ],
    });
  });

  it("rejects EDL playback-rate changes explicitly before physical export", async () => {
    const job = await fixture();
    const cutsRaw = await readFile(join(job, "cut-selection.json"), "utf8");
    const transcriptRaw = await readFile(join(job, "transcript.json"), "utf8");
    const editList = buildEditListFromCuts({
      projectId: "fixture-job",
      source: "input/source.mp4",
      sourceDuration: 10,
      cutsRevision: createHash("sha256").update(cutsRaw).digest("hex"),
      transcriptRevision: createHash("sha256").update(transcriptRaw).digest("hex"),
      cutRanges: [{ start: 1, end: 2.5 }],
    });
    editList.segments[0]!.playbackRate = 1.25;
    editList.duration = 6.75;
    editList.segments[1]!.timelineStart = 0.8;
    const editListRaw = `${JSON.stringify(editList, null, 2)}\n`;
    const editListRevision = createHash("sha256").update(editListRaw).digest("hex");
    await writeFile(join(job, "edit-list.json"), editListRaw);
    const workflow = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: workflow.revision,
      expectedEditListRevision: editListRevision,
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({
      code: "invalid_state",
      details: {
        reason: "unsupported_playback_rate",
        segmentId: "a-roll-0001",
        playbackRate: 1.25,
      },
    });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("rejects an EDL changed after confirmation before status or media output changes", async () => {
    const job = await fixture();
    const cutsRaw = await readFile(join(job, "cut-selection.json"), "utf8");
    const transcriptRaw = await readFile(join(job, "transcript.json"), "utf8");
    const confirmedEditList = buildEditListFromCuts({
      projectId: "fixture-job",
      source: "input/source.mp4",
      sourceDuration: 10,
      cutsRevision: createHash("sha256").update(cutsRaw).digest("hex"),
      transcriptRevision: createHash("sha256").update(transcriptRaw).digest("hex"),
      cutRanges: [{ start: 1, end: 2.5 }],
    });
    const confirmedRaw = `${JSON.stringify(confirmedEditList, null, 2)}\n`;
    const confirmedRevision = createHash("sha256").update(confirmedRaw).digest("hex");
    const currentEditList = structuredClone(confirmedEditList);
    currentEditList.mode = "manual";
    currentEditList.segments[0]!.sourceEnd = 0.75;
    currentEditList.segments[1]!.timelineStart = 0.75;
    currentEditList.duration = 8.25;
    await writeFile(
      join(job, "edit-list.json"),
      `${JSON.stringify(currentEditList, null, 2)}\n`,
    );
    await writeCurrentCutPair(job, "revision-guard-media", "revision-guard-provenance");
    const workflow = await readKouboWorkflow(job);
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: workflow.revision,
      expectedEditListRevision: confirmedRevision,
      dependencies: {
        mediaCutter: async (input) => {
          cutterCalls += 1;
          return cutResult(input);
        },
      },
    })).rejects.toMatchObject({
      code: "revision_conflict",
      details: { reason: "edit_list_changed_after_confirmation" },
    });

    expect(cutterCalls).toBe(0);
    expect(await treeSnapshot(job)).toEqual(before);
  });

  it("rejects a stale cut revision before writing or invoking the cutter", async () => {
    const job = await fixture();
    await writeCurrentCutPair(job, "stale-guard-media", "stale-guard-provenance");
    const before = await treeSnapshot(job);
    let cutterCalls = 0;

    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedRevision: "0".repeat(64),
      expectedEditListRevision: await editListRevision(job),
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
    await expect(applyKouboCut(job, {
      confirmed: true,
      expectedEditListRevision: await editListRevision(job),
    })).rejects.toMatchObject({
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
      expectedEditListRevision: await editListRevision(job),
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
      expectedEditListRevision: await editListRevision(job),
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
        expectedEditListRevision: await editListRevision(job),
        dependencies,
      }),
      applyKouboCut(job, {
        confirmed: true,
        expectedRevision: snapshot.revision,
        expectedEditListRevision: await editListRevision(job),
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
    await writeVerifiedCurrentCutPair(job);
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

  for (const artifactState of ["missing", "legacy", "stale"] as const) {
    it(`blocks start-final without writes when the cut artifact is ${artifactState}`, async () => {
      const job = await fixture({
        status: "final_config_ready",
        artifacts: {
          sourceCut: "剪口播/3_审核/source_cut.mp4",
          subtitles: "subtitles.srt",
        },
      });
      await writeArtifact(job, "subtitles.srt", "subtitle");
      if (artifactState === "legacy") {
        await writeArtifact(job, "剪口播/3_审核/source_cut.mp4", "legacy-media");
      }
      if (artifactState === "stale") {
        await writeVerifiedCurrentCutPair(job, "b".repeat(64));
      }
      const snapshot = await readKouboWorkflow(job);
      const before = await treeSnapshot(job);

      await expect(transitionKouboWorkflow(job, "start-final", {
        confirmed: true,
        expectedRevision: snapshot.revision,
        config: { aspectRatio: "4:3", animationStyle: "xiaohei" },
      })).rejects.toMatchObject({
        code: "invalid_state",
        details: {
          reason: "cut_artifact_not_current",
          artifactState,
        },
      });

      expect(await treeSnapshot(job)).toEqual(before);
    });
  }

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
