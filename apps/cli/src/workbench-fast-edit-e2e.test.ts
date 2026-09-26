import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildEditListFromCuts, createSubtitleDocument, parseEditListDocument, parseTranscriptWords } from "@video-workbench/core";
import { renderKouboProjectIndex } from "@video-workbench/koubo-adapter";
import { projectFilesRevision, snapshotProjectFiles, readProjectTransaction } from "../../../packages/core/src/projectTransaction";
import { startStudioServer } from "./server/start";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function wav(rate: number, hz: number) {
  const count = rate * 2, bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * hz * i / rate)), 44 + i * 2);
  return bytes;
}

// No ASR, external Skill, network provider or existing project is used. Each CLI
// invocation is a separate process with deliberately invalid local registries.
for (const segment of [false, true]) test(`production fast-edit CLI: ${segment ? "segment" : "word"} targets, reviewed HTML transaction and byte-exact rollback`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbench-fast-edit-e2e-")));
  console.log(JSON.stringify({ test: "fast-edit-cli", phase: "fixture-start", mode: segment ? "segment" : "word", root }));
  const projectsDir = join(root, "projects"), directory = join(projectsDir, "target"), client = join(root, "client"), staticDir = join(root, "static");
  let server: Awaited<ReturnType<typeof startStudioServer>> | undefined;
  try {
    for (const dir of [join(directory, "input"), join(directory, "modules"), client, staticDir]) await mkdir(dir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>isolated fast edit</title>");
    await writeFile(join(staticDir, "chengfeng-videocut-capabilities.json"), json({ schemaVersion: 1, product: "chengfeng-videocut", studioVersion: "0.2.0", features: { topLevelViews: ["storyboard", "preview", "koubo"], legacyWorkbenchPanel: false, managedTimelineEditing: true } }));
    const sources = [];
    for (const [path, rate, hz] of [["input/a.wav", 44100, 440], ["input/b.wav", 32000, 880]] as const) {
      const bytes = wav(rate, hz); await writeFile(join(directory, path), bytes);
      sources.push({ path, sha256: sha(bytes), mediaKind: "audio" as const, duration: 2 });
    }
    const original = (id: string, start: number, end: number) => ({ id, text: id, start, end, source: "input/a.wav", sourceWordId: id, instanceId: "original" });
    const transcript = { cues: [
      { id: "intro", words: [{ ...original("head", 0, .5), text: "重复", source: "input/b.wav", instanceId: "import", sourceWordId: "w0" }] },
      { id: "body", words: [{ ...original("w0", .2, .6), text: "重复" }, original("w1", .6, 1)] },
      { id: "tail", words: [original("old-cut", 1.1, 1.3), original("w2", 1.4, 1.8)] },
    ] };
    const transcriptRaw = json(transcript);
    const cutsRaw = json({ schemaVersion: 3, projectId: "target", cutWordIds: ["old-cut"], reasons: [{ wordIds: ["old-cut"], kind: "repeat", risk: "high" }], cutRanges: [{ source: "input/a.wav", instanceId: "original", start: 1, end: 1.4 }], updatedAt: "2026-01-01" });
    const base = buildEditListFromCuts({ projectId: "target", source: "input/a.wav", sourceDuration: 2, cutsRevision: sha(cutsRaw), transcriptRevision: sha(transcriptRaw), cutRanges: [] });
    const edit = parseEditListDocument({ ...base, schemaVersion: 2, mode: "manual", sources, duration: 1.9, segments: [
      { ...base.segments[0], id: "head-segment", source: "input/b.wav", instanceId: "import", sourceStart: 0, sourceEnd: .5, timelineStart: 0 },
      { ...base.segments[0], id: "manual-one", instanceId: "original", sourceStart: .2, sourceEnd: 1, timelineStart: .5 },
      { ...base.segments[0], id: "manual-two", instanceId: "original", sourceStart: 1.4, sourceEnd: 2, timelineStart: 1.3 },
    ] });
    const subtitles = createSubtitleDocument("target", sha(transcriptRaw), parseTranscriptWords(transcript), edit);
    subtitles.cues = ["head", "w0", "w1", "w2"].map(id => ({ id: `sub-${id}`, wordIds: [id], text: `人工 ${id}` }));
    const originalIds = segment ? ["w0", "w1", "w2"] : ["w0", "w1"];
    const docs = {
      "project.json": json({ jobId: "target", title: "isolated fast edit", source: sources[0], inputVideo: sources[0]!.path, config: { aspectRatio: "4:3" } }),
      "workbench.json": json({ projectId: "target", sourceSha256: sources[0]!.sha256 }),
      "transcript.json": transcriptRaw, "cut-selection.json": cutsRaw, "edit-list.json": json(edit), "subtitles.json": json(subtitles),
      "visuals.json": json({ schemaVersion: 1, projectId: "target", baseTranscriptRevision: sha(transcriptRaw), animationStyle: "xiaohei", layers: [{ id: "reviewed-layer", module: "modules/old.html", wordIds: originalIds, animation: { schemaVersion: 1, clock: "local0", authoredDuration: segment ? 1.2 : .8, anchorWordIds: originalIds } }] }),
      "index.html": renderKouboProjectIndex({ title: "isolated", width: 320, height: 240, duration: edit.duration, videoSource: sources[0]!.path, editList: edit, editListRevision: sha(json(edit)) }),
    };
    for (const [name, value] of Object.entries(docs)) await writeFile(join(directory, name), value);
    await writeFile(join(directory, "modules/old.html"), "<!doctype html><div>original animation</div>");
    server = await startStudioServer({ host: "127.0.0.1", port: 0, projectsDir, dataDir: join(root, "data"), staticDir, installSignalHandlers: false });
    expect([15192, 15197, 4186]).not.toContain(server.port);
    const origin = new URL(server.url).origin;
    let sequence = 0;
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "cli.ts"), ...args], { cwd: client, stdout: "pipe", stderr: "pipe", env: { ...process.env, CHENGFENG_VIDEOCUT_PROJECTS_DIR: join(client, "missing"), VIDEO_WORKBENCH_PROJECTS_DIR: join(client, "also-missing") } });
      expect(child.pid).not.toBe(process.pid);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr, args.join(" ")).toBe("");
      return { ...JSON.parse(stdout), exitCode };
    };
    const call = async (operation: string, input?: unknown, confirmed = false) => {
      const file = join(root, `request-${sequence++}.json`);
      if (input !== undefined) await writeFile(file, json(input));
      return run(["workbench", operation, "--api-base", origin, "--project", "target", "--json", ...(input !== undefined ? ["--file", file] : []), ...(confirmed ? ["--confirmed"] : [])]);
    };
    const good = async (operation: string, input?: unknown, confirmed = false) => {
      const result = await call(operation, input, confirmed);
      expect(result.exitCode, JSON.stringify(result)).toBe(0); return result.data;
    };
    const commands = await run(["workbench", "commands", "--json"]);
    expect(commands.exitCode).toBe(0);
    expect(commands.data.operations.targets).toMatchObject({ mode: "read", method: "POST", resource: "edit-targets" });
    for (const mode of ["word", "segment"]) for (const action of ["plan", "commit"]) expect(commands.data.operations[`${mode}-cuts-${action}`].fields).toContain("reviewedVisualReplacements");
    const health = await (await fetch(`${origin}/api/health`)).json();
    expect(health.editTargetsApiVersion).toBe(1);
    expect(health.multisourceAudio.reviewedVisualReplacementsApiVersion).toBe(1);
    const before = await snapshotProjectFiles(directory), namesBefore = await readdir(directory);
    const revision = projectFilesRevision(before);
    const clips = await good("targets", { clipIds: ["manual-one"], expectedRevision: revision });
    expect(clips).toMatchObject({ schemaVersion: 1, projectId: "target", revision, editListSchemaVersion: 2 });
    expect(clips.matches).toHaveLength(1);
    expect(clips.matches[0]).toMatchObject({ wordIds: ["w0", "w1"], clipIds: ["manual-one"] });
    expect(clips.matches[0].playback.map((entry: any) => entry.id)).toEqual(["w0", "w1"]);
    expect(clips.matches[0].subtitleCues.map((cue: any) => cue.id)).toEqual(["sub-w0", "sub-w1"]);
    expect(clips.matches[0].visualLayers[0].id).toBe("reviewed-layer");
    expect((await good("targets", { timeline: { start: .51, end: .89 }, expectedRevision: revision })).matches[0].wordIds).toEqual(["w0"]);
    expect((await good("targets", { paragraphs: { start: 2, end: 2 }, expectedRevision: revision })).matches[0]).toMatchObject({ wordIds: ["w0", "w1"], clipIds: ["manual-one"] });
    const textTargets = await good("targets", { text: "重复", expectedRevision: revision });
    expect(textTargets.requiresSelection).toBe(true); expect(textTargets.matches).toHaveLength(2);
    const stale = await call("targets", { clipIds: ["manual-one"], expectedRevision: "0".repeat(64) });
    expect(stale.exitCode).not.toBe(0); expect(JSON.stringify(stale.error)).toContain("revision_conflict");
    expect((await call("targets", { clipIds: ["manual-one"], text: "重复" })).exitCode).not.toBe(0);
    expect(await snapshotProjectFiles(directory)).toEqual(before); expect(await readdir(directory)).toEqual(namesBefore);
    const mode = segment ? "segment" : "word";
    const input = { operationId: `fast-${mode}`, expectedTargetRevision: revision, ...(segment ? { clipIds: ["manual-one"] } : { wordIds: ["w0"] }), confirmed: false };
    const rejected = await call(`${mode}-cuts-plan`, input);
    expect(rejected.exitCode).not.toBe(0); expect(JSON.stringify(rejected.error)).toContain("partial_html_requires_reviewed_animation");
    expect(await snapshotProjectFiles(directory)).toEqual(before);
    expect(await readProjectTransaction(directory, input.operationId)).toBeNull();
    const html = "<!doctype html><div>reviewed shorter animation</div>";
    await writeFile(join(client, "scene.html"), html);
    const manifestPath = join(client, "module-manifest.json");
    await writeFile(manifestPath, json({ schemaVersion: 1, moduleId: "reviewed", version: "v1", entry: "scene.html", files: [{ path: "scene.html", bytes: Buffer.byteLength(html), sha256: sha(html) }] }));
    const published = await run(["module", "publish", "target", "--file", manifestPath, "--api-base", origin, "--confirmed", "--json"]);
    expect(published.exitCode, JSON.stringify(published)).toBe(0); expect(published.data.readBackVerified).toBe(true);
    expect(await snapshotProjectFiles(directory)).toEqual(before);
    const kept = segment ? ["w2"] : ["w1"];
    const replacement = { layerId: "reviewed-layer", module: published.data.entryPath, expectedModuleDigest: published.data.digest, wordIds: kept, animation: { schemaVersion: 1, clock: "local0", authoredDuration: .4, anchorWordIds: kept } };
    const reviewed = { ...input, reviewedVisualReplacements: [replacement] };
    const plan = await good(`${mode}-cuts-plan`, reviewed);
    expect(plan.committed).toBe(false); expect(plan.deletion.reviewedVisualReplacements[0].module).toBe(replacement.module);
    expect(await snapshotProjectFiles(directory)).toEqual(before); expect(await readProjectTransaction(directory, input.operationId)).toBeNull();
    const commit = { ...reviewed, confirmed: true, planRevision: plan.planRevision };
    expect((await call(`${mode}-cuts-commit`, commit)).exitCode).not.toBe(0);
    expect((await call(`${mode}-cuts-commit`, { ...commit, planRevision: "0".repeat(64) }, true)).exitCode).not.toBe(0);
    expect(await snapshotProjectFiles(directory)).toEqual(before);
    const done = await good(`${mode}-cuts-commit`, commit, true);
    expect(done.committed).toBe(true); expect(done.readback.state).toBe("committed");
    expect((await good("operation-get", { operationId: input.operationId })).state).toBe("committed");
    const after = await snapshotProjectFiles(directory);
    expect(JSON.parse(after["visuals.json"]!).layers[0]).toMatchObject({ id: "reviewed-layer", module: replacement.module, wordIds: kept, animation: replacement.animation });
    expect(JSON.parse(after["edit-list.json"]!).duration).toBeCloseTo(segment ? 1.1 : 1.5);
    expect(JSON.parse(after["cut-selection.json"]!).cutWordIds).toContain("old-cut");
    expect(JSON.parse(after["cut-selection.json"]!).cutWordIds).toContain("w0");
    expect(JSON.parse(after["subtitles.json"]!).cues.map((cue: any) => cue.id)).toEqual(segment ? ["sub-head", "sub-w2"] : ["sub-head", "sub-w1", "sub-w2"]);
    for (const name of ["project.json", "workbench.json", "transcript.json"] as const) expect(after[name]).toBe(before[name]);
    for (const source of sources) expect(sha(await readFile(join(directory, source.path)))).toBe(source.sha256);
    const staleAfterCommit = await call("targets", { text: "重复", expectedRevision: revision });
    expect(staleAfterCommit.exitCode).not.toBe(0); expect(JSON.stringify(staleAfterCommit.error)).toContain("revision_conflict");
    const currentTargets = await good("targets", { paragraphs: { start: 2, end: 2 }, expectedRevision: projectFilesRevision(after) });
    expect(currentTargets.matches[0].wordIds).toEqual(segment ? [] : ["w1"]);
    expect(currentTargets.matches[0].removedWordIds).toEqual(segment ? ["w0", "w1"] : ["w0"]);
    const rollback = await good("operation-recover", { operationId: input.operationId, action: "rollback" }, true);
    expect(rollback.readback.state).toBe("rolled_back");
    expect((await good("operation-get", { operationId: input.operationId })).state).toBe("rolled_back");
    expect(await snapshotProjectFiles(directory)).toEqual(before);
    for (const source of sources) expect(sha(await readFile(join(directory, source.path)))).toBe(source.sha256);
    expect(await readFile(join(directory, "modules/old.html"), "utf8")).toBe("<!doctype html><div>original animation</div>");
    expect(await readFile(join(directory, replacement.module), "utf8")).toBe(html);
    expect((await readdir(client)).sort()).toEqual(["module-manifest.json", "scene.html"]);
    console.log(JSON.stringify({ test: "fast-edit-cli", mode, root, origin, pid: health.pid, beforeRevision: revision, afterRevision: projectFilesRevision(after), planRevision: plan.planRevision, operationId: input.operationId, rollback: "byte-exact", sourceHashes: sources.map(source => source.sha256) }));
  } finally {
    if (server) await server.stop();
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ test: "fast-edit-cli", phase: "cleanup-complete", mode: segment ? "segment" : "word", root }));
  }
}, 60_000);
