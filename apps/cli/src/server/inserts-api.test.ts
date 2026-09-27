import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts, createSubtitleDocument, parseEditListDocument, parseTranscriptWords, subtitleCueTimings } from "@video-workbench/core";
import { probeMedia, renderKouboProjectIndex } from "@video-workbench/koubo-adapter";
import { snapshotProjectFiles, projectFilesRevision, readProjectTransaction } from "../../../../packages/core/src/projectTransaction";
import { createMultisourceApi } from "./multisource-api";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function wav(seconds: number) {
  const rate = 16000, count = rate * seconds, bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return bytes;
}

/** A v1 audio-only project, as a real koubo project is before its first insert. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inserts-api-isolated-"))); roots.push(root);
  const directory = join(root, "target"); await mkdir(join(directory, "input"), { recursive: true });
  const voice = wav(4); await writeFile(join(directory, "input/source.wav"), voice);
  const source = { path: "input/source.wav", sha256: sha(voice), mediaKind: "audio" as const, duration: 4 };
  const word = (id: string, start: number, end: number, isGap = false) => ({ id, text: isGap ? "" : id, start, end, ...(isGap ? { isGap } : {}) });
  const transcript = { cues: [{ id: "cue", words: [word("w1", 0, 1), word("g1", 1, 1.6, true), word("w2", 1.6, 2.4), word("g2", 2.4, 3, true), word("w3", 3, 4)] }] };
  const transcriptRaw = json(transcript);
  const cutsRaw = json({ schemaVersion: 3, projectId: "target", cutWordIds: [], reasons: [], cutRanges: [], updatedAt: "2026-01-01" });
  const edit = buildEditListFromCuts({ projectId: "target", source: source.path, sourceDuration: 4, cutsRevision: sha(cutsRaw), transcriptRevision: sha(transcriptRaw), cutRanges: [] });
  const editRaw = json(edit);
  const subtitles = createSubtitleDocument("target", sha(transcriptRaw), parseTranscriptWords(transcript), edit);
  subtitles.cues = [{ id: "c1", wordIds: ["w1"], text: "一" }, { id: "c2", wordIds: ["w2"], text: "二" }, { id: "c3", wordIds: ["w3"], text: "三" }];
  const docs = {
    "project.json": json({ jobId: "target", title: "fixture", source, inputVideo: source.path, config: { aspectRatio: "4:3" } }),
    "workbench.json": json({ projectId: "target", sourceSha256: source.sha256 }),
    "transcript.json": transcriptRaw, "cut-selection.json": cutsRaw, "edit-list.json": editRaw, "subtitles.json": json(subtitles),
    "index.html": renderKouboProjectIndex({ title: "fixture", width: 320, height: 240, duration: edit.duration, videoSource: source.path, editList: edit, editListRevision: sha(editRaw) }),
  };
  for (const [name, content] of Object.entries(docs)) await writeFile(join(directory, name), content);
  // An imported clip with its own audio, laid out exactly as media-import leaves it.
  const clip = join(root, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x120:r=25:d=2", "-f", "lavfi", "-i", "sine=f=660:d=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  const bytes = await readFile(clip), assetId = sha(bytes), media = await probeMedia(clip);
  await mkdir(join(directory, ".chengfeng-videocut/media", assetId), { recursive: true });
  await writeFile(join(directory, ".chengfeng-videocut/media", assetId, "source.mp4"), bytes);
  await writeFile(join(directory, ".chengfeng-videocut/media", assetId, "manifest.json"), JSON.stringify({ schemaVersion: 1, assetId, sha256: assetId,
    bytes: bytes.length, duration: media.duration, width: 160, height: 120, frameRate: 25, codec: "h264", hasAudio: true }));
  const changes: string[] = [];
  const api = createMultisourceApi({ projectsDir: root, port: 12345, isBusy: async () => false, onChanged: id => changes.push(id) });
  async function call(body?: unknown, path = "/inserts") {
    const response = await api(new Request(`http://127.0.0.1:12345/api/v1/projects/target${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { host: "127.0.0.1:12345", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "127.0.0.1");
    if (!response) throw Error("Expected route");
    return { status: response.status, body: await response.json() };
  }
  const before = await snapshotProjectFiles(directory);
  const document = { schemaVersion: 1, projectId: "target", inserts: [{ id: "i1", afterWordId: "w1", assetId, sourceIn: 0, sourceOut: 1.5, fit: "contain" }] };
  return { directory, call, before, document, assetId, changes };
}

test("inserts plan without writes, commit migrates v1 and ripples subtitles, replay and rollback are exact", async () => {
  const f = await fixture();
  const empty = await f.call();
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ projectId: "target", exists: false, editListSchemaVersion: 1, layers: [], document: { inserts: [] } });
  expect(empty.body.revision).toBe(projectFilesRevision(f.before));

  const input = { operationId: "insert-first", expectedRevision: empty.body.revision, document: f.document, confirmed: false };
  const plan = await f.call(input);
  expect(plan.status).toBe(200);
  expect(plan.body).toMatchObject({ committed: false, summary: { migratedToMultisource: true, previousDuration: 4, duration: 5.5,
    inserts: [{ id: "i1", afterWordText: "w1", timelineStart: 1.3, duration: 1.5 }] } });
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect(await readProjectTransaction(f.directory, input.operationId)).toBeNull();

  const commit = { ...input, confirmed: true, planRevision: plan.body.planRevision };
  const done = await f.call(commit);
  expect(done.body).toMatchObject({ committed: true, changed: true });
  expect(f.changes).toEqual(["target"]);
  const after = await snapshotProjectFiles(f.directory);
  const edl = parseEditListDocument(JSON.parse(after["edit-list.json"]!));
  expect(edl.schemaVersion).toBe(2);
  expect(edl.segments.map(s => [s.instanceId, s.timelineStart])).toEqual([["original", 0], [`insert:i1`, 1.3], ["original", 2.8]]);
  expect(edl.baseTranscriptRevision).toBe(sha(after["transcript.json"]!));
  expect(edl.baseCutsRevision).toBe(sha(after["cut-selection.json"]!));
  expect(JSON.parse(after["inserts.json"]!)).toEqual(f.document);
  expect(after["index.html"]).toContain(sha(after["edit-list.json"]!));
  const words = parseTranscriptWords(JSON.parse(after["transcript.json"]!));
  const timings = subtitleCueTimings(JSON.parse(after["subtitles.json"]!), words, edl);
  expect(timings.map(t => [t.cueId, Math.round(t.start * 1e6) / 1e6])).toEqual([["c1", 0], ["c2", 3.1], ["c3", 4.5]]);
  const read = await f.call();
  expect(read.body).toMatchObject({ exists: true, editListSchemaVersion: 2, revision: done.body.revision,
    layers: [{ layerId: "insert:i1", start: 1.3, end: 2.8, media: { assetId: f.assetId, muted: true } }] });

  expect((await f.call(commit)).body).toMatchObject({ changed: false, committed: true });
  expect((await f.call({ ...commit, document: { ...f.document, inserts: [] } })).body.error.code).toBe("operation_id_conflict");

  // Resubmitting the same document on the new revision is a no-op rebuild, not a second clip.
  const again = await f.call({ operationId: "insert-again", expectedRevision: done.body.revision, document: f.document, confirmed: false });
  expect(again.body.afterRevision).toBe(done.body.revision);

  expect((await f.call({ confirmed: true, action: "rollback" }, `/sources/operations/${input.operationId}`)).body.state).toBe("rolled_back");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
}, 30000);

test("inserts reject stale revisions, unimported media, cut anchors and anchors inside a subtitle cue", async () => {
  const f = await fixture();
  const revision = projectFilesRevision(f.before);
  const plan = (document: unknown, expectedRevision = revision) => f.call({ operationId: "bad", expectedRevision, document, confirmed: false });
  expect((await plan(f.document, "0".repeat(64))).body.error.code).toBe("revision_conflict");
  expect((await plan({ ...f.document, inserts: [{ ...f.document.inserts[0], assetId: "c".repeat(64) }] })).body.error.message).toMatch(/not imported/);
  expect((await plan({ ...f.document, inserts: [{ ...f.document.inserts[0], afterWordId: "g1" }] })).body.error.message).toMatch(/not a spoken word/);
  expect((await plan({ ...f.document, inserts: [{ ...f.document.inserts[0], gainDb: 4 }] })).body.error.message).toMatch(/gainDb/);
  const subtitles = JSON.parse(f.before["subtitles.json"]!);
  subtitles.cues = [{ id: "c12", wordIds: ["w1", "w2"], text: "一二" }, { id: "c3", wordIds: ["w3"], text: "三" }];
  await writeFile(join(f.directory, "subtitles.json"), json(subtitles));
  const merged = projectFilesRevision(await snapshotProjectFiles(f.directory));
  expect((await plan(f.document, merged)).body.error.message).toMatch(/inside subtitle cue c12/);
  expect(await readProjectTransaction(f.directory, "bad")).toBeNull();
}, 30000);

test("after inserts, word cuts and restores still work from the transcript and keep every clip", async () => {
  const { resolveProject, writeCutSelectionWithEditList } = await import("@video-workbench/core/node");
  const f = await fixture();
  const plan = await f.call({ operationId: "insert-then-cut", expectedRevision: projectFilesRevision(f.before), document: f.document, confirmed: false });
  await f.call({ operationId: "insert-then-cut", expectedRevision: projectFilesRevision(f.before), document: f.document, confirmed: true, planRevision: plan.body.planRevision });
  const read = async () => parseEditListDocument(JSON.parse(await readFile(join(f.directory, "edit-list.json"), "utf8")));
  expect((await read()).mode).toBe("cuts-derived");
  const project = await resolveProject(f.directory);
  const revision = async () => sha(await readFile(join(f.directory, "cut-selection.json"), "utf8"));

  await writeCutSelectionWithEditList(project, { cutWordIds: ["w2"] }, { expectedRevision: await revision(), mode: "full-selection" });
  const cut = await read();
  expect(cut.schemaVersion).toBe(2);
  expect(cut.segments.filter(s => s.instanceId === "insert:i1")).toHaveLength(1);
  expect(cut.duration).toBeCloseTo(5.5 - 0.8, 3);
  const cuts = JSON.parse(await readFile(join(f.directory, "cut-selection.json"), "utf8"));
  expect(cuts.cutRanges.every((r: any) => r.source === "input/source.wav" && r.instanceId === "original")).toBe(true);

  await writeCutSelectionWithEditList(project, { cutWordIds: [] }, { expectedRevision: await revision(), mode: "full-selection" });
  const restored = await read();
  expect(restored.duration).toBeCloseTo(5.5, 3);
  expect(restored.segments.map(s => s.instanceId)).toEqual(["original", "insert:i1", "original"]);

  // Cutting the anchor word moves the clip to the nearest word that still plays.
  const moved = await writeCutSelectionWithEditList(project, { cutWordIds: ["w1"] }, { expectedRevision: await revision(), mode: "full-selection" });
  expect(moved.movedInserts).toEqual([{ insertId: "i1", fromWordId: "w1", toWordId: "w2", toWordText: "w2" }]);
  expect(JSON.parse(await readFile(join(f.directory, "inserts.json"), "utf8")).inserts[0].afterWordId).toBe("w2");
  const followed = await read();
  expect(followed.segments.filter(s => s.instanceId === "insert:i1")).toHaveLength(1);
  const events = (await readFile(join(f.directory, "events.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  expect(events.at(-1)).toMatchObject({ type: "cuts_written", payload: { movedInserts: [{ insertId: "i1", toWordId: "w2" }] } });
}, 30000);

test("a cut on a hand-arranged timeline rebinds the timeline to the new cuts", async () => {
  const { resolveProject, writeCutSelectionWithEditList, patchEditList } = await import("@video-workbench/core/node");
  const f = await fixture();
  const project = await resolveProject(f.directory);
  const edlRev = async () => sha(await readFile(join(f.directory, "edit-list.json"), "utf8"));
  // Make the timeline manual by a hand trim, then cut a word the trim already removed (no carving needed).
  await patchEditList(project, { type: "trim", clipId: "a-roll-0001", sourceStart: 0, sourceEnd: 3.9 }, { expectedRevision: await edlRev() });
  const cutsRev = async () => sha(await readFile(join(f.directory, "cut-selection.json"), "utf8"));
  await writeCutSelectionWithEditList(project, { cutWordIds: ["g2"] }, { expectedRevision: await cutsRev(), mode: "full-selection" });
  const edl = parseEditListDocument(JSON.parse(await readFile(join(f.directory, "edit-list.json"), "utf8")));
  expect(edl.mode).toBe("manual");
  expect(edl.baseCutsRevision).toBe(await cutsRev());
}, 30000);
