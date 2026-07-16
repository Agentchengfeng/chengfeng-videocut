import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKouboSrt, putKouboArtifact, renderFinalPlayer } from "./artifact";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeProject(job: string, value: Record<string, unknown>): Promise<string> {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(job, "project.json"), raw);
  return hash(raw);
}

async function fixture(stage: string): Promise<{ job: string; revision: string }> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-artifact-"));
  cleanup.push(root);
  const job = join(root, "job");
  await mkdir(join(job, "动画"), { recursive: true });
  await writeFile(join(job, "source_cut.mp4"), "cut-video");
  await writeFile(join(job, "cut-selection.json"), JSON.stringify({
    schemaVersion: 3,
    cutWordIds: ["w-2"],
    cutRanges: [{ start: 1, end: 2 }],
  }));
  await writeFile(
    join(job, "subtitles.srt"),
    "1\r\n00:00:00,000 --> 00:00:01,000\r\n真实字幕\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\n第二行字幕\r\n",
  );
  await writeFile(join(job, "动画/module-proof.html"), "<!doctype html><div class=screen></div>");
  await writeFile(join(job, "transcript.json"), JSON.stringify({
    schemaVersion: 1,
    cues: [{ id: "cue-1", words: [
      { id: "w-1", text: "证", start: 0, end: 1 },
      { id: "w-2", text: "明", start: 1, end: 2 },
    ] }],
  }));
  const revision = await writeProject(job, {
    jobId: "artifact-job",
    title: "Artifact job",
    status: "codex_continue_required",
    config: { aspectRatio: "4:3" },
    codexContinue: { required: true, stage },
    artifacts: { sourceCut: "source_cut.mp4" },
  });
  return { job, revision };
}

