import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareKouboProject } from "./project";

const cleanup: string[] = [];
const fixedNow = () => new Date("2026-07-16T00:00:00.000Z");

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

describe("prepareKouboProject natural-pause migration", () => {
  it("is byte-for-byte repeatable across refreshes", async () => {
    const job = await fixture();
    const options = { duration: 6, now: fixedNow };
    await prepareKouboProject(job, options);
    const paths = [
      "transcript.json",
      "cut-selection.json",
      "剪口播/3_审核/natural_pause_plan.json",
    ];
    const before = await Promise.all(paths.map(async (path) =>
      digest(await readFile(join(job, path), "utf8"))));

    await prepareKouboProject(job, {
      ...options,
      now: () => new Date("2026-07-17T08:00:00.000Z"),
      refreshTranscript: true,
    });
    const after = await Promise.all(paths.map(async (path) =>
      digest(await readFile(join(job, path), "utf8"))));

    expect(after).toEqual(before);
    const plan = JSON.parse(await readFile(join(job, paths[2]), "utf8"));
    expect(plan.summary).toMatchObject({ pausesCompressed: 1, explicitGapsDeleted: 0 });
    expect(plan.summary.totalDeletedSeconds).toBe(3.3);
    await expect(readFile(join(job, "visual-plan.json"), "utf8")).rejects.toThrow();
  });

  it("replays exact user additions and removals instead of guessing from parent gap ids", async () => {
    const job = await fixture();
    const options = { duration: 6, now: fixedNow };
    await prepareKouboProject(job, options);
    const path = join(job, "cut-selection.json");
    const selection = JSON.parse(await readFile(path, "utf8"));
    const retainedGap = selection.initialization.baselineCutWordIds.includes("gap-1")
      ? "gap-1__part_4300_4580"
      : "gap-1";
    selection.cutWordIds = [retainedGap];
    selection.cutRanges = [{ start: 4.3, end: 4.58 }];
    await writeFile(path, `${JSON.stringify(selection, null, 2)}\n`);

    await prepareKouboProject(job, { ...options, refreshTranscript: true });
    const refreshed = JSON.parse(await readFile(path, "utf8"));
    expect(refreshed.cutWordIds).toEqual([retainedGap]);
    expect(refreshed.initialization.baselineCutWordIds).toEqual(["gap-1"]);
  });

  it("does not promote a derived split id into deletion of the whole source gap", async () => {
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
    expect(plan.summary).toMatchObject({ pausesCompressed: 1, explicitGapsDeleted: 0 });
    expect(plan.deleteSegments).toEqual([{ start: 1, end: 4.3 }]);
  });
});
