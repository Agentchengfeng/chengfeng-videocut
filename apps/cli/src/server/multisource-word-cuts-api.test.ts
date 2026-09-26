import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditListFromCuts, createSubtitleDocument, parseEditListDocument, parseTranscriptWords, subtitleCueTimings } from "@video-workbench/core";
import { renderKouboProjectIndex } from "@video-workbench/koubo-adapter";
import { snapshotProjectFiles, projectFilesRevision, readProjectTransaction, commitProjectTransaction, TRANSACTION_MARKER } from "../../../../packages/core/src/projectTransaction";
import { createMultisourceApi, buildWordCutDocuments } from "./multisource-api";
import { createModuleApi } from "./module-api";
import type { ReviewedVisualReplacement } from "../../../../packages/core/src/multisourceWordCuts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function wav(rate: number, frequency: number) {
  const count = rate * 2, bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return bytes;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "multisource-word-cuts-isolated-"))); roots.push(root);
  const directory = join(root, "target"); await mkdir(join(directory, "input"), { recursive: true });
  const sources = [];
  for (const [path, rate, hz] of [["input/a.wav", 44100, 440], ["input/b.wav", 32000, 880]] as const) {
    const bytes = wav(rate, hz); await writeFile(join(directory, path), bytes);
    sources.push({ path, sha256: sha(bytes), mediaKind: "audio" as const, duration: 2 });
  }
  const original = (id: string, start: number, end: number) => ({ id, text: id, start, end, source: "input/a.wav", sourceWordId: id, instanceId: "original" });
  const transcript = { cues: [{ id: "cue", words: [
    { ...original("head", 0, .5), source: "input/b.wav", instanceId: "import", sourceWordId: "w0" },
    original("w0", .2, .6), original("w1", .6, 1), original("old-cut", 1.1, 1.3), original("w2", 1.4, 1.8),
  ] }] };
  const transcriptRaw = json(transcript), cuts = { schemaVersion: 3, projectId: "target", cutWordIds: ["old-cut"],
    reasons: [{ wordIds: ["old-cut"], kind: "repeat", risk: "high" }],
    cutRanges: [{ source: "input/a.wav", instanceId: "original", start: 1, end: 1.4 }], updatedAt: "2026-01-01" };
  const cutsRaw = json(cuts);
  const base = buildEditListFromCuts({ projectId: "target", source: "input/a.wav", sourceDuration: 2, cutsRevision: sha(cutsRaw), transcriptRevision: sha(transcriptRaw), cutRanges: [] });
  const edit = parseEditListDocument({ ...base, schemaVersion: 2, mode: "manual", sources, duration: 1.9, segments: [
    { ...base.segments[0], id: "head-segment", source: "input/b.wav", instanceId: "import", sourceStart: 0, sourceEnd: .5, timelineStart: 0 },
    { ...base.segments[0], id: "manual-one", instanceId: "original", sourceStart: .2, sourceEnd: 1, timelineStart: .5 },
    { ...base.segments[0], id: "manual-two", instanceId: "original", sourceStart: 1.4, sourceEnd: 2, timelineStart: 1.3 },
  ] });
  const editRaw = json(edit);
  const subtitles = createSubtitleDocument("target", sha(transcriptRaw), parseTranscriptWords(transcript), edit);
  subtitles.cues = ["head", "w0", "w1", "w2"].map(id => ({ id: `sub-${id}`, wordIds: [id], text: `人工 ${id}` }));
  const docs = {
    "project.json": json({ jobId: "target", title: "fixture", source: sources[0], inputVideo: sources[0]!.path, config: { aspectRatio: "4:3" } }),
    "workbench.json": json({ projectId: "target", sourceSha256: sources[0]!.sha256 }),
    "transcript.json": transcriptRaw, "cut-selection.json": cutsRaw, "edit-list.json": editRaw, "subtitles.json": json(subtitles),
    "index.html": renderKouboProjectIndex({ title: "fixture", width: 320, height: 240, duration: edit.duration, videoSource: sources[0]!.path, editList: edit, editListRevision: sha(editRaw) }),
  };
  for (const [name, content] of Object.entries(docs)) await writeFile(join(directory, name), content);
  let busy = false;
  const changes: string[] = [];
  const api = createMultisourceApi({ projectsDir: root, port: 12345, isBusy: async () => busy, onChanged: id => changes.push(id) });
  async function call(body?: unknown, suffix = "/word-cuts", client = "127.0.0.1") {
    const response = await api(new Request(`http://127.0.0.1:12345/api/v1/projects/target/sources${suffix}`, {
      method: body === undefined ? "GET" : "POST", headers: { host: "127.0.0.1:12345", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), client);
    if (!response) throw Error("Expected route");
    return { status: response.status, body: await response.json() };
  }
  const before = await snapshotProjectFiles(directory);
  const input = { operationId: "delete-original-word", expectedTargetRevision: projectFilesRevision(before), wordIds: ["w0"], confirmed: false };
  return { root, directory, call, before, input, changes, api, busy: (value: boolean) => { busy = value; } };
}

async function reviewedFixture(segment = false) {
  const f = await fixture();
  const originalIds = segment ? ["w0", "w1", "w2"] : ["w0", "w1"];
  const retainedIds = segment ? ["w2"] : ["w1"];
  const duration = .4;
  await writeFile(join(f.directory, "visuals.json"), json({ schemaVersion: 1, projectId: "target", baseTranscriptRevision: sha(f.before["transcript.json"]!), animationStyle: "xiaohei",
    layers: [{ id: "reviewed-layer", module: "modules/old.html", wordIds: originalIds,
      animation: { schemaVersion: 1, clock: "local0", authoredDuration: segment ? 1.2 : .8, anchorWordIds: originalIds } }] }));
  const html = Buffer.from('<!doctype html><div>Reviewed replacement</div>');
  const manifest = { schemaVersion: 1, moduleId: "reviewed", version: "v1", entry: "scene.html", files: [{ path: "scene.html", bytes: html.length, sha256: sha(html) }] };
  const moduleApi = createModuleApi(f.root, 12345);
  const response = await moduleApi(new Request("http://127.0.0.1:12345/api/v1/projects/target/module-packages", {
    method: "POST", headers: { host: "127.0.0.1:12345", "content-type": "application/json" }, body: JSON.stringify({ manifest, files: { "scene.html": html.toString("base64") } }),
  }), "127.0.0.1");
  expect(response?.status).toBe(200);
  const receipt = await response!.json();
  const replacement: ReviewedVisualReplacement = { layerId: "reviewed-layer", module: receipt.entryPath, expectedModuleDigest: receipt.digest, wordIds: retainedIds,
    animation: { schemaVersion: 1, clock: "local0", authoredDuration: duration, anchorWordIds: retainedIds } };
  const before = await snapshotProjectFiles(f.directory);
  const input = { operationId: "reviewed-delete", expectedTargetRevision: projectFilesRevision(before),
    ...(segment ? { clipIds: ["manual-one"] } : { wordIds: ["w0"] }), confirmed: false, reviewedVisualReplacements: [replacement] };
  return { ...f, before, input, replacement, suffix: segment ? "/segment-cuts" : "/word-cuts" };
}

for (const segment of [false, true]) test(`reviewed HTML ${segment ? "segment" : "word"} deletion plans without writes, commits, replays and rolls back atomically`, async () => {
  const f = await reviewedFixture(segment);
  const plan = await f.call(f.input, f.suffix);
  expect(plan.status).toBe(200); expect(plan.body.committed).toBe(false);
  expect(plan.body.deletion.reviewedVisualReplacements[0]).toMatchObject({ layerId: f.replacement.layerId, module: f.replacement.module });
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
  const commit = { ...f.input, confirmed: true, planRevision: plan.body.planRevision };
  const done = await f.call(commit, f.suffix);
  expect(done.status).toBe(200); expect(done.body.committed).toBe(true);
  const after = await snapshotProjectFiles(f.directory);
  expect(JSON.parse(after["visuals.json"]!).layers[0]).toMatchObject({ id: f.replacement.layerId, module: f.replacement.module,
    wordIds: f.replacement.wordIds, animation: f.replacement.animation });
  for (const name of ["project.json", "workbench.json", "transcript.json"] as const) expect(after[name]).toBe(f.before[name]);
  expect((await f.call(commit, f.suffix)).body).toMatchObject({ changed: false, committed: true });
  const changedReplacement = { ...f.replacement, expectedModuleDigest: "0".repeat(64) };
  expect((await f.call({ ...commit, reviewedVisualReplacements: [changedReplacement] }, f.suffix)).body.error.code).toBe("operation_id_conflict");
  expect((await f.call({ confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`)).body.state).toBe("rolled_back");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect((await f.call(commit, f.suffix)).body.error.code).toBe("operation_replay_stale");
}, 20000);

test("reviewed replacement failures return diagnostics and never alter active documents", async () => {
  const f = await reviewedFixture();
  const absent = await f.call({ ...f.input, reviewedVisualReplacements: undefined });
  expect(absent.body.error.details).toMatchObject({ reason: "partial_html_requires_reviewed_animation", layerId: "reviewed-layer",
    timings: { before: { start: .5, end: 1.3 }, expected: { start: .5, end: .9 } } });
  const patches = [
    { layerId: "other-layer" }, { wordIds: ["head"] }, { wordIds: ["w0", "w1"] },
    { animation: undefined }, { animation: { ...f.replacement.animation, authoredDuration: .7 } },
    { animation: { ...f.replacement.animation, anchorWordIds: ["w0"] } },
    { module: "modules/old.html" }, { module: "modules/published/missing/v1/scene.html" },
    { module: "modules/published/reviewed/v1/../scene.html" }, { expectedModuleDigest: "0".repeat(64) },
    { media: { assetId: "a".repeat(64) } },
  ];
  for (const patch of patches) {
    const bad = await f.call({ ...f.input, reviewedVisualReplacements: [{ ...f.replacement, ...patch }] });
    expect(bad.status).toBe(400); expect(bad.body.error.details.reason).toBeString();
    expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
    expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
  }
  for (const invalid of [null, [f.replacement, f.replacement], Array(33).fill(f.replacement)]) {
    expect((await f.call({ ...f.input, reviewedVisualReplacements: invalid })).status).toBe(400);
  }
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
});

test("reviewed replacements bind CAS, exact plan and immutable module bytes through commit", async () => {
  const f = await reviewedFixture();
  const plan = await f.call(f.input);
  expect(plan.status).toBe(200);
  expect((await f.call({ ...f.input, expectedTargetRevision: "0".repeat(64) })).body.error.code).toBe("revision_conflict");
  expect((await f.call({ ...f.input, confirmed: true, planRevision: "0".repeat(64) })).body.error.code).toBe("revision_conflict");
  await writeFile(join(f.directory, f.replacement.module), "tampered after plan");
  const failed = await f.call({ ...f.input, confirmed: true, planRevision: plan.body.planRevision });
  expect(failed.body.error.details.reason).toBe("replacement_module_invalid");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
});

test("gap absorption after an unrelated word deletion reports exact boundary diagnostics without writes", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "visuals.json"), json({ schemaVersion: 1, projectId: "target", baseTranscriptRevision: sha(f.before["transcript.json"]!), animationStyle: "xiaohei",
    layers: [{ id: "earlier-layer", module: "modules/earlier.html", wordIds: ["head"] },
      { id: "later-layer", module: "modules/later.html", wordIds: ["w2"] }] }));
  const before = await snapshotProjectFiles(f.directory);
  // The original .8s gap is not absorbed. Deleting w0 makes it .4s, which would
  // extend an untouched earlier HTML layer. Do not silently accept that drift.
  const result = await f.call({ ...f.input, expectedTargetRevision: projectFilesRevision(before) });
  expect(result.status).toBe(400);
  expect(result.body.error.details).toMatchObject({ reason: "visual_mapping_changed", layerId: "earlier-layer",
    directlyIntersectsCut: false, possibleGapAbsorption: true,
    timings: { before: { start: 0, end: .5, duration: .5 }, expected: { start: 0, end: .5, duration: .5 },
      actual: { start: 0, end: .9, duration: .9 }, delta: { start: 0, end: .4 } },
    nextActions: ["inspect_reported_visual_boundaries", "review_animation_mapping_before_replanning"] });
  expect(await snapshotProjectFiles(f.directory)).toEqual(before);
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
});

test("reviewed animation interruption recovers the recorded replacement without regeneration", async () => {
  for (const action of ["finish", "rollback"] as const) {
    const f = await reviewedFixture(true);
    const plan = await f.call(f.input, f.suffix);
    expect(plan.status).toBe(200);
    const built = buildWordCutDocuments(f.before, ["manual-one"], f.input.operationId, "segment-cuts", undefined, [f.replacement]);
    await expect(commitProjectTransaction(f.directory, { schemaVersion: 1, operationId: f.input.operationId, inputKey: "fixture", before: f.before, after: built.after }, async name => {
      if (name === "edit-list.json") throw Error("reviewed injected interruption");
    })).rejects.toThrow("reviewed injected interruption");
    expect((await f.call(undefined, "")).body.error.code).toBe("operation_in_progress");
    expect((await f.call(undefined, `/operations/${f.input.operationId}`)).body.state).toBe("interrupted");
    expect((await f.call({ confirmed: true, action }, `/operations/${f.input.operationId}`)).status).toBe(200);
    expect(await snapshotProjectFiles(f.directory)).toEqual(action === "finish" ? built.after : f.before);
    if (action === "finish") {
      expect(JSON.parse((await snapshotProjectFiles(f.directory))["visuals.json"]!).layers[0].module).toBe(f.replacement.module);
      expect((await f.call({ confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`)).status).toBe(200);
      expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
    }
  }
}, 20000);