describe("controlled koubo artifacts", () => {
  it("publishes real SRT only after physical cutting and advances to config review", async () => {
    const { job, revision } = await fixture("subtitle_rebuild");
    await rm(join(job, "subtitles.srt"));
    const srt = "1\n00:00:00,000 --> 00:00:01,500\n真实字幕\n";
    const result = await putKouboArtifact(job, {
      type: "subtitles",
      content: srt,
      expectedProjectRevision: revision,
      expectedArtifactRevision: "none",
    });

    expect(result).toMatchObject({ status: "final_config_ready", changed: true });
    expect(await readFile(join(job, "subtitles.srt"), "utf8")).toBe(srt);
    expect(await readFile(join(job, "字幕/3_输出/video.srt"), "utf8")).toBe(srt);
    expect(JSON.parse(await readFile(join(job, "project.json"), "utf8"))).toMatchObject({
      status: "final_config_ready",
      codexContinue: null,
      artifacts: { subtitles: "subtitles.srt" },
    });
  });

  it("validates and advances storyboard, animation, and canonical timeline artifacts", async () => {
    const fixtureValue = await fixture("storyboard");
    const visual = {
      schemaVersion: 2,
      segments: [{
        id: "visual-1",
        cueId: "cue-1",
        wordIds: ["w-1", "w-2"],
        title: "证明",
        description: "显示真实结果",
        kind: "HTML",
        clipIds: ["proof"],
      }],
    };
    await putKouboArtifact(fixtureValue.job, {
      type: "visual-plan",
      content: JSON.stringify(visual),
      expectedProjectRevision: fixtureValue.revision,
      expectedArtifactRevision: "none",
    });
    let project = JSON.parse(await readFile(join(fixtureValue.job, "project.json"), "utf8"));
    expect(project.status).toBe("storyboard_review_ready");
    expect(JSON.parse(
      await readFile(join(fixtureValue.job, "visual-plan.json"), "utf8"),
    ).cutSync).toMatchObject({
      schemaVersion: 1,
      cutWordIds: ["w-2"],
    });

    const animationRevision = await writeProject(fixtureValue.job, {
      ...project,
      status: "codex_continue_required",
      codexContinue: { required: true, stage: "animation" },
    });
    const manifest = {
      schemaVersion: 1,
      modules: [{
        id: "proof",
        src: "动画/module-proof.html",
        cue: "w-1..w-2",
        beats: [{ at: 0, step: 0 }],
        checks: ["static", "mid"],
      }],
    };
    await putKouboArtifact(fixtureValue.job, {
      type: "animation-manifest",
      content: JSON.stringify(manifest),
      expectedProjectRevision: animationRevision,
      expectedArtifactRevision: "none",
    });
    project = JSON.parse(await readFile(join(fixtureValue.job, "project.json"), "utf8"));
    expect(project.status).toBe("animation_review_ready");

    const timelineRevision = await writeProject(fixtureValue.job, {
      ...project,
      status: "codex_continue_required",
      codexContinue: { required: true, stage: "timeline" },
    });
    const timeline = {
      schemaVersion: 1,
      totalDuration: 2,
      scenes: [{
        id: "scene-proof",
        kind: "html",
        src: "动画/module-proof.html",
        start: 0,
        end: 2,
        cueSteps: [{ at: 0, step: 0 }, { at: 1, step: 1 }],
      }],
    };
    const timelineResult = await putKouboArtifact(fixtureValue.job, {
      type: "timeline",
      content: JSON.stringify(timeline),
      expectedProjectRevision: timelineRevision,
      expectedArtifactRevision: "none",
    });
    const player = await readFile(join(fixtureValue.job, "final-player.html"), "utf8");

    expect(timelineResult.status).toBe("timeline_review_ready");
    expect(player).toContain("width:1440px;height:1080px");
    expect(player).toContain("window.seekTo=async function");
    expect(player).toContain("window.finalVideo=finalVideo");
    expect(player).toContain("window.finalCaptions=finalCaptions");
    expect(player).toContain("真实字幕");
    expect(player).toContain("第二行字幕");
    expect(player).toContain('id="caption-layer"');
    expect(player).toContain("showCaption(t)");
    expect(player).toContain('searchParams.set("render","1")');
  });

  it("requires real canonical subtitles before publishing a timeline", async () => {
    const fixtureValue = await fixture("timeline");
    await writeFile(
      join(fixtureValue.job, "动画/manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        modules: [],
        noAnimationReason: "该测试只验证字幕门禁",
      }),
    );
    await rm(join(fixtureValue.job, "subtitles.srt"));
    const timeline = {
      schemaVersion: 1,
      totalDuration: 2,
      scenes: [{
        id: "scene-a-roll",
        kind: "video",
        src: "source_cut.mp4",
        start: 0,
        end: 2,
      }],
    };

    await expect(putKouboArtifact(fixtureValue.job, {
      type: "timeline",
      content: JSON.stringify(timeline),
      expectedProjectRevision: fixtureValue.revision,
      expectedArtifactRevision: "none",
    })).rejects.toThrow("canonical subtitles.srt");
    await expect(readFile(join(fixtureValue.job, "timeline.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(fixtureValue.job, "final-player.html"), "utf8")).rejects.toThrow();
  });

  it("supports an explicitly animation-free plan without inventing an HTML module", async () => {
    const fixtureValue = await fixture("animation");
    await expect(putKouboArtifact(fixtureValue.job, {
      type: "animation-manifest",
      content: JSON.stringify({ schemaVersion: 1, modules: [] }),
      expectedProjectRevision: fixtureValue.revision,
      expectedArtifactRevision: "none",
    })).rejects.toThrow("noAnimationReason");

    const manifestResult = await putKouboArtifact(fixtureValue.job, {
      type: "animation-manifest",
      content: JSON.stringify({
        schemaVersion: 1,
        modules: [],
        noAnimationReason: "全程使用真实 A-roll，不需要解释动画",
      }),
      expectedProjectRevision: fixtureValue.revision,
      expectedArtifactRevision: "none",
    });
    expect(manifestResult.status).toBe("animation_review_ready");

    const project = JSON.parse(
      await readFile(join(fixtureValue.job, "project.json"), "utf8"),
    );
    const timelineRevision = await writeProject(fixtureValue.job, {
      ...project,
      status: "codex_continue_required",
      codexContinue: { required: true, stage: "timeline" },
    });
    const timelineResult = await putKouboArtifact(fixtureValue.job, {
      type: "timeline",
      content: JSON.stringify({
        schemaVersion: 1,
        totalDuration: 2,
        scenes: [{
          id: "a-roll-only",
          kind: "video",
          src: "source_cut.mp4",
          start: 0,
          end: 2,
          sourceStart: 0,
        }],
      }),
      expectedProjectRevision: timelineRevision,
      expectedArtifactRevision: "none",
    });
    expect(timelineResult.status).toBe("timeline_review_ready");
  });

  it("rejects timeline HTML that bypasses or omits the reviewed animation manifest", async () => {
    const fixtureValue = await fixture("animation");
    await writeFile(
      join(fixtureValue.job, "动画/unreviewed.html"),
      "<!doctype html><div>unreviewed</div>",
    );
    await putKouboArtifact(fixtureValue.job, {
      type: "animation-manifest",
      content: JSON.stringify({
        schemaVersion: 1,
        modules: [{
          id: "proof",
          src: "动画/module-proof.html",
          cue: "w-1..w-2",
          beats: [{ at: 0, step: 0 }],
          checks: ["static", "mid"],
        }],
      }),
      expectedProjectRevision: fixtureValue.revision,
      expectedArtifactRevision: "none",
    });
    const project = JSON.parse(
      await readFile(join(fixtureValue.job, "project.json"), "utf8"),
    );
    const timelineRevision = await writeProject(fixtureValue.job, {
      ...project,
      status: "codex_continue_required",
      codexContinue: { required: true, stage: "timeline" },
    });

    await expect(putKouboArtifact(fixtureValue.job, {
      type: "timeline",
      content: JSON.stringify({
        schemaVersion: 1,
        totalDuration: 2,
        scenes: [{
          id: "unreviewed",
          kind: "html",
          src: "动画/unreviewed.html",
          start: 0,
          end: 2,
        }],
      }),
      expectedProjectRevision: timelineRevision,
      expectedArtifactRevision: "none",
    })).rejects.toThrow("was not reviewed");

    await expect(putKouboArtifact(fixtureValue.job, {
      type: "timeline",
      content: JSON.stringify({
        schemaVersion: 1,
        totalDuration: 2,
        scenes: [{
          id: "a-roll",
          kind: "video",
          src: "source_cut.mp4",
          start: 0,
          end: 2,
        }],
      }),
      expectedProjectRevision: timelineRevision,
      expectedArtifactRevision: "none",
    })).rejects.toThrow("omits reviewed animation modules");
  });

  it("rejects stale writers before creating an artifact", async () => {
    const { job } = await fixture("storyboard");
    await expect(putKouboArtifact(job, {
      type: "visual-plan",
      content: JSON.stringify({ schemaVersion: 2, segments: [] }),
      expectedProjectRevision: "0".repeat(64),
      expectedArtifactRevision: "none",
    })).rejects.toThrow("project.json revision conflict");
    await expect(readFile(join(job, "visual-plan.json"), "utf8")).rejects.toThrow();
  });
});

describe("canonical subtitle export", () => {
  it("parses CRLF, multiline text, optional ids, and ignores malformed cues", () => {
    expect(parseKouboSrt([
      "7",
      "00:00:01,250 --> 00:00:02,500 align:center",
      "第一行",
      "第二行",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "无编号",
      "",
      "broken",
    ].join("\r\n"))).toEqual([
      { id: "7", start: 1.25, end: 2.5, text: "第一行\n第二行" },
      { id: "caption-2", start: 3, end: 4, text: "无编号" },
    ]);
  });

  it("renders no visible or invented caption text when no captions were supplied", () => {
    const player = renderFinalPlayer({
      title: "No ghost captions",
      width: 1440,
      height: 1080,
      timeline: {
        schemaVersion: 1,
        totalDuration: 1,
        scenes: [{
          id: "scene",
          kind: "image",
          src: "frame.png",
          start: 0,
          end: 1,
        }],
      },
    });
    expect(player).toContain("const finalCaptions=[]");
    expect(player).not.toContain("示例字幕");
    expect(player).toContain('captionLayer.style.display=cue?"flex":"none"');
  });
});
