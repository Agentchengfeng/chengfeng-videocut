/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_SUBTITLE_STYLE } from "@video-workbench/core";
import {
  createVideocutSubtitlesHandler,
  isVideocutSubtitlesRequest,
} from "./videocutSubtitlesApi";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

/** Four one-second words; the edit keeps 0-2 and 3-4, so w-3 is cut. */
async function createFixture(): Promise<{ projectsDir: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-subtitles-api-"));
  cleanupPaths.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "project.json"), JSON.stringify({ jobId: "demo" }));
  await writeFile(
    join(projectDir, "transcript.json"),
    JSON.stringify({
      schemaVersion: 1,
      cues: [{
        id: "cue-1",
        words: [
          { id: "w-1", text: "今", start: 0, end: 1 },
          { id: "w-2", text: "天", start: 1, end: 2 },
          { id: "w-3", text: "删", start: 2, end: 3 },
          { id: "w-4", text: "留", start: 3, end: 4 },
        ],
      }],
    }),
  );
  await writeFile(
    join(projectDir, "edit-list.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectId: "demo",
      sourceDuration: 4,
      baseCutsRevision: "a".repeat(64),
      baseTranscriptRevision: "b".repeat(64),
      mode: "cuts-derived",
      duration: 3,
      segments: [
        {
          id: "s-1",
          source: "input.mp4",
          sourceStart: 0,
          sourceEnd: 2,
          timelineStart: 0,
          trackId: "a-roll",
          playbackRate: 1,
        },
        {
          id: "s-2",
          source: "input.mp4",
          sourceStart: 3,
          sourceEnd: 4,
          timelineStart: 2,
          trackId: "a-roll",
          playbackRate: 1,
        },
      ],
    }),
  );
  return { projectsDir, projectDir };
}

function documentOf(cues: Array<{ id: string; wordIds: string[]; text: string }>) {
  return {
    schemaVersion: 1,
    projectId: "demo",
    baseTranscriptRevision: "t",
    style: {
      fontFamily: "sans-serif",
      fontSize: 5.4,
      fontWeight: 500,
      color: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 6,
      backgroundColor: "",
      anchor: "bottom",
      offsetY: 8,
      lineHeight: 1.3,
      maxLineWidth: 86,
    },
    cues,
  };
}

async function put(
  handler: (request: Request) => Promise<Response | null>,
  expectedRevision: string,
  document: unknown,
): Promise<Response> {
  const response = await handler(new Request("http://x/api/v1/projects/demo/subtitles", {
    method: "PUT",
    body: JSON.stringify({ expectedRevision, document }),
  }));
  if (!response) throw new Error("handler did not claim the route");
  return response;
}

describe("isVideocutSubtitlesRequest", () => {
  it("claims the subtitles route and nothing else", () => {
    expect(isVideocutSubtitlesRequest("GET", "/api/v1/projects/demo/subtitles")).toBe(true);
    expect(isVideocutSubtitlesRequest("GET", "/api/v1/projects/demo/cuts")).toBe(false);
    expect(isVideocutSubtitlesRequest("GET", "/api/v1/projects/demo")).toBe(false);
    expect(isVideocutSubtitlesRequest("POST", "/api/v1/projects/demo/subtitles/candidate")).toBe(true);
    expect(isVideocutSubtitlesRequest("POST", "/api/v1/projects/demo/subtitles/other")).toBe(false);
  });
});

