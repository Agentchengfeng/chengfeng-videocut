import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applyKouboCut,
  type KouboMediaCutterInput,
} from "@video-workbench/koubo-adapter";
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

describe("videocut workflow API", () => {
  it("returns workflow revision and executes a confirmation-gated transition", async () => {
    const { projectsDir } = await fixture();
    const handler = createVideocutWorkflowHandler({ projectsDir });
    const get = await required(handler(request("workflow")));
    const before = await get.json();

    expect(get.status).toBe(200);
    expect(before).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      activeTask: false,
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

  it("accepts physical cutting in the background and exposes live state", async () => {
    const { projectsDir, projectDir } = await fixture("cut_review_ready");
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
    for (let index = 0; index < 100; index += 1) {
      const current = await (await required(handler(request("workflow")))).json();
      if (current.project?.codexContinue?.stage === "subtitle_rebuild") {
        completed = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed).toMatchObject({
      activeTask: false,
      project: { status: "codex_continue_required", codexContinue: { stage: "subtitle_rebuild" } },
    });
    expect(relative(projectDir, join(projectDir, "剪口播/3_审核/cut_done.json")))
      .toBe("剪口播/3_审核/cut_done.json");
    expect(JSON.parse(await readFile(join(projectDir, "剪口播/3_审核/cut_done.json"), "utf8")))
      .toMatchObject({ hasAudio: true, nextStep: "subtitle_rebuild" });
  });
});