test("tampered reviewed module blocks interrupted finish but does not block byte-exact rollback", async () => {
  const f = await reviewedFixture();
  expect((await f.call(f.input)).status).toBe(200);
  const built = buildWordCutDocuments(f.before, ["w0"], f.input.operationId, "word-cuts", undefined, [f.replacement]);
  await expect(commitProjectTransaction(f.directory, { schemaVersion: 1, operationId: f.input.operationId, inputKey: "fixture", before: f.before, after: built.after }, async name => {
    if (name === "visuals.json") throw Error("reviewed injected interruption");
  })).rejects.toThrow("reviewed injected interruption");
  const interrupted = await snapshotProjectFiles(f.directory);
  const journal = await readProjectTransaction(f.directory, f.input.operationId);
  await writeFile(join(f.directory, f.replacement.module), "tampered reviewed animation");
  const finish = await f.call({ confirmed: true, action: "finish" }, `/operations/${f.input.operationId}`);
  expect(finish.status).toBe(400);
  expect(finish.body.error.details).toMatchObject({ reason: "replacement_module_invalid", layerId: f.replacement.layerId });
  expect(await snapshotProjectFiles(f.directory)).toEqual(interrupted);
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toEqual(journal);
  expect((await f.call(undefined, `/operations/${f.input.operationId}`)).body.state).toBe("interrupted");
  expect((await f.call({ confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`)).status).toBe(200);
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  // Rollback restores active documents, not external changes to immutable assets.
  expect(await readFile(join(f.directory, f.replacement.module), "utf8")).toBe("tampered reviewed animation");
}, 20000);

test("v2 HTTP plan has no writes; exact confirmation preserves old cuts, original inputs and other instance", async () => {
  const f = await fixture(); const directoryNames = await readdir(f.directory);
  const media = await Promise.all(["a", "b"].map(n => readFile(join(f.directory, `input/${n}.wav`))));
  const planned = await f.call(f.input);
  expect(planned.status).toBe(200); expect(planned.body.committed).toBe(false);
  expect(planned.body.deletion.removedDuration).toBeCloseTo(.4);
  expect(planned.body.deletion.removedSubtitleIds).toEqual(["sub-w0"]);
  expect(planned.body.deletion.affectedInstances).toEqual([{ source: "input/a.wav", instanceId: "original" }]);
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect(await readdir(f.directory)).toEqual(directoryNames);
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
  const confirmed = { ...f.input, confirmed: true, planRevision: planned.body.planRevision };
  const committed = await f.call(confirmed);
  expect(committed.status).toBe(200); expect(committed.body).toMatchObject({ committed: true, changed: true, mode: "word-cuts" });
  const after = await snapshotProjectFiles(f.directory), edl = parseEditListDocument(JSON.parse(after["edit-list.json"]!));
  expect(edl.duration).toBeCloseTo(1.5); expect(edl.baseCutsRevision).toBe(sha(after["cut-selection.json"]!));
  expect(edl.segments[0]).toEqual(JSON.parse(f.before["edit-list.json"]!).segments[0]);
  expect(edl.segments.at(-1)).toMatchObject({ id: "manual-two", sourceStart: 1.4, sourceEnd: 2 });
  const cuts = JSON.parse(after["cut-selection.json"]!);
  expect(cuts.cutWordIds).toContain("old-cut"); expect(cuts.cutWordIds).toContain("w0");
  expect(cuts.reasons).toContainEqual(JSON.parse(f.before["cut-selection.json"]!).reasons[0]);
  expect(cuts.cutRanges).toContainEqual(JSON.parse(f.before["cut-selection.json"]!).cutRanges[0]);
  for (const name of ["project.json", "workbench.json", "transcript.json"] as const) expect(after[name]).toBe(f.before[name]);
  expect(await Promise.all(["a", "b"].map(n => readFile(join(f.directory, `input/${n}.wav`))))).toEqual(media);
  const subs = JSON.parse(after["subtitles.json"]!);
  expect(subs.cues).toEqual(JSON.parse(f.before["subtitles.json"]!).cues.filter((c: any) => c.id !== "sub-w0"));
  expect(subtitleCueTimings(subs, parseTranscriptWords(JSON.parse(after["transcript.json"]!)), edl).find(c => c.cueId === "sub-w1")?.start).toBeCloseTo(.5);
  expect(committed.body.restore).toMatchObject({ requiresCurrentRevision: projectFilesRevision(after), scope: "whole_transaction", subsequentEditsAllowed: false, redoSupported: false });
  expect((await f.call(confirmed)).body).toMatchObject({ changed: false, committed: true, revision: projectFilesRevision(after) });
  expect(f.changes).toEqual(["target"]);
  expect((await f.call({ ...confirmed, wordIds: ["w1"] })).body.error.code).toBe("operation_id_conflict");
  expect(await snapshotProjectFiles(f.directory)).toEqual(after);
  const rollback = await f.call({ confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`);
  expect(rollback.status).toBe(200); expect(rollback.body.state).toBe("rolled_back");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect((await f.call(confirmed)).body.error.code).toBe("operation_replay_stale");
  expect((await f.call({ confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`)).body.state).toBe("rolled_back");
}, 20000);

test("wrong CAS/plan, missing confirmation, unknown/duplicate/excess IDs never commit", async () => {
  const f = await fixture();
  for (const patch of [ { expectedTargetRevision: "0".repeat(64) }, { confirmed: true, planRevision: "0".repeat(64) }, { confirmed: undefined },
    { wordIds: ["unknown"] }, { wordIds: ["w0", "w0"] }, { wordIds: [] }, { wordIds: Array.from({ length: 501 }, (_, i) => `word${i}`) }, { arbitrary: true } ]) {
    const response = await f.call({ ...f.input, ...patch }); expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
    expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
  }
  expect(f.changes).toEqual([]);
});

test("body limits are route-specific, loopback only, and GET word-cuts is not a mutation", async () => {
  const f = await fixture();
  const bigId = "x".repeat(9000);
  const acceptedBody = await f.call({ ...f.input, wordIds: [bigId] });
  expect(acceptedBody.status).toBe(400); expect(acceptedBody.body.error.message).not.toBe("Request too large");
  const rejectedBody = await f.call({ ...f.input, wordIds: ["x".repeat(256 * 1024)] });
  expect(rejectedBody.body.error.message).toBe("Request too large");
  expect((await f.call({ ...f.input, wordIds: [bigId] }, "")).body.error.message).toBe("Request too large");
  expect((await f.call(f.input, "/word-cuts", "192.168.1.1")).status).toBe(403);
  expect((await f.call()).status).toBe(400);
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
});

test("busy, marker, stale document bindings and identity are fail-closed", async () => {
  const f = await fixture(); f.busy(true);
  expect((await f.call(f.input)).body.error.code).toBe("project_busy"); f.busy(false);
  await writeFile(join(f.directory, TRANSACTION_MARKER), "{}");
  expect((await f.call(f.input)).body.error.code).toBe("operation_in_progress");
  await rm(join(f.directory, TRANSACTION_MARKER));
  for (const name of ["transcript.json", "cut-selection.json"] as const) {
    await writeFile(join(f.directory, name), f.before[name]! + "\n");
    const changed = await snapshotProjectFiles(f.directory);
    expect((await f.call({ ...f.input, expectedTargetRevision: projectFilesRevision(changed) })).body.error.message).toContain("bind the current");
    await writeFile(join(f.directory, name), f.before[name]!);
  }
  await writeFile(join(f.directory, "project.json"), json({ ...JSON.parse(f.before["project.json"]!), jobId: "other" }));
  expect((await f.call(f.input)).body.error.message).toContain("identity");
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
});

test("media tampering after plan rejects commit and rollback rejects subsequent external edit", async () => {
  const f = await fixture(), plan = await f.call(f.input);
  const confirmed = { ...f.input, confirmed: true, planRevision: plan.body.planRevision };
  const path = join(f.directory, "input/b.wav"), original = await readFile(path);
  await writeFile(path, wav(32000, 999));
  expect((await f.call(confirmed)).body.error.message).toContain("SHA-256");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  await writeFile(path, original);
  expect((await f.call(confirmed)).status).toBe(200);
  await writeFile(join(f.directory, "workbench.json"), json({ projectId: "target", userEdit: "preserve" }));
  const changed = await snapshotProjectFiles(f.directory);
  const rollback = await f.call({ confirmed: true, action: "rollback" }, `/operations/${f.input.operationId}`);
  expect(rollback.status).toBe(409); expect(rollback.body.error.code).toBe("revision_conflict");
  expect(await snapshotProjectFiles(f.directory)).toEqual(changed);
  expect((await f.call(confirmed)).body.error.code).toBe("operation_replay_stale");
}, 20000);

test("partial manual subtitle returns affected cue diagnostics without deleting anything", async () => {
  const f = await fixture();
  const subs = JSON.parse(f.before["subtitles.json"]!);
  subs.cues = [{ id: "manual-mixed-screen", wordIds: ["w0", "w1"], text: "不能推测删除后的人工文本" }];
  await writeFile(join(f.directory, "subtitles.json"), json(subs));
  const before = await snapshotProjectFiles(f.directory);
  const result = await f.call({ ...f.input, expectedTargetRevision: projectFilesRevision(before) });
  expect(result.status).toBe(400);
  expect(result.body.error).toMatchObject({ message: "Partial subtitle deletion requires reviewed text", details: { cueId: "manual-mixed-screen" } });
  expect(await snapshotProjectFiles(f.directory)).toEqual(before);
  expect(await readProjectTransaction(f.directory, f.input.operationId)).toBeNull();
});

test("batch segment endpoint plans exact clips, CAS concurrency, idempotence and whole rollback", async () => {
  const f = await fixture();
  const input = { operationId: "segments", expectedTargetRevision: f.input.expectedTargetRevision, clipIds: ["manual-one", "manual-two"], confirmed: false };
  const plan = await f.call(input, "/segment-cuts");
  expect(plan.status).toBe(200); expect(plan.body.mode).toBe("segment-cuts");
  expect(plan.body.summary.removedDuration).toBe(1.4);
  expect(plan.body.summary.removedRanges).toHaveLength(2);
  expect(plan.body.summary.removedSubtitleIds).toEqual(["sub-w0", "sub-w1", "sub-w2"]);
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  const confirmation = { ...input, confirmed: true, planRevision: plan.body.planRevision };
  expect((await f.call({ ...confirmation, planRevision: "0".repeat(64) }, "/segment-cuts")).status).toBe(409);
  const concurrent = await Promise.all([f.call(confirmation, "/segment-cuts"), f.call({ ...confirmation, operationId: "other" }, "/segment-cuts")]);
  expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
  expect(concurrent[0]!.status).toBe(200);
  const after = await snapshotProjectFiles(f.directory);
  expect(JSON.parse(after["edit-list.json"]!).segments).toEqual([JSON.parse(f.before["edit-list.json"]!).segments[0]]);
  expect(after["transcript.json"]).toBe(f.before["transcript.json"]);
  expect((await f.call(confirmation, "/segment-cuts")).body.changed).toBe(false);
  expect((await f.call({ ...confirmation, clipIds: ["manual-one"] }, "/segment-cuts")).body.error.code).toBe("operation_id_conflict");
  expect((await f.call({ ...f.input, operationId: "segments", confirmed: true, planRevision: plan.body.planRevision })).body.error.code).toBe("operation_id_conflict");
  expect((await f.call({ confirmed: true, action: "rollback" }, "/operations/segments")).body.state).toBe("rolled_back");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
  expect((await f.call(confirmation, "/segment-cuts")).body.error.code).toBe("operation_replay_stale");
}, 20000);

test("segment transaction interruption blocks consumers and HTTP recovery restores all eight files", async () => {
  for (const action of ["finish", "rollback"] as const) {
    const f = await fixture();
    const built = buildWordCutDocuments(f.before, ["manual-one"], "interrupted-segments", "segment-cuts");
    await expect(commitProjectTransaction(f.directory, { schemaVersion: 1, operationId: "interrupted-segments", inputKey: "fixture", before: f.before, after: built.after }, async name => {
      if (name === "edit-list.json") throw Error("injected interruption");
    })).rejects.toThrow("injected interruption");
    expect((await f.call(undefined, "")).body.error.code).toBe("operation_in_progress");
    expect((await f.call(undefined, "/operations/interrupted-segments")).body.state).toBe("interrupted");
    expect((await f.call({ confirmed: true, action }, "/operations/interrupted-segments")).status).toBe(200);
    expect(await snapshotProjectFiles(f.directory)).toEqual(action === "finish" ? built.after : f.before);
    if (action === "finish") {
      expect((await f.call({ confirmed: true, action: "rollback" }, "/operations/interrupted-segments")).status).toBe(200);
      expect(await snapshotProjectFiles(f.directory)).toEqual(f.before);
    }
  }
}, 20000);

test("explicit affected layer removal is plan-bound, unrelated layers and legacy word-cuts reject", async () => {
  const f = await fixture();
  const layer = (id: string, wordIds: string[]) => ({ id, wordIds, media: { assetId: "d".repeat(64), sourceIn: 0, sourceOut: 2, fit: "contain", muted: true } });
  await writeFile(join(f.directory, "visuals.json"), json({ schemaVersion: 1, projectId: "target", baseTranscriptRevision: sha(f.before["transcript.json"]!), animationStyle: "xiaohei", layers: [layer("affected", ["w0", "w1"]), layer("unrelated", ["w2"])] }));
  const before = await snapshotProjectFiles(f.directory);
  const input = { operationId: "explicit-visual", clipIds: ["manual-one"], expectedTargetRevision: projectFilesRevision(before), confirmed: false };
  for (const removeVisualLayerIds of [["unknown"], ["unrelated"], ["affected", "affected"], "affected", null]) {
    expect((await f.call({ ...input, removeVisualLayerIds }, "/segment-cuts")).status).toBe(400);
    expect(await snapshotProjectFiles(f.directory)).toEqual(before);
  }
  expect((await f.call({ ...f.input, expectedTargetRevision: input.expectedTargetRevision, removeVisualLayerIds: ["affected"] })).status).toBe(400);
  const plain = await f.call(input, "/segment-cuts"); expect(plain.status).toBe(200);
  const explicit = { ...input, removeVisualLayerIds: ["affected"] };
  expect((await f.call({ ...explicit, confirmed: true, planRevision: plain.body.planRevision }, "/segment-cuts")).status).toBe(409);
  const plan = await f.call(explicit, "/segment-cuts"); expect(plan.status).toBe(200);
  expect((await f.call({ ...explicit, confirmed: true, planRevision: plan.body.planRevision }, "/segment-cuts")).status).toBe(200);
  const after = await snapshotProjectFiles(f.directory);
  expect(JSON.parse(after["visuals.json"]!).layers).toEqual([layer("unrelated", ["w2"])]);
  expect((await f.call({ confirmed: true, action: "rollback" }, "/operations/explicit-visual")).status).toBe(200);
  expect(await snapshotProjectFiles(f.directory)).toEqual(before);
}, 20000);