describe("createVideocutSubtitlesHandler", () => {
  it("reports no document rather than failing when none was written yet", async () => {
    const { projectsDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const response = await handler(new Request("http://x/api/v1/projects/demo/subtitles"));
    const body = await response!.json();
    expect(response!.status).toBe(200);
    expect(body.exists).toBe(false);
    expect(body.revision).toBe("none");
    expect(body.document).toBeNull();
    expect(body.stale).toEqual([]);
  });

  it("writes a document and reports timing computed from the edit list", async () => {
    const { projectsDir, projectDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const response = await put(handler, "none", documentOf([
      { id: "sub-0001", wordIds: ["w-1", "w-2"], text: "今天" },
      { id: "sub-0002", wordIds: ["w-4"], text: "留" },
    ]));
    const body = await response.json();
    expect(body.changed).toBe(true);
    expect(body.timings[0]).toMatchObject({ cueId: "sub-0001", start: 0, end: 2 });
    // w-4 starts at source 3 with one second removed before it: timeline 2.
    expect(body.timings[1]).toMatchObject({ cueId: "sub-0002", start: 2, end: 3 });
    const stored = JSON.parse(await readFile(join(projectDir, "subtitles.json"), "utf8"));
    expect(stored.cues).toHaveLength(2);
  });

  it("names the exact screen the cut broke, never a blanket warning", async () => {
    const { projectsDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const body = await (await put(handler, "none", documentOf([
      { id: "sub-0001", wordIds: ["w-1", "w-2"], text: "今天" },
      { id: "sub-0002", wordIds: ["w-3"], text: "删" },
    ]))).json();
    expect(body.stale).toHaveLength(1);
    expect(body.stale[0]).toMatchObject({
      cueId: "sub-0002",
      index: 1,
      cutWordIds: ["w-3"],
      cutText: "删",
      orphaned: true,
    });
  });

  it("refuses a write whose expected revision is stale", async () => {
    const { projectsDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    await put(handler, "none", documentOf([{ id: "sub-0001", wordIds: ["w-1"], text: "今" }]));
    const conflict = await put(
      handler,
      "none",
      documentOf([{ id: "sub-0001", wordIds: ["w-1"], text: "改" }]),
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("revision_conflict");
  });

  it("refuses a document whose screens claim the same word twice", async () => {
    const { projectsDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const response = await put(handler, "none", documentOf([
      { id: "sub-0001", wordIds: ["w-1"], text: "今" },
      { id: "sub-0002", wordIds: ["w-1"], text: "今" },
    ]));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_subtitles");
  });

  it("refuses a document belonging to another project", async () => {
    const { projectsDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const response = await put(handler, "none", {
      ...documentOf([{ id: "sub-0001", wordIds: ["w-1"], text: "今" }]),
      projectId: "somewhere-else",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_subtitles");
  });

  it("rejects methods other than GET and PUT", async () => {
    const { projectsDir } = await createFixture();
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const response = await handler(new Request("http://x/api/v1/projects/demo/subtitles", {
      method: "DELETE",
    }));
    expect(response!.status).toBe(405);
  });

  it("accepts a version-bound candidate and keeps edits and notes available on readback", async () => {
    const { projectsDir, projectDir } = await createFixture();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const transcript = await readFile(join(projectDir, "transcript.json"), "utf8");
    const edl = JSON.parse(await readFile(join(projectDir, "edit-list.json"), "utf8"));
    edl.baseTranscriptRevision = sha(transcript);
    const edlContent = JSON.stringify(edl);
    await writeFile(join(projectDir, "edit-list.json"), edlContent);
    const documentContent = JSON.stringify({
      ...documentOf([{ id: "s1", wordIds: ["w-1", "w-2"], text: "今天" }, { id: "s2", wordIds: ["w-4"], text: "留" }]),
      style: DEFAULT_SUBTITLE_STYLE, baseTranscriptRevision: sha(transcript),
    }) + "\n";
    const receipt = {
      schemaVersion: 1, kind: "isolated-subtitle-candidate", productionCommitted: false,
      inputs: { projectId: "demo", transcriptSha256: sha(transcript), editListSha256: sha(edlContent), resultRevision: "none" },
      provenance: { generator: "test-skill", version: "1" }, outputSha256: sha(documentContent),
      validation: { valid: true, cueCount: 2, wordCount: 4 },
    };
    const handler = createVideocutSubtitlesHandler({ projectsDir });
    const post = (expectedRevision: string, candidateReceipt = receipt) => handler(new Request("http://x/api/v1/projects/demo/subtitles/candidate", {
      method: "POST", body: JSON.stringify({ documentContent, receipt: candidateReceipt, expectedRevision }),
    }));
    const accepted = await post("none");
    expect(accepted!.status).toBe(200);
    const first = await accepted!.json();
    expect(first.resultState.status).toBe("current");
    const edited = structuredClone(first.document); edited.cues[0].text = "审核后的今天";
    const save = await handler(new Request("http://x/api/v1/projects/demo/subtitles", {
      method: "PUT", body: JSON.stringify({ document: edited, expectedRevision: first.revision, reviewNote: "下次保留专名修正" }),
    }));
    expect(save!.status).toBe(200);
    const second = await save!.json();
    expect(second.document.cues[0].text).toBe("审核后的今天");
    expect(second.resultState.review.editCount).toBeGreaterThan(0);
    expect(second.resultState.review.noteCount).toBe(1);
    const beforeConflict = await readFile(join(projectDir, "subtitles.json"), "utf8");
    expect((await post("none"))!.status).toBe(409);
    expect(await readFile(join(projectDir, "subtitles.json"), "utf8")).toBe(beforeConflict);
    // A timing-only edit keeps the same word set but changes the source revision.
    edl.segments[0].sourceStart = 0.1; edl.segments[1].timelineStart = 1.9; edl.duration = 2.9;
    await writeFile(join(projectDir, "edit-list.json"), JSON.stringify(edl));
    const stale = await handler(new Request("http://x/api/v1/projects/demo/subtitles"));
    const staleBody = await stale!.json();
    expect(staleBody.resultState.status).toBe("stale");
    expect(staleBody.resultState.changedSources).toEqual(["edit-list"]);
    expect(staleBody.stale).toHaveLength(0);
    const staleReceipt = { ...receipt, inputs: { ...receipt.inputs, resultRevision: second.revision } };
    expect((await post(second.revision, staleReceipt))!.status).toBe(409);
    expect(await readFile(join(projectDir, "subtitles.json"), "utf8")).toBe(beforeConflict);
  });

  it.each(["POST", "PUT"])("reports a committed %s with its revision when derived readback fails", async (method) => {
    const { projectsDir, projectDir } = await createFixture();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const transcript = await readFile(join(projectDir, "transcript.json"), "utf8");
    const edl = JSON.parse(await readFile(join(projectDir, "edit-list.json"), "utf8"));
    edl.baseTranscriptRevision = sha(transcript);
    const edlContent = JSON.stringify(edl);
    await writeFile(join(projectDir, "edit-list.json"), edlContent);
    const document = {
      ...documentOf([{ id: "s1", wordIds: ["w-1", "w-2"], text: "审核后的今天" }, { id: "s2", wordIds: ["w-4"], text: "留" }]),
      style: DEFAULT_SUBTITLE_STYLE, baseTranscriptRevision: sha(transcript),
    };
    const previousContent = JSON.stringify({ ...document, cues: [{ ...document.cues[0], text: "今天" }, document.cues[1]] });
    await writeFile(join(projectDir, "subtitles.json"), previousContent);
    const previousRevision = sha(previousContent);
    const documentContent = JSON.stringify(document) + "\n";
    const receipt = {
      schemaVersion: 1, kind: "isolated-subtitle-candidate", productionCommitted: false,
      inputs: { projectId: "demo", transcriptSha256: sha(transcript), editListSha256: sha(edlContent), resultRevision: previousRevision },
      provenance: { generator: "test-skill", version: "1" }, outputSha256: sha(documentContent),
      validation: { valid: true, cueCount: 2, wordCount: 4 },
    };
    const handler = createVideocutSubtitlesHandler({
      projectsDir,
      // Deterministically inject an input-read failure after persistence, not
      // before candidate validation or the project-lock CAS checks.
      onDocumentChanged: async () => { await writeFile(join(projectDir, "edit-list.json"), "{"); },
    });
    const response = await handler(new Request(`http://x/api/v1/projects/demo/subtitles${method === "POST" ? "/candidate" : ""}`, {
      method,
      body: JSON.stringify(method === "POST"
        ? { expectedRevision: previousRevision, documentContent, receipt }
        : { expectedRevision: previousRevision, document }),
    }));
    expect(response!.status).toBe(503);
    const body = await response!.json();
    const active = await readFile(join(projectDir, "subtitles.json"), "utf8");
    expect(body.error.code).toBe("write_committed_readback_failed");
    expect(body.error.details).toEqual({ committed: true, revision: sha(active), previousRevision, causeCode: "invalid_json" });
    expect(body.error.message).toContain("Do not retry");
    expect(body.timings).toBeUndefined();
    expect(body.resultState).toBeUndefined();
    expect(JSON.parse(active).cues[0].text).toBe("审核后的今天");
    expect(await readFile(join(projectDir, ".workbench/result-history/subtitles", `${previousRevision}.json`), "utf8")).toBe(previousContent);
    // The caller can recover the response through GET without resubmitting.
    await writeFile(join(projectDir, "edit-list.json"), edlContent);
    const reopened = await handler(new Request("http://x/api/v1/projects/demo/subtitles"));
    expect(reopened!.status).toBe(200);
    expect((await reopened!.json()).revision).toBe(sha(active));
  });
});
