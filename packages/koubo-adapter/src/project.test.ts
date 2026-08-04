import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKouboProject,
  deriveAspectRatio,
  frameDimensions,
  parseAspectRatio,
  KOUBO_PROJECTION_RUNTIME_VERSION,
  KOUBO_PROJECTION_SCHEMA_VERSION,
  materializeKouboEditListIndex,
  prepareKouboProject,
  renderKouboProjectIndex,
} from "./project";

const cleanup: string[] = [];
const fixedNow = () => new Date("2026-07-16T00:00:00.000Z");
const noMediaPreviewProxyDependencies = {
  probeMedia: async () => {
    throw new Error("fixture intentionally has no decodable media");
  },
};

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(existingCuts?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-prepare-"));
  cleanup.push(root);
  const job = join(root, "job");
  await mkdir(join(job, "input"), { recursive: true });
  await mkdir(join(job, "剪口播/1_转录"), { recursive: true });
  await mkdir(join(job, "剪口播/2_分析"), { recursive: true });
  await writeFile(join(job, "input/source.mp4"), "fixture-media");
  await writeFile(join(job, "project.json"), JSON.stringify({
    jobId: "fixture-job",
    title: "Fixture",
    status: "cut_review_ready",
    inputVideo: "input/source.mp4",
    config: { aspectRatio: "4:3" },
  }));
  await writeFile(join(job, "剪口播/1_转录/subtitles_words.json"), JSON.stringify({
    schemaVersion: 1,
    cues: [{
      id: "source-cue",
      words: [
        { id: "w-1", text: "前", start: 0, end: 1 },
        { id: "gap-1", text: "", start: 1, end: 4.58, isGap: true },
        { id: "w-2", text: "后", start: 4.58, end: 5.58 },
      ],
    }],
  }));
  await writeFile(join(job, "剪口播/2_分析/auto_selected.json"), "[]\n");
  if (existingCuts) {
    await writeFile(join(job, "cut-selection.json"), `${JSON.stringify(existingCuts, null, 2)}\n`);
  }
  return job;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture(name = "real-task"): Promise<{
  root: string;
  job: string;
  video: string;
  transcript: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-create-"));
  cleanup.push(root);
  const job = join(root, name);
  const video = join(job, "uploads", "talk.mp4");
  const transcript = join(job, "cloud", "words.json");
  await mkdir(join(job, "uploads"), { recursive: true });
  await mkdir(join(job, "cloud"), { recursive: true });
  await writeFile(video, "real-task-media");
  await writeFile(transcript, JSON.stringify({
    schemaVersion: 1,
    cues: [{
      id: "cloud-cue",
      words: [
        { id: "cloud-w-1", text: "真", start: 0, end: 1 },
        { id: "cloud-w-2", text: "实", start: 1, end: 2 },
      ],
    }],
  }));
  return { root, job, video, transcript };
}

describe("transcript media binding", () => {
  const transcriptWithMedia = (sha256: string, source = "uploads/talk.mp4") => JSON.stringify({
    schemaVersion: 1,
    provider: "volcengine",
    language: "zh-CN",
    media: { source, sha256, duration: 2 },
    cues: [{
      id: "cloud-cue",
      words: [
        { id: "cloud-w-1", text: "真", start: 0, end: 1 },
        { id: "cloud-w-2", text: "实", start: 1, end: 2 },
      ],
    }],
  });

  it("accepts a transcript bound to the given video", async () => {
    const fixtureValue = await createFixture();
    const sha = createHash("sha256").update("real-task-media").digest("hex");
    await writeFile(fixtureValue.transcript, transcriptWithMedia(sha));
    const result = await createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
      now: fixedNow,
    });
    expect(result.projectId).toBe("real-task");
    // The binding must survive normalization, or nothing can be checked later.
    expect(JSON.parse(await readFile(join(fixtureValue.job, "transcript.json"), "utf8")))
      .toMatchObject({ media: { sha256: sha } });
  });

  it("refuses a transcript produced from different media", async () => {
    // The post-cut transcript lives in the same job directory as the source
    // one, so re-attaching it to the original video is a single flag away.
    // Before the gate this succeeded and every later deletion cut at the wrong
    // timecode with nothing reporting an error.
    const fixtureValue = await createFixture();
    const foreign = createHash("sha256").update("some-other-video").digest("hex");
    await writeFile(fixtureValue.transcript, transcriptWithMedia(foreign, "input/source_cut.mp4"));
    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
      now: fixedNow,
    })).rejects.toMatchObject({
      code: "invalid_transcript",
      details: { reason: "transcript_media_mismatch", transcribedFrom: "input/source_cut.mp4" },
    });
  });

  it("still accepts transcripts written before the binding existed", async () => {
    // Refusing these would strand every existing project.
    const fixtureValue = await createFixture();
    const result = await createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
      now: fixedNow,
    });
    expect(result.projectId).toBe("real-task");
  });
});

