import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@video-workbench/core/node";
import { createVideocutReviewPassesHandler } from "./videocutReviewPassesApi";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fixture(options: { artifact?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "videocut-review-passes-"));
  cleanup.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  await mkdir(projectDir, { recursive: true });
  const projectRaw = json({ jobId: "demo" });
  const transcriptRaw = json({
    schemaVersion: 1,
    cues: [{
      id: "cue-1",
      start: 0,
      end: 4,
      words: [
        { id: "w-1", text: "我", start: 0, end: 1, isGap: false },
        { id: "w-2", text: "看", start: 1, end: 2, isGap: false },
        { id: "w-3", text: "我", start: 2, end: 3, isGap: false },
        { id: "w-4", text: "看", start: 3, end: 4, isGap: false },
      ],
    }],
  });
  const cutsRaw = json({ cutWordIds: [] });
  const editListRaw = json({ schemaVersion: 1, projectId: "demo", segments: [] });
  await Promise.all([
    writeFile(join(projectDir, "project.json"), projectRaw),
    writeFile(join(projectDir, "transcript.json"), transcriptRaw),
    writeFile(join(projectDir, "cut-selection.json"), cutsRaw),
    writeFile(join(projectDir, "edit-list.json"), editListRaw),
  ]);
  if (options.artifact !== false) {
    await writeFile(join(projectDir, "review-passes.json"), json({
      schemaVersion: 1,
      projectId: "demo",
      transcriptRevision: sha256(transcriptRaw),
      cutsRevision: sha256(cutsRaw),
      editListRevision: sha256(editListRaw),
      passes: [
        { kind: "repair", removedWordIds: ["w-1"] },
        {
          kind: "repeat",
          candidates: [{
            id: "repeat-1",
            kind: "repeat",
            decision: "listen_then_decide",
            removeWordIds: ["w-2"],
            keepWordIds: ["w-3", "w-4"],
            reason: "保留后一段完整表达",
          }],
        },
      ],
    }));
  }
  return { projectsDir, projectDir };
}

function request(): Request {
  return new Request("http://localhost/api/v1/projects/demo/review-passes");
}

describe("videocut review-passes API", () => {
  it("returns current second-pass candidates without mutating product documents", async () => {
    const { projectsDir } = await fixture();
    const handler = createVideocutReviewPassesHandler({ projectsDir });
    const response = await handler(request());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      state: "current",
      removedWordIds: ["w-1"],
      candidates: [{
        id: "repeat-1",
        decision: "listen_then_decide",
        removeWordIds: ["w-2"],
        keepWordIds: ["w-3", "w-4"],
      }],
    });
  });

  it("keeps presenting candidates after the timeline is edited", async () => {
    // The candidates exist to be reviewed against the timeline, so editing the
    // timeline must not throw them away. Word-level conclusions — this word is a
    // stumble, that one repeats a later take — cannot be invalidated by
    // rearranging which source ranges play.
    const { projectsDir, projectDir } = await fixture();
    await writeFile(join(projectDir, "edit-list.json"), json({ schemaVersion: 1, projectId: "demo", segments: ["changed"] }));
    const handler = createVideocutReviewPassesHandler({ projectsDir });
    const response = await handler(request());
    const payload = await response?.json() as { state: string; removedWordIds: string[]; candidates: unknown[] };
    expect(payload.state).toBe("current");
    expect(payload.removedWordIds.length).toBeGreaterThan(0);
    expect(payload.candidates.length).toBeGreaterThan(0);
  });

  it("goes stale when the cut selection changes", async () => {
    // Cuts still count: a candidate must not name a word that is already
    // deleted there.
    const { projectsDir, projectDir } = await fixture();
    await writeFile(join(projectDir, "cut-selection.json"), json({ schemaVersion: 3, cutWordIds: ["changed"], cutRanges: [] }));
    const handler = createVideocutReviewPassesHandler({ projectsDir });
    const response = await handler(request());
    expect(await response?.json()).toMatchObject({
      state: "stale",
      removedWordIds: [],
      candidates: [],
    });
  });

  it("reports a missing artifact as missing instead of inventing a candidate", async () => {
    const { projectsDir } = await fixture({ artifact: false });
    const handler = createVideocutReviewPassesHandler({ projectsDir });
    const response = await handler(request());
    expect(await response?.json()).toMatchObject({
      state: "missing",
      removedWordIds: [],
      candidates: [],
    });
  });

  it("rejects overlapping or duplicate second-pass candidates", async () => {
    const { projectsDir, projectDir } = await fixture();
    const artifact = JSON.parse(await readFile(join(projectDir, "review-passes.json"), "utf8"));
    artifact.passes[1].candidates.push({
      ...artifact.passes[1].candidates[0],
      id: "repeat-2",
    });
    await writeFile(join(projectDir, "review-passes.json"), json(artifact));
    const handler = createVideocutReviewPassesHandler({ projectsDir });
    const response = await handler(request());
    expect(await response?.json()).toMatchObject({
      state: "invalid",
      removedWordIds: [],
      candidates: [],
    });
  });
});
