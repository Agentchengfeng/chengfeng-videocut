import { describe, expect, test, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts, createSubtitleDocument, parseEditListDocument, parseTranscriptWords, subtitleCueTimings } from "@video-workbench/core";
import { renderKouboProjectIndex } from "@video-workbench/koubo-adapter";
import { assertProjectReadable, commitProjectTransaction, recoverProjectTransaction, readProjectTransaction, snapshotProjectFiles,
  projectFilesRevision, TRANSACTION_MARKER, type ProjectTransaction } from "../../../../packages/core/src/projectTransaction";
import { buildPrependDocuments, createMultisourceApi } from "./multisource-api";
import { resolveProject, writeCutSelection, writeCutSelectionWithEditList } from "@video-workbench/core/node";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Real uncompressed PCM WAV, no external fixture media or running server. */
function wav(rate: number, duration: number, frequency: number): Buffer {
  const count = Math.round(rate * duration), data = Buffer.alloc(44 + count * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return data;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "multisource-api-isolated-"))); roots.push(root);
  for (const [id, rate, duration, frequency] of [["target", 44100, 2, 440], ["source", 32000, 1, 880]] as const) {
    const directory = join(root, id); await mkdir(join(directory, "input"), { recursive: true });
    const bytes = wav(rate, duration, frequency), source = { path: "input/source.wav", sha256: sha(bytes), mediaKind: "audio", duration };
    await writeFile(join(directory, source.path), bytes);
    const transcript = { cues: [{ id: "cue0", words: [{ id: "w0", start: 0, end: 0.5, text: id === "target" ? "人工修字" : "新头" }] }] };
    const transcriptRaw = json(transcript), cutsRaw = json({ schemaVersion: 1, projectId: id, cutWordIds: [], reasons: [], cutRanges: [] });
    const edit = buildEditListFromCuts({ projectId: id, source: source.path, sourceDuration: duration,
      cutsRevision: sha(cutsRaw), transcriptRevision: sha(transcriptRaw), cutRanges: [] });
    const editRaw = json(edit);
    const docs: Record<string, string> = {
      "project.json": json({ jobId: id, title: id, source, inputVideo: source.path }),
      "workbench.json": json({ projectId: id, sourceSha256: source.sha256 }),
      "transcript.json": transcriptRaw, "cut-selection.json": cutsRaw, "edit-list.json": editRaw,
      "index.html": renderKouboProjectIndex({ title: id, width: 320, height: 240, duration, videoSource: source.path, editList: edit, editListRevision: sha(editRaw) }),
    };
    if (id === "target") {
      const subtitles = createSubtitleDocument(id, sha(transcriptRaw), parseTranscriptWords(transcript), edit);
      subtitles.cues = [{ id: "manual-caption", wordIds: ["w0"], text: "保留手工字幕" }];
      docs["subtitles.json"] = json(subtitles);
    }
    for (const [name, content] of Object.entries(docs)) await writeFile(join(directory, name), content);
  }
  const target = join(root, "target"), source = join(root, "source");
  const changes: string[] = [];
  const api = createMultisourceApi({ projectsDir: root, port: 12345, isBusy: async () => false, onChanged: id => changes.push(id) });
  async function call(id = "target", body?: unknown, operation = "") {
    const response = await api(new Request(`http://127.0.0.1:12345/api/v1/projects/${id}/sources${operation}`, {
      method: body === undefined ? "GET" : "POST", headers: { host: "127.0.0.1:12345", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "127.0.0.1");
    if (!response) throw new Error("Expected multisource route");
    return { status: response.status, body: await response.json() };
  }
  const beforeTarget = await snapshotProjectFiles(target), beforeSource = await snapshotProjectFiles(source);
  const input = { operationId: "prepend-once", sourceProjectId: "source", expectedTargetRevision: projectFilesRevision(beforeTarget), expectedSourceRevision: projectFilesRevision(beforeSource), confirmed: false };
  return { root, target, source, changes, call, beforeTarget, beforeSource, input };
}

describe("multisource prepend API, isolated real WAV projects", () => {
  test("legacy semantic Cuts writers reject v2 without altering either source or ledger", async () => {
    const f = await fixture(); const plan = await f.call("target", f.input);
    expect((await f.call("target", { ...f.input, confirmed: true, planRevision: plan.body.planRevision })).status).toBe(200);
    const before = await snapshotProjectFiles(f.target), project = await resolveProject(f.target);
    for (const write of [writeCutSelection, writeCutSelectionWithEditList]) {
      await expect(write(project, { cutWordIds: ["w0"] }, { expectedRevision: sha(before["cut-selection.json"]!) })).rejects.toThrow("instance-aware");
      expect(await snapshotProjectFiles(f.target)).toEqual(before);
      expect(await snapshotProjectFiles(f.source)).toEqual(f.beforeSource);
    }
  }, 20000);
  test("rejects malformed bodies and misbound project identities without writes", async () => {
    const f = await fixture();
    for (const body of [null, [], { ...f.input, sourceProjectId: 12 }, { ...f.input, operationId: undefined }, { ...f.input, unexpected: "x".repeat(9000) }]) {
      expect((await f.call("target", body)).status).toBe(400);
      expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
    }
    await writeFile(join(f.source, "project.json"), json({ ...JSON.parse(f.beforeSource["project.json"]!), jobId: "somebody-else" }));
    expect((await f.call("source")).status).toBe(400);
    expect((await f.call("target", f.input)).status).toBe(400);
    expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
  });

  test("validates merged subtitle IDs and v2 word identities before publication", async () => {
    const f = await fixture();
    const targetSubs = JSON.parse(f.beforeTarget["subtitles.json"]!);
    targetSubs.cues[0].id = "import-collision:caption";
    const sourceSubs = { ...targetSubs, projectId: "source", baseTranscriptRevision: sha(f.beforeSource["transcript.json"]!), cues: [{ id: "caption", wordIds: ["w0"], text: "新头" }] };
    const target = { ...f.beforeTarget, "subtitles.json": json(targetSubs) };
    const source = { ...f.beforeSource, "subtitles.json": json(sourceSubs) };
    expect(() => buildPrependDocuments(target, source, "collision")).toThrow("not unique");
    const built = buildPrependDocuments(f.beforeTarget, f.beforeSource, "first");
    const transcript = JSON.parse(built.after["transcript.json"]!);
    delete transcript.cues[0].words[0].instanceId;
    const raw = json(transcript), revision = sha(raw);
    const edl = JSON.parse(built.after["edit-list.json"]!); edl.baseTranscriptRevision = revision;
    const subtitles = JSON.parse(built.after["subtitles.json"]!); subtitles.baseTranscriptRevision = revision;
    const malformed = { ...built.after, "transcript.json": raw, "edit-list.json": json(edl), "subtitles.json": json(subtitles) };
    expect(() => buildPrependDocuments(malformed, f.beforeSource, "second")).toThrow("instance identity");
  });

  test("rolled-back operation cannot be silently replayed", async () => {
    const f = await fixture(); const plan = await f.call("target", f.input);
    const input = { ...f.input, confirmed: true, planRevision: plan.body.planRevision };
    expect((await f.call("target", input)).status).toBe(200);
    expect((await f.call("target", undefined, `/operations/${f.input.operationId}`)).body.state).toBe("committed");
    const recovered = await f.call("target", { confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`);
    expect(recovered.status).toBe(200); expect(recovered.body.state).toBe("rolled_back");
    expect((await f.call("target", input)).body.error.code).toBe("operation_replay_stale");
    expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
  }, 20000);

  test("pure transform preserves source docs and old captions while namespacing same word IDs", async () => {
    const f = await fixture(); const targetBefore = json(f.beforeTarget), sourceBefore = json(f.beforeSource);
    const built = buildPrependDocuments(f.beforeTarget, f.beforeSource, "pure");
    expect(json(f.beforeTarget)).toBe(targetBefore); expect(json(f.beforeSource)).toBe(sourceBefore);
    expect(built.summary).toMatchObject({ addedDuration: 1, duration: 3, sourceCount: 2, newNarrationHasSubtitles: false, retainedSubtitleScreens: 1 });
    const edl = parseEditListDocument(JSON.parse(built.after["edit-list.json"]!));
    expect(edl.schemaVersion).toBe(2); expect(edl.sources).toHaveLength(2);
    expect(edl.segments.map(s => [s.sourceStart, s.sourceEnd, s.timelineStart, s.instanceId])).toEqual([[0, 1, 0, "import-pure"], [0, 2, 1, "original"]]);
    const words = parseTranscriptWords(JSON.parse(built.after["transcript.json"]!));
    expect(words.map(w => [w.id, w.sourceWordId, w.instanceId])).toEqual([["import-pure:w0", "w0", "import-pure"], ["w0", "w0", "original"]]);
    expect(words[0]!.source).not.toBe(words[1]!.source);
    const subtitles = JSON.parse(built.after["subtitles.json"]!);
    expect(subtitles.cues).toEqual(JSON.parse(f.beforeTarget["subtitles.json"]!).cues);
    expect(subtitleCueTimings(subtitles, words, edl)[0]).toMatchObject({ start: 1, end: 1.5, orphaned: false });
    expect(built.after["visuals.json"]).toBeNull();
  });

  test("GET, preview, exact confirmation, replay and changed-input rejection preserve original bytes and backup", async () => {
    const f = await fixture(), originalSource = await readFile(join(f.source, "input/source.wav"));
    const originalTarget = await readFile(join(f.target, "input/source.wav"));
    expect((await f.call()).body.revision).toBe(f.input.expectedTargetRevision);
    expect((await f.call("source")).body.revision).toBe(f.input.expectedSourceRevision);
    const planned = await f.call("target", f.input);
    expect(planned.status).toBe(200); expect(planned.body).toMatchObject({ committed: false, addedDuration: 1, duration: 3 });
    expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
    expect(await readProjectTransaction(f.target, f.input.operationId)).toBeNull();
    const confirmed = { ...f.input, confirmed: true, planRevision: planned.body.planRevision };
    const result = await f.call("target", confirmed);
    expect(result.status).toBe(200); expect(result.body.changed).toBe(true);
    const after = await snapshotProjectFiles(f.target), edl = parseEditListDocument(JSON.parse(after["edit-list.json"]!));
    expect(edl.schemaVersion).toBe(2); expect(edl.duration).toBe(3); expect(edl.sourceDuration).toBe(2);
    const importedPath = edl.segments[0]!.source;
    expect(await readFile(join(f.target, importedPath))).toEqual(originalSource);
    expect(await readFile(join(f.source, "input/source.wav"))).toEqual(originalSource);
    expect(await readFile(join(f.target, "input/source.wav"))).toEqual(originalTarget);
    expect(await snapshotProjectFiles(f.source)).toEqual(f.beforeSource);
    const record = await readProjectTransaction(f.target, f.input.operationId);
    expect(record?.before).toEqual(f.beforeTarget); expect(record?.after).toEqual(after);
    await expect(assertProjectReadable(f.target)).resolves.toBeUndefined();
    expect((await f.call("target", undefined, `/operations/${f.input.operationId}`)).body.afterRevision).toBe(projectFilesRevision(after));
    const replay = await f.call("target", confirmed);
    expect(replay.status).toBe(200); expect(replay.body.changed).toBe(false);
    expect(await snapshotProjectFiles(f.target)).toEqual(after); expect(f.changes).toEqual(["target"]);
    const conflict = await f.call("target", { ...confirmed, expectedSourceRevision: "0".repeat(64) });
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe("operation_id_conflict");
    expect(await snapshotProjectFiles(f.target)).toEqual(after);
  }, 20000);

  test("wrong target/source CAS and wrong plan do not publish any project documents", async () => {
    const f = await fixture();
    for (const patch of [{ expectedTargetRevision: "0".repeat(64) }, { expectedSourceRevision: "0".repeat(64) }, { confirmed: true, planRevision: "0".repeat(64) }]) {
      const result = await f.call("target", { ...f.input, ...patch });
      expect(result.status).toBe(409); expect(result.body.error.code).toBe("revision_conflict");
      expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
      expect(await snapshotProjectFiles(f.source)).toEqual(f.beforeSource);
      expect(await readProjectTransaction(f.target, f.input.operationId)).toBeNull();
    }
    expect(f.changes).toEqual([]);
  }, 20000);

  test("same source imported twice reuses bytes but gets independent instance and word identities", async () => {
    const f = await fixture();
    const firstPlan = await f.call("target", f.input);
    const firstInput = { ...f.input, confirmed: true, planRevision: firstPlan.body.planRevision };
    expect((await f.call("target", firstInput)).status).toBe(200);
    const secondInput = { ...f.input, operationId: "prepend-again", expectedTargetRevision: (await f.call()).body.revision };
    const secondPlan = await f.call("target", secondInput);
    expect(secondPlan.status).toBe(200);
    expect((await f.call("target", { ...secondInput, confirmed: true, planRevision: secondPlan.body.planRevision })).status).toBe(200);
    const files = await snapshotProjectFiles(f.target), edl = parseEditListDocument(JSON.parse(files["edit-list.json"]!));
    expect(edl.sources).toHaveLength(2); expect(edl.duration).toBe(4);
    expect(edl.segments.map(s => s.instanceId)).toEqual(["import-prepend-again", "import-prepend-once", "original"]);
    expect(edl.segments[0]!.source).toBe(edl.segments[1]!.source);
    const words = parseTranscriptWords(JSON.parse(files["transcript.json"]!));
    expect(new Set(words.map(w => w.id)).size).toBe(3);
    expect(words.map(w => w.sourceWordId)).toEqual(["w0", "w0", "w0"]);
    expect(subtitleCueTimings(JSON.parse(files["subtitles.json"]!), words, edl)[0]).toMatchObject({ start: 2, end: 2.5, orphaned: false });
    const stale = await f.call("target", firstInput);
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("operation_replay_stale");
    expect(await snapshotProjectFiles(f.target)).toEqual(files);
    expect(await snapshotProjectFiles(f.source)).toEqual(f.beforeSource);
  }, 20000);

  test("source revision or media byte changes after preview cannot activate the plan", async () => {
    const f = await fixture(); const plan = await f.call("target", f.input);
    const confirmed = { ...f.input, confirmed: true, planRevision: plan.body.planRevision };
    await writeFile(join(f.source, "transcript.json"), f.beforeSource["transcript.json"]! + "\n");
    const changedRevision = await f.call("target", confirmed);
    expect(changedRevision.status).toBe(409); expect(changedRevision.body.error.code).toBe("revision_conflict");
    expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
    // Restore only this temp fixture document to isolate media-only tampering.
    await writeFile(join(f.source, "transcript.json"), f.beforeSource["transcript.json"]!);
    await writeFile(join(f.source, "input/source.wav"), wav(32000, 1, 990));
    const changedMedia = await f.call("target", confirmed);
    expect(changedMedia.status).toBe(400); expect(changedMedia.body.error.message).toContain("SHA-256");
    expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
    expect(await readProjectTransaction(f.target, f.input.operationId)).toBeNull();
    expect(f.changes).toEqual([]);
  }, 20000);
});

describe("project transaction interrupted publication", () => {
  async function interrupted() {
    const f = await fixture();
    const after = buildPrependDocuments(f.beforeTarget, f.beforeSource, "interrupted").after;
    const record: ProjectTransaction = { schemaVersion: 1, operationId: "interrupted", inputKey: sha("frozen-input"), before: f.beforeTarget, after };
    await expect(commitProjectTransaction(f.target, record, async name => { if (name === "transcript.json") throw new Error("injected afterWrite interruption"); })).rejects.toThrow("injected afterWrite");
    expect((await snapshotProjectFiles(f.target))["transcript.json"]).toBe(after["transcript.json"]);
    expect((await snapshotProjectFiles(f.target))["edit-list.json"]).toBe(f.beforeTarget["edit-list.json"]);
    expect(JSON.parse(await readFile(join(f.target, TRANSACTION_MARKER), "utf8"))).toMatchObject({ operationId: record.operationId });
    await expect(assertProjectReadable(f.target)).rejects.toThrow("incomplete multi-file transaction");
    const get = await f.call(); expect(get.status).toBe(409); expect(get.body.error.code).toBe("operation_in_progress");
    return { ...f, record };
  }

  test("marker blocks readers; explicit rollback restores exact bytes including absent files", async () => {
    const f = await interrupted();
    const recovered = await recoverProjectTransaction(f.target, f.record.operationId, "rollback");
    expect(recovered.state).toBe("rolled_back"); expect(recovered.revision).toBe(f.input.expectedTargetRevision);
    expect(await snapshotProjectFiles(f.target)).toEqual(f.beforeTarget);
    await expect(assertProjectReadable(f.target)).resolves.toBeUndefined();
    expect((await readProjectTransaction(f.target, f.record.operationId))?.before).toEqual(f.beforeTarget);
    expect(await snapshotProjectFiles(f.source)).toEqual(f.beforeSource);
  });

  test("recovery refuses unknown external edits and retains marker plus journal", async () => {
    const f = await interrupted();
    await writeFile(join(f.target, "workbench.json"), json({ foreignEdit: "must survive" }));
    const foreign = await snapshotProjectFiles(f.target);
    for (const action of ["rollback", "finish"] as const) {
      await expect(recoverProjectTransaction(f.target, f.record.operationId, action)).rejects.toThrow("Unexpected file changed");
      expect(await snapshotProjectFiles(f.target)).toEqual(foreign);
      await expect(assertProjectReadable(f.target)).rejects.toThrow();
    }
    expect(await readProjectTransaction(f.target, f.record.operationId)).toEqual(f.record);
  });
});