describe("createKouboProject contract", () => {
  it("creates canonical task inputs and prepares a new project without demo files", async () => {
    const fixtureValue = await createFixture();
    const result = await createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      projectId: "real-task",
      canonicalVideo: "input/source.mp4",
      canonicalTranscript: "剪口播/1_转录/subtitles_words.json",
      indexWritten: true,
      metadata: {
        aspectRatio: "4:3",
        videoSource: "input/source.mp4",
        transcriptSource: "剪口播/1_转录/subtitles_words.json",
      },
    });
    expect(await readFile(join(fixtureValue.job, result.canonicalVideo), "utf8"))
      .toBe("real-task-media");
    expect(JSON.parse(await readFile(join(fixtureValue.job, "project.json"), "utf8")))
      .toMatchObject({
        jobId: "real-task",
        status: "cut_review_ready",
        inputVideo: "input/source.mp4",
        config: { aspectRatio: "4:3" },
        source: { path: "input/source.mp4", immutable: true },
      });
    const index = await readFile(join(fixtureValue.job, "index.html"), "utf8");
    expect(index).toContain("generated-by: chengfeng-videocut");
    expect(index).not.toContain("demo");

    const before = await readFile(join(fixtureValue.job, "project.json"), "utf8");
    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
    })).rejects.toMatchObject({ code: "project_id_conflict" });
    expect(await readFile(join(fixtureValue.job, "project.json"), "utf8")).toBe(before);
  });

  it("rolls back canonical and product files when prepare fails", async () => {
    const fixtureValue = await createFixture("rollback-task");
    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "16:9",
      now: fixedNow,
      beforePrepareCommitFile: (_path, index) => {
        if (index === 1) throw new Error("injected prepare failure");
      },
    })).rejects.toThrow("injected prepare failure");

    expect(await readFile(fixtureValue.video, "utf8")).toBe("real-task-media");
    expect(await readFile(fixtureValue.transcript, "utf8")).toContain("cloud-w-1");
    for (const path of [
      "project.json",
      "input/source.mp4",
      "剪口播/1_转录/subtitles_words.json",
      "transcript.json",
      "cut-selection.json",
      "edit-list.json",
      "index.html",
      "workbench.json",
      "events.jsonl",
      "剪口播/3_审核/natural_pause_plan.json",
    ]) {
      await expect(readFile(join(fixtureValue.job, path), "utf8")).rejects.toThrow();
    }
  });

  it("treats dangling symlinks as existing project artifacts", async () => {
    const fixtureValue = await createFixture("dangling-link-task");
    const projectPath = join(fixtureValue.job, "project.json");
    await symlink(join(fixtureValue.job, "missing-project-target"), projectPath);

    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
    })).rejects.toMatchObject({ code: "project_id_conflict" });

    expect((await lstat(projectPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(fixtureValue.video, "utf8")).toBe("real-task-media");
    await expect(lstat(join(fixtureValue.job, "input"))).rejects.toMatchObject({ code: "ENOENT" });

    const canonicalFixture = await createFixture("dangling-canonical-task");
    const canonicalDirectory = join(canonicalFixture.job, "input");
    const canonicalVideo = join(canonicalDirectory, "source.mp4");
    await mkdir(canonicalDirectory);
    await symlink(join(canonicalFixture.job, "missing-video-target"), canonicalVideo);
    await expect(createKouboProject(canonicalFixture.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
    })).rejects.toMatchObject({ code: "project_id_conflict" });
    expect((await lstat(canonicalVideo)).isSymbolicLink()).toBe(true);
  });

  it("does not overwrite or roll back a foreign target created after preflight", async () => {
    const fixtureValue = await createFixture("foreign-race-task");
    const racedPath = join(fixtureValue.job, "cut-selection.json");
    let injected = false;

    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "16:9",
      beforePrepareCommitFile: async (_path, index) => {
        if (index === 0 && !injected) {
          injected = true;
          await writeFile(racedPath, "foreign-writer\n", { flag: "wx" });
        }
      },
    })).rejects.toMatchObject({ code: "project_id_conflict" });

    expect(await readFile(racedPath, "utf8")).toBe("foreign-writer\n");
    for (const path of [
      "project.json",
      "input/source.mp4",
      "剪口播/1_转录/subtitles_words.json",
      "transcript.json",
      "edit-list.json",
      "index.html",
      "workbench.json",
      "events.jsonl",
    ]) {
      await expect(lstat(join(fixtureValue.job, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(lstat(join(fixtureValue.job, "input"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixtureValue.job, "剪口播"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a foreign replacement during rollback", async () => {
    const fixtureValue = await createFixture("foreign-replacement-task");
    const indexPath = join(fixtureValue.job, "index.html");

    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
      finalize: async () => {
        await rm(indexPath);
        await writeFile(indexPath, "foreign-index\n", { flag: "wx" });
        throw new Error("injected registration failure");
      },
    })).rejects.toThrow("injected registration failure");

    expect(await readFile(indexPath, "utf8")).toBe("foreign-index\n");
    await expect(lstat(join(fixtureValue.job, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixtureValue.job, "input/source.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps pre-existing directories and canonical same-file inputs", async () => {
    const fixtureValue = await createFixture("canonical-input-task");
    const inputDirectory = join(fixtureValue.job, "input");
    const transcriptDirectory = join(fixtureValue.job, "剪口播", "1_转录");
    await mkdir(inputDirectory, { recursive: true });
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(join(inputDirectory, "source.mp4"), "canonical-media");
    await writeFile(
      join(transcriptDirectory, "subtitles_words.json"),
      await readFile(fixtureValue.transcript, "utf8"),
    );
    const inputBefore = await lstat(inputDirectory);
    const transcriptBefore = await lstat(transcriptDirectory);

    await expect(createKouboProject(fixtureValue.job, {
      video: "input/source.mp4",
      transcript: "剪口播/1_转录/subtitles_words.json",
      aspectRatio: "4:3",
      finalize: () => {
        throw new Error("injected finalize failure");
      },
    })).rejects.toThrow("injected finalize failure");

    expect(await readFile(join(inputDirectory, "source.mp4"), "utf8")).toBe("canonical-media");
    expect(await readFile(join(transcriptDirectory, "subtitles_words.json"), "utf8"))
      .toContain("cloud-w-1");
    expect((await lstat(inputDirectory)).ino).toBe(inputBefore.ino);
    expect((await lstat(transcriptDirectory)).ino).toBe(transcriptBefore.ino);
    await expect(lstat(join(fixtureValue.job, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects directory escape and the reserved demo project before writing", async () => {
    const fixtureValue = await createFixture("safe-task");
    const outsideVideo = join(fixtureValue.root, "outside.mp4");
    await writeFile(outsideVideo, "outside-media");
    await expect(createKouboProject(fixtureValue.job, {
      video: "../outside.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "3:4",
    })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(readFile(join(fixtureValue.job, "project.json"), "utf8")).rejects.toThrow();

    await symlink(outsideVideo, join(fixtureValue.job, "uploads/escaped.mp4"));
    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/escaped.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "3:4",
    })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(readFile(join(fixtureValue.job, "project.json"), "utf8")).rejects.toThrow();

    const demo = await createFixture("demo");
    await expect(createKouboProject(demo.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "3:4",
    })).rejects.toMatchObject({ code: "invalid_project" });
    await expect(readFile(join(demo.job, "project.json"), "utf8")).rejects.toThrow();
  });
});


describe("画幅比：由视频定义，不再限枚举", () => {
  it("frameDimensions 统一律：短边 1080 按比例放大取偶（旧查表全是特例）", () => {
    expect(frameDimensions("3:4")).toEqual({ width: 1080, height: 1440 });
    expect(frameDimensions("4:3")).toEqual({ width: 1440, height: 1080 });
    expect(frameDimensions("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(frameDimensions("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(frameDimensions("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(frameDimensions("4:5")).toEqual({ width: 1080, height: 1350 });
    // 解析不了保持旧兜底，不炸老项目。
    expect(frameDimensions("")).toEqual({ width: 1920, height: 1080 });
  });

  it("deriveAspectRatio 用最大公约数化简真实尺寸", () => {
    expect(deriveAspectRatio(1080, 1920)).toBe("9:16");
    expect(deriveAspectRatio(810, 1080)).toBe("3:4");
    expect(deriveAspectRatio(1920, 1080)).toBe("16:9");
    // 传感器裁边这类非标尺寸照样成立——比例是视频的事实，不是产品的选项。
    expect(deriveAspectRatio(1088, 1920)).toBe("17:30");
  });

  it("parseAspectRatio 只认正整数比，全角冒号也认", () => {
    expect(parseAspectRatio("16：9")).toEqual({ w: 16, h: 9 });
    expect(parseAspectRatio("abc")).toBeNull();
    expect(parseAspectRatio("0:4")).toBeNull();
    expect(parseAspectRatio("3:4:5")).toBeNull();
  });

  it("省略 aspectRatio 时从视频探测推导写入项目档案", async () => {
    const fixtureValue = await createFixture("derived-task");
    const result = await createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      probe: async () => ({ width: 1080, height: 1350 }),
      now: fixedNow,
    });
    expect(result.projectId).toBe("derived-task");
    const project = JSON.parse(await readFile(join(fixtureValue.job, "project.json"), "utf8"));
    expect(project.config.aspectRatio).toBe("4:5");
  });

  it("探测失败时明确要求显式传入，不塞默认值", async () => {
    const fixtureValue = await createFixture("underivable-task");
    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      probe: async () => { throw new Error("no decodable stream"); },
      now: fixedNow,
    })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("显式比例仍可覆盖，但要合法 W:H", async () => {
    const fixtureValue = await createFixture("explicit-task");
    await expect(createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "wide",
      now: fixedNow,
    })).rejects.toMatchObject({ code: "invalid_argument" });
    const created = await createKouboProject(fixtureValue.job, {
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "1:1",
      now: fixedNow,
    });
    expect(created.projectId).toBe("explicit-task");
  });
});

describe("prepareKouboProject natural-pause migration", () => {
  it("is byte-for-byte repeatable across refreshes", async () => {
    const job = await fixture();
    const options = { duration: 6, now: fixedNow };
    const firstPrepare = await prepareKouboProject(job, options);
    expect(firstPrepare.indexWritten).toBe(true);
    const paths = [
      "transcript.json",
      "cut-selection.json",
      "edit-list.json",
      "index.html",
      "剪口播/3_审核/natural_pause_plan.json",
    ];
    const before = await Promise.all(paths.map(async (path) =>
      digest(await readFile(join(job, path), "utf8"))));

    const secondPrepare = await prepareKouboProject(job, {
      ...options,
      now: () => new Date("2026-07-17T08:00:00.000Z"),
      refreshTranscript: true,
    });
    expect(secondPrepare.indexWritten).toBe(false);
    const after = await Promise.all(paths.map(async (path) =>
      digest(await readFile(join(job, path), "utf8"))));

    expect(after).toEqual(before);
    const plan = JSON.parse(await readFile(join(job, paths[4]), "utf8"));
    expect(plan.summary).toMatchObject({ pausesDeleted: 1, explicitGapsDeleted: 0 });
    expect(plan.summary.totalDeletedSeconds).toBe(3.58);
    const editListRaw = await readFile(join(job, "edit-list.json"), "utf8");
    const editList = JSON.parse(editListRaw);
    expect(editList).toMatchObject({ mode: "cuts-derived", duration: 2.42 });
    expect(editList.segments).toHaveLength(2);
    const index = await readFile(join(job, "index.html"), "utf8");
    expect(index.match(/data-edl-segment-id=/g)).toHaveLength(2);
    expect(index.match(/<video\b/g)).toHaveLength(1);
    expect(index.match(/<video\b[^>]*data-edl-segment-id=/g) ?? []).toHaveLength(0);
    expect(index.match(/<div\b[^>]*data-edl-segment-id=/g)).toHaveLength(2);
    expect(index).toContain('data-duration="2.420"');
    expect(index).toContain(`data-edit-list-revision="${digest(editListRaw)}"`);
    expect(index).toContain('data-videocut-preview="edl-adapter"');
    expect(index).toContain('data-render-policy="preview-only"');
    expect(index).toContain('data-chengfeng-videocut-edl-player="1"');
    const project = JSON.parse(await readFile(join(job, "project.json"), "utf8"));
    expect(project.source).toEqual({
      path: "input/source.mp4",
      sha256: digest("fixture-media"),
      immutable: true,
    });
    await expect(readFile(join(job, "visual-plan.json"), "utf8")).rejects.toThrow();
  });

  it("replays stable user additions and whole-gap restores without guessing parent ids", async () => {
    const job = await fixture();
    const options = { duration: 6, now: fixedNow };
    await prepareKouboProject(job, options);
    const path = join(job, "cut-selection.json");
    const selection = JSON.parse(await readFile(path, "utf8"));
    // The user restores the whole baseline gap and adds one stable speech word.
    // v3 has no residual split-gap ids to infer or promote.
    selection.cutWordIds = ["w-2"];
    selection.cutRanges = [{ start: 4.58, end: 5.58 }];
    await writeFile(path, `${JSON.stringify(selection, null, 2)}\n`);

    await prepareKouboProject(job, { ...options, refreshTranscript: true });
    const refreshed = JSON.parse(await readFile(path, "utf8"));
    expect(refreshed.cutWordIds).toEqual(["w-2"]);
    expect(refreshed.initialization.baselineCutWordIds).toEqual(["gap-1"]);
  });

  it("uses the current full-gap policy when a legacy derived split id is supplied", async () => {
    const job = await fixture({
      schemaVersion: 3,
      cutWordIds: ["gap-1__part_1000_4300"],
      cutRanges: [{ start: 1, end: 4.3 }],
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const plan = JSON.parse(
      await readFile(join(job, "剪口播/3_审核/natural_pause_plan.json"), "utf8"),
    );
    expect(plan.summary).toMatchObject({ pausesDeleted: 1, explicitGapsDeleted: 0 });
    expect(plan.deleteSegments).toEqual([{ start: 1, end: 4.58 }]);
  });

  it("upgrades a v3 cuts-derived baseline only during prepare and removes its residual tail", async () => {
    const job = await fixture();
    const options = { duration: 6, now: fixedNow };
    await prepareKouboProject(job, options);
    const selectionPath = join(job, "cut-selection.json");
    const selection = JSON.parse(await readFile(selectionPath, "utf8"));
    selection.initialization = {
      ...selection.initialization,
      naturalPausePolicy: "natural-pause-v3-direct-delete",
      baselineCutWordIds: ["gap-1__part_1000_4300"],
    };
    selection.cutWordIds = ["gap-1__part_1000_4300"];
    selection.cutRanges = [{ start: 1, end: 4.3 }];
    await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);

    await prepareKouboProject(job, options);

    const migrated = JSON.parse(await readFile(selectionPath, "utf8"));
    const plan = JSON.parse(
      await readFile(join(job, "剪口播/3_审核/natural_pause_plan.json"), "utf8"),
    );
    const editList = JSON.parse(await readFile(join(job, "edit-list.json"), "utf8"));
    expect(migrated.initialization.naturalPausePolicy).toBe("natural-pause-v4-delete-all-gaps");
    expect(migrated.initialization.baselineCutWordIds).toEqual(["gap-1"]);
    expect(migrated.cutWordIds).toEqual(["gap-1"]);
    expect(plan.deleteSegments).toEqual([{ start: 1, end: 4.58 }]);
    expect(editList).toMatchObject({ mode: "cuts-derived", duration: 2.42 });
  });

  it("preserves a manual edit list and refuses to rebase it after Cuts change", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const editListPath = join(job, "edit-list.json");
    const editList = JSON.parse(await readFile(editListPath, "utf8"));
    editList.mode = "manual";
    editList.segments = [editList.segments[1], editList.segments[0]].map(
      (segment: Record<string, unknown>, index: number) => ({
        ...segment,
        timelineStart: index === 0 ? 0 : 1.42,
      }),
    );
    await writeFile(editListPath, `${JSON.stringify(editList, null, 2)}\n`);
    const manual = await readFile(editListPath, "utf8");

    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    expect(await readFile(editListPath, "utf8")).toBe(manual);

    const protectedPaths = [
      "transcript.json",
      "cut-selection.json",
      "edit-list.json",
      "index.html",
      "剪口播/3_审核/natural_pause_plan.json",
    ];
    const before = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    await writeFile(join(job, "剪口播/2_分析/auto_selected.json"), "[0]\n");

    await expect(prepareKouboProject(job, {
      duration: 6,
      now: fixedNow,
      refreshTranscript: true,
    })).rejects.toThrow(
      "manual timeline edits",
    );
    const after = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    expect(after).toEqual(before);
  });

  it("rolls every staged project document back when a commit throws", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const protectedPaths = [
      "transcript.json",
      "cut-selection.json",
      "edit-list.json",
      "index.html",
      "剪口播/3_审核/natural_pause_plan.json",
      "workbench.json",
      "project.json",
      "events.jsonl",
    ];
    const before = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    await writeFile(join(job, "剪口播/2_分析/auto_selected.json"), "[0]\n");

    await expect(prepareKouboProject(job, {
      duration: 6,
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      refreshTranscript: true,
      beforeCommitFile: (_path, index) => {
        if (index === 2) throw new Error("injected prepare commit failure");
      },
    })).rejects.toThrow("injected prepare commit failure");

    const after = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    expect(after).toEqual(before);
  });

  it("discards a stale index projection instead of replacing the newer EDL projection", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const editListPath = join(job, "edit-list.json");
    const firstRaw = await readFile(editListPath, "utf8");
    const firstRevision = digest(firstRaw);
    const next = JSON.parse(firstRaw);
    next.mode = "manual";
    next.segments[0].sourceEnd = 0.8;
    next.segments[1].timelineStart = 0.8;
    next.duration = 2.22;
    const nextRaw = `${JSON.stringify(next, null, 2)}\n`;
    const nextRevision = digest(nextRaw);
    await writeFile(editListPath, nextRaw);

    const current = await materializeKouboEditListIndex(job, {
      expectedRevision: nextRevision,
    });
    expect(current.materialized).toBe(true);
    const currentIndex = await readFile(join(job, "index.html"), "utf8");
    expect(currentIndex).toContain('data-duration="2.220"');

    const stale = await materializeKouboEditListIndex(job, {
      expectedRevision: firstRevision,
    });
    expect(stale.materialized).toBe(false);
    expect(await readFile(join(job, "index.html"), "utf8")).toBe(currentIndex);
  });

  it("does not replace an index whose EDL revision and projection versions are current", async () => {
    const job = await fixture();
    await prepareKouboProject(job, {
      duration: 6,
      now: fixedNow,
      previewProxyDependencies: noMediaPreviewProxyDependencies,
    });
    const editListRaw = await readFile(join(job, "edit-list.json"), "utf8");
    const revision = digest(editListRaw);
    const indexPath = join(job, "index.html");
    const before = await stat(indexPath);

    const result = await materializeKouboEditListIndex(job, { expectedRevision: revision });

    const after = await stat(indexPath);
    expect(result.materialized).toBe(false);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(indexPath, "utf8")).toContain(
      `data-edit-list-revision="${revision}"`,
    );
    const index = await readFile(indexPath, "utf8");
    expect(index).toContain(
      `data-videocut-projection-schema="${KOUBO_PROJECTION_SCHEMA_VERSION}"`,
    );
    expect(index).toContain(
      `data-videocut-projection-runtime="${KOUBO_PROJECTION_RUNTIME_VERSION}"`,
    );
  });

  it("migrates a legacy runtime at the same EDL revision and preserves custom content", async () => {
    const job = await fixture();
    const prepareOptions = {
      duration: 6,
      now: fixedNow,
      previewProxyDependencies: noMediaPreviewProxyDependencies,
    };
    await prepareKouboProject(job, prepareOptions);
    const editListPath = join(job, "edit-list.json");
    const editListBefore = await readFile(editListPath, "utf8");
    const indexPath = join(job, "index.html");
    const customOverlay =
      '      <div data-hf-id="user-overlay" data-start="0" data-duration="1">CUSTOM OVERLAY</div>';
    const customScript =
      '    <script id="user-script">window.customProjectionContent = "preserve";</script>';
    const legacy = (await readFile(indexPath, "utf8"))
      .replaceAll(/\sdata-videocut-projection-(?:schema|runtime)="[^"]*"/g, "")
      .replace(
        /<script\b(?=[^>]*\bdata-chengfeng-videocut-edl-player="1")[^>]*>[\s\S]*?<\/script>/,
        '<script data-chengfeng-videocut-edl-player="1">window.__legacyEdlRuntime = true;</script>',
      )
      .replace(
        "      <!-- chengfeng-videocut:a-roll:end -->",
        `      <!-- chengfeng-videocut:a-roll:end -->\n${customOverlay}`,
      )
      .replace("  </body>", `${customScript}\n  </body>`);
    await writeFile(indexPath, legacy);

    const migrated = await prepareKouboProject(job, prepareOptions);

    expect(migrated.indexWritten).toBe(true);
    expect(await readFile(editListPath, "utf8")).toBe(editListBefore);
    const index = await readFile(indexPath, "utf8");
    expect(index).not.toContain("__legacyEdlRuntime");
    expect(index).toContain(customOverlay);
    expect(index).toContain(customScript);
    expect(index).toContain(
      `data-videocut-projection-schema="${KOUBO_PROJECTION_SCHEMA_VERSION}"`,
    );
    expect(index.match(
      new RegExp(
        `data-videocut-projection-runtime="${KOUBO_PROJECTION_RUNTIME_VERSION}"`,
        "g",
      ),
    )).toHaveLength(2);

    const migratedIdentity = await stat(indexPath);
    const repeated = await prepareKouboProject(job, prepareOptions);
    const repeatedIdentity = await stat(indexPath);
    expect(repeated.indexWritten).toBe(false);
    expect(repeatedIdentity.ino).toBe(migratedIdentity.ino);
    expect(await readFile(indexPath, "utf8")).toBe(index);
  });

  it("patches only managed A-roll nodes and preserves custom HyperFrames content", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const indexPath = join(job, "index.html");
    const customOverlay = '      <div data-hf-id="user-title" class="clip" data-start="0" data-duration="1">USER TITLE</div>';
    const customScript = '    <script id="user-animation">window.userAnimation = "keep-byte-stable";</script>';
    const customized = (await readFile(indexPath, "utf8"))
      .replace(
        "      <!-- chengfeng-videocut:a-roll:end -->",
        `      <!-- chengfeng-videocut:a-roll:end -->\n${customOverlay}`,
      )
      .replace("  </body>", `${customScript}\n  </body>`);
    await writeFile(indexPath, customized);

    const editListPath = join(job, "edit-list.json");
    const editList = JSON.parse(await readFile(editListPath, "utf8"));
    editList.mode = "manual";
    editList.segments[0].sourceEnd = 0.8;
    editList.segments[1].timelineStart = 0.8;
    editList.duration = 2.22;
    const editListRaw = `${JSON.stringify(editList, null, 2)}\n`;
    const revision = digest(editListRaw);
    await writeFile(editListPath, editListRaw);

    const result = await materializeKouboEditListIndex(job, { expectedRevision: revision });
    expect(result.materialized).toBe(true);
    const patched = await readFile(indexPath, "utf8");
    expect(patched).toContain(customOverlay);
    expect(patched).toContain(customScript);
    expect(patched).toContain('data-duration="2.220"');
    expect(patched).toContain(`data-edit-list-revision="${revision}"`);
    expect(patched.match(/data-edl-segment-id=/g)).toHaveLength(2);
    expect(patched.match(/<video\b/g)).toHaveLength(1);
    expect(patched.match(/<video\b[^>]*data-edl-segment-id=/g) ?? []).toHaveLength(0);
    expect(patched.match(/<div\b[^>]*data-edl-segment-id=/g)).toHaveLength(2);
    expect(patched).toContain('data-source-end="0.800"');
  });

  it("keeps decoder count constant for a long 198-segment talking-head edit", () => {
    const segments = Array.from({ length: 198 }, (_, index) => ({
      id: `a-roll-${String(index + 1).padStart(4, "0")}`,
      source: "input/source.mp4",
      sourceStart: index * 2,
      sourceEnd: index * 2 + 1,
      timelineStart: index,
      trackId: "a-roll" as const,
      playbackRate: 1,
    }));
    const index = renderKouboProjectIndex({
      title: "198 segment stability fixture",
      width: 1440,
      height: 1080,
      duration: 198,
      videoSource: "input/source.mp4",
      editList: {
        schemaVersion: 1,
        projectId: "stability-fixture",
        sourceDuration: 400,
        baseCutsRevision: "a".repeat(64),
        baseTranscriptRevision: "b".repeat(64),
        mode: "cuts-derived",
        duration: 198,
        segments,
      },
    });

    expect(index.match(/<video\b/g)).toHaveLength(1);
    expect(index).toContain('id="a-roll-preview"');
    expect(index).toContain('data-videocut-edl-backing');
    expect(index).toContain('data-studio-timeline-hidden');
    expect(index).toContain('preload="metadata"');
    expect(index).toContain('preload="metadata" muted playsinline');
    expect(index).not.toContain('preload="auto"');
    expect(index.match(/<(?:video|audio)\b[^>]*data-edl-segment-id=/g) ?? []).toHaveLength(0);
    expect(index.match(/<div\b[^>]*data-edl-segment-id=/g)).toHaveLength(198);
    const ids = [...index.matchAll(/data-edl-segment-id="([^"]+)"/g)]
      .map((match) => match[1]);
    expect(new Set(ids).size).toBe(198);
    expect(index).toContain('data-start="197.000"');
    expect(index).toContain('data-source-start="394.000"');
    expect(index).toContain('data-duration="198.000"');
    expect(index).toContain('Reflect.set(window, "__studioPlaybackAdapter", adapter)');
  });

  it("projects a same-timeline proxy into Studio without changing the canonical edit list", () => {
    const editList = {
      schemaVersion: 1 as const,
      projectId: "proxy-fixture",
      sourceDuration: 10,
      baseCutsRevision: "a".repeat(64),
      baseTranscriptRevision: "b".repeat(64),
      mode: "cuts-derived" as const,
      duration: 8,
      segments: [{
        id: "a-roll-0001",
        source: "input/source.mp4",
        sourceStart: 1,
        sourceEnd: 9,
        timelineStart: 0,
        trackId: "a-roll" as const,
        playbackRate: 1,
      }],
    };
    const index = renderKouboProjectIndex({
      title: "Proxy fixture",
      width: 1440,
      height: 1080,
      duration: 8,
      videoSource: "input/source.mp4",
      editList,
      previewSource: "preview/source-proxy.mp4",
    });

    expect(editList.segments[0].source).toBe("input/source.mp4");
    expect(index).toContain('src="preview/source-proxy.mp4"');
    expect(index).toContain("data-videocut-preview-proxy");
    expect(index).toContain('preload="auto" muted playsinline');
    expect(index).toContain('data-edl-media-src="preview/source-proxy.mp4"');
    expect(index).toContain('"source":"preview/source-proxy.mp4"');
    expect(index).not.toContain('"source":"input/source.mp4"');
  });

  it("prefers the immutable input video over a previous derived source", async () => {
    const job = await fixture();
    await writeFile(join(job, "source_cut.mp4"), "derived-media");
    await writeFile(join(job, "workbench.json"), JSON.stringify({
      videoSource: "source_cut.mp4",
      aspectRatio: "4:3",
    }));

    await prepareKouboProject(job, { duration: 6, now: fixedNow });

    const editList = JSON.parse(await readFile(join(job, "edit-list.json"), "utf8"));
    expect(editList.segments.every(
      (segment: Record<string, unknown>) => segment.source === "input/source.mp4",
    )).toBe(true);
  });

  it("rejects a changed canonical source before replacing any project document", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const protectedPaths = [
      "project.json",
      "workbench.json",
      "edit-list.json",
      "index.html",
      "events.jsonl",
    ];
    const before = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    await writeFile(join(job, "input/source.mp4"), "mutated-media");

    await expect(prepareKouboProject(job, {
      duration: 6,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })).rejects.toThrow("immutable source was modified");

    const after = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    expect(after).toEqual(before);
  });

  it("does not silently promote a previous derived cut to canonical source", async () => {
    const job = await fixture();
    const projectPath = join(job, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    delete project.inputVideo;
    project.artifacts = { sourceCut: "source_cut.mp4" };
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await rm(join(job, "input/source.mp4"));
    await writeFile(join(job, "source_cut.mp4"), "derived-media");

    await expect(prepareKouboProject(job, { duration: 6, now: fixedNow }))
      .rejects.toThrow("No real task video found");
  });

  it("refuses to force-replace a user-authored HyperFrames composition", async () => {
    const job = await fixture();
    const indexPath = join(job, "index.html");
    const custom = "<!doctype html><main data-composition-id=\"main\">USER COMPOSITION</main>";
    await writeFile(indexPath, custom);

    await expect(prepareKouboProject(job, {
      duration: 6,
      now: fixedNow,
      forceIndex: true,
    })).rejects.toThrow("cannot replace a user-authored HyperFrames composition");

    expect(await readFile(indexPath, "utf8")).toBe(custom);
  });

  it("rejects an edit list owned by another project before changing its projection", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const editListPath = join(job, "edit-list.json");
    const editList = JSON.parse(await readFile(editListPath, "utf8"));
    editList.projectId = "another-project";
    const raw = `${JSON.stringify(editList, null, 2)}\n`;
    await writeFile(editListPath, raw);
    const indexBefore = await readFile(join(job, "index.html"), "utf8");

    await expect(materializeKouboEditListIndex(job, {
      expectedRevision: digest(raw),
    })).rejects.toThrow("belongs to project another-project, not fixture-job");
    expect(await readFile(join(job, "index.html"), "utf8")).toBe(indexBefore);
  });

  it("rejects an unsupported playback rate during prepare without partial writes", async () => {
    const job = await fixture();
    await prepareKouboProject(job, { duration: 6, now: fixedNow });
    const editListPath = join(job, "edit-list.json");
    const editList = JSON.parse(await readFile(editListPath, "utf8"));
    editList.segments[0].playbackRate = 1.2;
    await writeFile(editListPath, `${JSON.stringify(editList, null, 2)}\n`);
    const protectedPaths = [
      "transcript.json",
      "cut-selection.json",
      "edit-list.json",
      "index.html",
    ];
    const before = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));

    await expect(prepareKouboProject(job, {
      duration: 6,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
      refreshTranscript: true,
    })).rejects.toThrow("playbackRate must be 1");

    const after = await Promise.all(protectedPaths.map((path) =>
      readFile(join(job, path), "utf8")));
    expect(after).toEqual(before);
  });
});
