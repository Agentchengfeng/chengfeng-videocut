import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applyKouboCut,
  type KouboMediaCutterInput,
} from "@video-workbench/koubo-adapter";
import { buildEditListFromCuts } from "@video-workbench/core";
import { createVideocutWorkflowHandler } from "./workflow-api";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(status = "final_config_ready") {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-workflow-api-"));
  cleanup.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  await mkdir(join(projectDir, "input"), { recursive: true });
  await mkdir(join(projectDir, "剪口播/3_审核"), { recursive: true });
  await writeFile(join(projectDir, "input/source.mp4"), "source");
  await writeFile(join(projectDir, "剪口播/3_审核/source_cut.mp4"), "cut");
  await writeFile(join(projectDir, "subtitles.srt"), "1\n00:00:00,000 --> 00:00:01,000\n字幕\n");
  await writeFile(join(projectDir, "cut-selection.json"), JSON.stringify({
    schemaVersion: 3,
    cutWordIds: ["w-1"],
    cutRanges: [{ start: 0.5, end: 1 }],
  }));
  await writeFile(join(projectDir, "project.json"), `${JSON.stringify({
    jobId: "demo",
    status,
    inputVideo: "input/source.mp4",
    source: {
      path: "input/source.mp4",
      sha256: createHash("sha256").update("source").digest("hex"),
      immutable: true,
    },
    artifacts: {
      sourceCut: "剪口播/3_审核/source_cut.mp4",
      subtitles: "subtitles.srt",
      workbenchCutSelection: "cut-selection.json",
    },
    codexContinue: null,
  }, null, 2)}\n`);
  return { root, projectsDir, projectDir };
}

function request(
  resource: "workflow" | "actions",
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost/api/v1/projects/demo/${resource}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function required(value: Promise<Response | null>): Promise<Response> {
  const result = await value;
  if (!result) throw new Error("Expected workflow handler response");
  return result;
}

async function writeFixtureEditList(projectDir: string): Promise<string> {
  const cutsRaw = await readFile(join(projectDir, "cut-selection.json"), "utf8");
  const transcriptRaw = JSON.stringify({
    cues: [{ words: [
      { id: "w-1", text: "测试", start: 0, end: 0.5 },
      { id: "w-2", text: "口播", start: 1, end: 2 },
    ] }],
  });
  await writeFile(join(projectDir, "transcript.json"), transcriptRaw);
  const document = buildEditListFromCuts({
    projectId: "demo",
    source: "input/source.mp4",
    sourceDuration: 2,
    cutsRevision: createHash("sha256").update(cutsRaw).digest("hex"),
    transcriptRevision: createHash("sha256").update(transcriptRaw).digest("hex"),
    cutRanges: [{ start: 0.5, end: 1 }],
  });
  const raw = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(join(projectDir, "edit-list.json"), raw);
  return createHash("sha256").update(raw).digest("hex");
}

async function writeVerifiedCutDone(
  projectDir: string,
  editListRevision: string,
): Promise<void> {
  await writeFile(join(projectDir, "剪口播/3_审核/cut_done.json"), `${JSON.stringify({
    schemaVersion: 1,
    success: true,
    source: "chengfeng-videocut",
    artifactRevision: editListRevision,
    confirmedEditListRevision: editListRevision,
    editListRevision,
    sourceSha256: createHash("sha256").update("source").digest("hex"),
    outputRelative: "剪口播/3_审核/source_cut.mp4",
    outputSha256: createHash("sha256").update("cut").digest("hex"),
    newDuration: 1.5,
    expectedDuration: 1.5,
    durationDeltaSeconds: 0,
    durationToleranceSeconds: 0.15,
    hasAudio: true,
    width: 320,
    height: 240,
  }, null, 2)}\n`);
}

describe("videocut workflow API", () => {
  it("returns workflow revision and executes a confirmation-gated transition", async () => {
    const { projectsDir, projectDir } = await fixture();
    const editListRevision = await writeFixtureEditList(projectDir);
    await writeVerifiedCutDone(projectDir, editListRevision);
    const handler = createVideocutWorkflowHandler({ projectsDir });
    const get = await required(handler(request("workflow")));
    const before = await get.json();

    expect(get.status).toBe(200);
    expect(before).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      activeTask: false,
      artifact: {
        state: "current",
        editListRevision,
        path: "剪口播/3_审核/source_cut.mp4",
      },
      project: { status: "final_config_ready" },
    });
    expect(before.revision).toMatch(/^[a-f0-9]{64}$/);

    const unconfirmed = await required(handler(request("actions", {
      action: "start-final",
      confirmed: false,
      expectedRevision: before.revision,
    })));
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({
      ok: false,
      error: { code: "confirmation_required" },
    });

    const transition = await required(handler(request("actions", {
      action: "start-final",
      confirmed: true,
      expectedRevision: before.revision,
      config: { aspectRatio: "4:3", animationStyle: "xiaohei", requirements: "真实素材优先" },
    })));
    expect(transition.status).toBe(200);
    expect(await transition.json()).toMatchObject({
      action: "start-final",
      project: {
        status: "codex_continue_required",
        codexContinue: { stage: "storyboard" },
      },
    });
  });

  it("derives current, stale, and missing physical artifact states from disk truth", async () => {
    const { projectsDir, projectDir } = await fixture();
    const artifactEditListRevision = await writeFixtureEditList(projectDir);
    const handler = createVideocutWorkflowHandler({ projectsDir });

    const legacy = await (await required(handler(request("workflow")))).json();
    expect(legacy.artifact).toEqual({
      state: "legacy",
      editListRevision: null,
      path: "剪口播/3_审核/source_cut.mp4",
    });

    await writeVerifiedCutDone(projectDir, artifactEditListRevision);

    const current = await (await required(handler(request("workflow")))).json();
    expect(current).toMatchObject({
      editListRevision: artifactEditListRevision,
      artifact: {
        state: "current",
        editListRevision: artifactEditListRevision,
        path: "剪口播/3_审核/source_cut.mp4",
      },
    });

    const editListPath = join(projectDir, "edit-list.json");
    await writeFile(editListPath, `${await readFile(editListPath, "utf8")}\n`);
    const stale = await (await required(handler(request("workflow")))).json();
    expect(stale.editListRevision).not.toBe(artifactEditListRevision);
    expect(stale.artifact).toEqual({
      state: "stale",
      editListRevision: artifactEditListRevision,
      path: "剪口播/3_审核/source_cut.mp4",
    });

    await rm(join(projectDir, "剪口播/3_审核/source_cut.mp4"));
    const missing = await (await required(handler(request("workflow")))).json();
    expect(missing.artifact).toEqual({
      state: "missing",
      editListRevision: null,
      path: null,
    });
  });

  it("fails closed before start-final when the cut artifact is not current", async () => {
    const { projectsDir } = await fixture();
    let transitionCalls = 0;
    const handler = createVideocutWorkflowHandler({
      projectsDir,
      transition: async () => {
        transitionCalls += 1;
        throw new Error("must not transition");
      },
    });
    const before = await (await required(handler(request("workflow")))).json();
    expect(before.artifact.state).toBe("legacy");

    const rejected = await required(handler(request("actions", {
      action: "start-final",
      confirmed: true,
      expectedRevision: before.revision,
      config: { aspectRatio: "4:3", animationStyle: "xiaohei" },
    })));

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: {
        code: "invalid_state",
        details: {
          reason: "cut_artifact_not_current",
          artifactState: "legacy",
        },
      },
    });
    expect(transitionCalls).toBe(0);
  });

  it("accepts physical cutting in the background and exposes live state", async () => {
    const { projectsDir, projectDir } = await fixture("cut_review_ready");
    const confirmedEditListRevision = await writeFixtureEditList(projectDir);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = createVideocutWorkflowHandler({
      projectsDir,
      applyCut: (directory, options) => applyKouboCut(directory, {
        ...options,
        dependencies: {
          mediaCutter: async (input: KouboMediaCutterInput) => {
            await gate;
            await mkdir(join(projectDir, "剪口播/3_审核"), { recursive: true });
            await writeFile(input.output, "cut-with-audio");
            return {
              input: input.input,
              output: input.output,
              originalDuration: 2,
              newDuration: 1.5,
              deletedDuration: 0.5,
              savedPercent: 25,
              cutRanges: [...input.ranges],
              keepSegments: [{ start: 0, end: 0.5 }, { start: 1, end: 2 }],
              hasAudio: true,
              width: 320,
              height: 240,
            };
          },
          mediaProbe: async () => ({
            duration: 1.5,
            hasVideo: true,
            hasAudio: true,
            videoBitrate: 1_000_000,
            videoProfile: "high",
            pixelFormat: "yuv420p",
            width: 320,
            height: 240,
          }),
        },
      }),
    });
    const before = await (await required(handler(request("workflow")))).json();
    const accepted = await required(handler(request("actions", {
      action: "apply-cut",
      confirmed: true,
      expectedRevision: before.revision,
      expectedEditListRevision: confirmedEditListRevision,
    })));
    const acceptedBody = await accepted.json();

    expect(accepted.status).toBe(202);
    expect(acceptedBody).toMatchObject({
      accepted: true,
      activeTask: true,
      project: { status: "cutting" },
    });
    const live = await (await required(handler(request("workflow")))).json();
    expect(live).toMatchObject({ activeTask: true, project: { status: "cutting" } });

    release?.();
    let completed: Record<string, unknown> | null = null;
    const completionDeadline = Date.now() + 8_000;
    while (Date.now() < completionDeadline) {
      const current = await (await required(handler(request("workflow")))).json();
      if (
        current.project?.codexContinue?.stage === "subtitle_rebuild" &&
        current.activeTask === false
      ) {
        completed = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed).toMatchObject({
      activeTask: false,
      artifact: {
        state: "current",
        editListRevision: confirmedEditListRevision,
        path: "剪口播/3_审核/source_cut.mp4",
      },
      project: { status: "codex_continue_required", codexContinue: { stage: "subtitle_rebuild" } },
    });
    expect(relative(projectDir, join(projectDir, "剪口播/3_审核/cut_done.json")))
      .toBe(join("剪口播", "3_审核", "cut_done.json"));
    expect(JSON.parse(await readFile(join(projectDir, "剪口播/3_审核/cut_done.json"), "utf8")))
      .toMatchObject({ hasAudio: true, nextStep: "subtitle_rebuild" });
  }, 15_000);

  it("fails closed when a legacy apply-cut request omits the confirmed EDL revision", async () => {
    const { projectsDir } = await fixture("cut_review_ready");
    let applyCalls = 0;
    const handler = createVideocutWorkflowHandler({
      projectsDir,
      applyCut: async () => {
        applyCalls += 1;
        throw new Error("must not execute");
      },
    });
    const before = await (await required(handler(request("workflow")))).json();

    const rejected = await required(handler(request("actions", {
      action: "apply-cut",
      confirmed: true,
      expectedRevision: before.revision,
    })));

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: {
        code: "revision_required",
        details: { reason: "missing_confirmed_edit_list_revision" },
      },
    });
    expect(applyCalls).toBe(0);
  });

  it("rejects explicit none and never schedules physical cutting", async () => {
    const { projectsDir } = await fixture("cut_review_ready");
    let applyCalls = 0;
    const handler = createVideocutWorkflowHandler({
      projectsDir,
      applyCut: async () => {
        applyCalls += 1;
        throw new Error("must not execute");
      },
    });
    const before = await (await required(handler(request("workflow")))).json();

    const rejected = await required(handler(request("actions", {
      action: "apply-cut",
      confirmed: true,
      expectedRevision: before.revision,
      expectedEditListRevision: "none",
    })));

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { code: "revision_required", details: { reason: "edit_list_required" } },
    });
    expect(applyCalls).toBe(0);
  });

  it("requires project prepare when apply-cut has no current edit-list.json", async () => {
    const { projectsDir } = await fixture("cut_review_ready");
    let applyCalls = 0;
    const handler = createVideocutWorkflowHandler({
      projectsDir,
      applyCut: async () => {
        applyCalls += 1;
        throw new Error("must not execute");
      },
    });
    const before = await (await required(handler(request("workflow")))).json();

    const rejected = await required(handler(request("actions", {
      action: "apply-cut",
      confirmed: true,
      expectedRevision: before.revision,
      expectedEditListRevision: "e".repeat(64),
    })));

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { code: "revision_required", details: { reason: "edit_list_required" } },
    });
    expect(applyCalls).toBe(0);
  });

  it("returns a structured conflict and never cuts when EDL changes after confirmation", async () => {
    const { projectsDir, projectDir } = await fixture("cut_review_ready");
    const confirmedEditListRevision = await writeFixtureEditList(projectDir);
    let applyCalls = 0;
    const handler = createVideocutWorkflowHandler({
      projectsDir,
      applyCut: async () => {
        applyCalls += 1;
        throw new Error("must not execute");
      },
    });
    const before = await (await required(handler(request("workflow")))).json();
    expect(before.editListRevision).toBe(confirmedEditListRevision);
    const editListPath = join(projectDir, "edit-list.json");
    await writeFile(editListPath, `${await readFile(editListPath, "utf8")}\n`);
    const currentEditListRevision = createHash("sha256")
      .update(await readFile(editListPath, "utf8"))
      .digest("hex");

    const rejected = await required(handler(request("actions", {
      action: "apply-cut",
      confirmed: true,
      expectedRevision: before.revision,
      expectedEditListRevision: confirmedEditListRevision,
    })));

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
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
    expect(applyCalls).toBe(0);
  });
});
