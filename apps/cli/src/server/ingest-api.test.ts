import { expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OperationAuditStore, operationInputHash, readProjectDocument, resolveProject } from "@video-workbench/core/node";
import { createIngestApi } from "./ingest-api";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(afterTranscription?: (directory: string, video: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ingest-http-")));
  const data = join(root, "data"), projects = join(root, "projects"), task = join(root, "task"), recordings = join(root, "recordings");
  await Promise.all([data, projects, task, recordings].map(p => mkdir(p)));
  const source = join(recordings, "voice.wav");
  const ffmpeg = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source], { stdout: "ignore", stderr: "pipe" });
  expect(await ffmpeg.exited).toBe(0);
  const bytes = await readFile(source), sha = hash(bytes);
  let calls = 0;
  const api = createIngestApi(projects, data, 12345, { runTranscription: async (directory, opts) => {
    calls++;
    const output = join(directory, opts.output!);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ schemaVersion: 1, provider: "volcengine", language: "zh-CN", media: { source: opts.video, sha256: sha, duration: 1 }, cues: [{ id: "cue", words: [{ id: "one", text: "你好", start: 0, end: 0.4 }, { id: "two", text: "继续", start: 0.5, end: 1 }] }] }));
    await afterTranscription?.(directory, opts.video);
    return { provider: "volcengine", source, output, cueCount: 1, wordCount: 2, duration: 1 };
  } });
  const input = { operationId: "ingest-one", sourcePath: source, taskDirectory: task, expectedSourceSha256: sha, confirmed: true };
  async function call(path: string, body?: unknown, handler = api, client = "127.0.0.1") {
    const response = (await handler(new Request(`http://127.0.0.1:12345/api/v1/${path}`, { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:12345" }, ...(body ? { body: JSON.stringify(body) } : {}) }), client))!;
    return { code: response.status, value: await response.json() as any };
  }
  async function complete() {
    for (let i = 0; i < 300; i++) { const r = await call("ingests/ingest-one"); if (r.value.status !== "running") return r; await Bun.sleep(20); }
    throw Error("ingest timed out");
  }
  return { root, data, projects, task, source, bytes, sha, api, input, call, complete, calls: () => calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("ingest busy and drain cover detached provider completion", async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(async () => { entered(); await hold; });
  try {
    expect(f.api.isBusy()).toBe(false);
    expect((await f.call("ingests", f.input)).code).toBe(202);
    await started; expect(f.api.isBusy()).toBe(true);
    let drained = false; const draining = f.api.drain().then(() => { drained = true; });
    await Bun.sleep(20); expect(drained).toBe(false);
    release(); await draining;
    expect(f.api.isBusy()).toBe(false);
    expect((await f.complete()).value.status).toBe("succeeded");
  } finally { release(); await f.api.drain(); await f.cleanup(); }
});

test("native ingest real WAV: persistent response-loss replay, registration, correction CAS and unchanged timing", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.task, "README.md"), "Human notes remain unchanged");
    await writeFile(join(f.task, "source.wav"), f.bytes);
    expect((await f.call("ingests", f.input)).code).toBe(202);
    const sameName = join(f.root, "other", "task"); await mkdir(sameName, { recursive: true });
    expect((await f.call("ingests", { ...f.input, operationId: "different-directory", taskDirectory: sameName })).value.error.code).toBe("project_id_reserved");
    expect((await f.call("ingests", f.input)).code).toBe(200);
    const done = await f.complete();
    expect(done.value).toMatchObject({ status: "succeeded", result: { projectId: "task", sourceSha256: f.sha, registered: true } });
    expect(done.value.result.url).toBe("http://127.0.0.1:12345/?view=koubo#project/task");
    expect(f.calls()).toBe(1);
    const restarted = createIngestApi(f.projects, f.data, 12345);
    expect((await f.call("ingests", f.input, restarted)).value).toEqual(done.value);
    expect((await f.call("ingests", { ...f.input, operationId: "ingest-two" })).value.error.code).toBe("ingest_target_conflict");
    const project = await resolveProject("task", { projectsDir: f.projects });
    const before = await readProjectDocument<any>(project, "transcript.json");
    const correction = { operationId: "correct-one", expectedRevision: before.revision, confirmed: true, corrections: [{ wordId: "one", text: "您好" }] };
    const corrected = await f.call("projects/task/transcript-corrections", correction);
    expect(corrected.code).toBe(200);
    expect(corrected.value).toMatchObject({ changed: true, correctedWordCount: 1, subtitleNeedsAttentionCount: 0 });
    expect((await f.call("projects/task/transcript-corrections", correction)).value).toEqual(corrected.value);
    expect((await f.call("projects/task/transcript-corrections", { ...correction, operationId: "correct-two" })).code).toBe(409);
    const after = await readProjectDocument<any>(project, "transcript.json");
    expect(after.value.cues[0].words.map(({ id, start, end }: any) => ({ id, start, end }))).toEqual(before.value.cues[0].words.map(({ id, start, end }: any) => ({ id, start, end })));
    expect(await readFile(f.source)).toEqual(f.bytes);
    expect(await readFile(join(f.task, "README.md"), "utf8")).toBe("Human notes remain unchanged");
    // Inject audit persistence failure after Product writes the transcript: never report
    // a clean retryable failure or apply the same operation a second time.
    const partial = { ...correction, operationId: "correct-partial", expectedRevision: after.revision, corrections: [{ wordId: "two", text: "接着" }] };
    const failure = spyOn(OperationAuditStore.prototype, "finishSucceeded").mockRejectedValueOnce(new Error("injected persistence failure"));
    try { expect((await f.call("projects/task/transcript-corrections", partial)).value.error.code).toBe("correction_requires_verification"); }
    finally { failure.mockRestore(); }
    expect((await new OperationAuditStore(f.data).read("correct-partial"))?.committedPartial).toBe(true);
    expect((await f.call("projects/task/transcript-corrections", partial)).value.error.code).toBe("correction_requires_verification");
  } finally { await f.cleanup(); }
}, 30_000);

test("ingest input guards run before provider or target overwrite", async () => {
  const f = await fixture();
  try {
    expect((await f.call("ingests", { ...f.input, expectedSourceSha256: "0".repeat(64) })).value.error.code).toBe("source_hash_mismatch");
    await writeFile(join(f.task, "source.wav"), "different");
    expect((await f.call("ingests", f.input)).value.error.code).toBe("source_target_conflict");
    expect(await readFile(join(f.task, "source.wav"), "utf8")).toBe("different");
    await writeFile(join(f.task, "project.json"), "existing");
    expect((await f.call("ingests", f.input)).code).toBe(400);
    const link = join(f.root, "linked"); await symlink(f.task, link);
    expect((await f.call("ingests", { ...f.input, taskDirectory: link })).value.error.code).toBe("ingest_path_invalid");
    expect((await f.call("ingests", { ...f.input, sourcePath: "relative.wav" })).code).toBe(400);
    expect((await f.call("ingests", f.input, f.api, "192.168.1.2")).code).toBe(403);
    expect(f.calls()).toBe(0);
  } finally { await f.cleanup(); }
});

test("task-local prepared source is accepted without overwriting", async () => {
  const f = await fixture();
  try {
    const local = join(f.task, "source.wav"); await writeFile(local, f.bytes);
    expect((await f.call("ingests", { ...f.input, sourcePath: local })).code).toBe(202);
    expect((await f.complete()).value.status).toBe("succeeded");
    expect(await readFile(local)).toEqual(f.bytes);
    expect(f.calls()).toBe(1);
  } finally { await f.cleanup(); }
}, 30_000);

test("crash after persistent acceptance is interrupted and never submits unknown ASR again", async () => {
  const f = await fixture();
  try {
    const inputHash = operationInputHash({ sourcePath: f.source, taskDirectory: f.task, sourceSha256: f.sha, language: null, aspectRatio: null });
    await new OperationAuditStore(f.data).admit({ operationId: f.input.operationId, kind: "project.ingest", target: { taskHash: operationInputHash(f.task) }, inputHash, actor: "agent", entrypoint: "ingest-api" });
    await mkdir(join(f.data, "ingest-targets"));
    await writeFile(join(f.data, "ingest-targets", operationInputHash(f.task) + ".json"), JSON.stringify({ operationId: f.input.operationId, inputHash }));
    expect((await f.call("ingests/ingest-one")).value).toMatchObject({ status: "interrupted", errorCode: "ingest_interrupted_requires_verification" });
    expect((await f.call("ingests", f.input)).value.status).toBe("interrupted");
    expect((await f.call("ingests", { ...f.input, operationId: "new-id" })).value.error.code).toBe("ingest_target_conflict");
    expect(f.calls()).toBe(0);
  } finally { await f.cleanup(); }
});

test("real Runtime process kill during provider submission stays interrupted after restart", async () => {
  const f = await fixture();
  const ready = join(f.root, "ready.json"), submitted = join(f.root, "submitted.txt");
  const script = `
    import { createIngestApi } from ${JSON.stringify(fileURLToPath(new URL("./ingest-api.ts", import.meta.url)))};
    import { writeFile, appendFile } from 'node:fs/promises';
    let handler;
    const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>handler(request,'127.0.0.1')});
    handler = createIngestApi(${JSON.stringify(f.projects)},${JSON.stringify(f.data)},server.port,{runTranscription:async()=>{await appendFile(${JSON.stringify(submitted)},'submitted\\n');await new Promise(()=>{});}});
    await writeFile(${JSON.stringify(ready)}, JSON.stringify({port:server.port}));
  `;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  async function waitFile(path: string) {
    for (let i = 0; i < 200; i++) { try { return await readFile(path, "utf8"); } catch { await Bun.sleep(10); } }
    throw Error("child readiness timed out");
  }
  async function start() {
    child = Bun.spawn([process.execPath, "--eval", script], { stdout: "ignore", stderr: "inherit" });
    return JSON.parse(await waitFile(ready)).port as number;
  }
  async function stop() { child?.kill("SIGKILL"); await child?.exited; child = undefined; }
  async function request(port: number, path: string, input?: unknown) {
    const result = await fetch(`http://127.0.0.1:${port}/api/v1/${path}`, { ...(input ? { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" } } : {}) });
    return { code: result.status, value: await result.json() as any };
  }
  try {
    const port = await start();
    expect((await request(port, "ingests", f.input)).code).toBe(202);
    expect(await waitFile(submitted)).toBe("submitted\n");
    await stop(); await rm(ready);
    const restartedPort = await start();
    expect((await request(restartedPort, "ingests/ingest-one")).value.status).toBe("interrupted");
    expect((await request(restartedPort, "ingests", f.input)).value.status).toBe("interrupted");
    expect((await request(restartedPort, "ingests", { ...f.input, operationId: "replacement" })).code).toBe(409);
    expect(await readFile(submitted, "utf8")).toBe("submitted\n");
  } finally { await stop(); await f.cleanup(); }
}, 30_000);

test("claim persisted before audit admission remains queryable, never re-admitted", async () => {
  const f = await fixture();
  try {
    const inputHash = operationInputHash({ sourcePath: f.source, taskDirectory: f.task, sourceSha256: f.sha, language: null, aspectRatio: null });
    await mkdir(join(f.data, "ingest-targets"));
    await writeFile(join(f.data, "ingest-targets", `operation-${operationInputHash(f.input.operationId)}.json`), JSON.stringify({ operationId: f.input.operationId, inputHash }));
    expect((await f.call("ingests/ingest-one")).value.errorCode).toBe("ingest_admission_interrupted_requires_verification");
    expect((await f.call("ingests", f.input)).value.status).toBe("interrupted");
    expect(f.calls()).toBe(0);
  } finally { await f.cleanup(); }
});

test("source mutation during provider execution cannot record a successful ingest", async () => {
  const f = await fixture(async (directory, video) => { await writeFile(join(directory, video), "source changed during ASR"); });
  try {
    expect((await f.call("ingests", f.input)).code).toBe(202);
    expect((await f.complete()).value.status).toBe("failed");
    const record = await new OperationAuditStore(f.data).read(f.input.operationId);
    expect(record?.succeeded).toBe(false);
    expect(record?.result).toBeNull();
    expect((await f.call("ingests", f.input)).value.status).toBe("failed");
    expect(f.calls()).toBe(1);
    expect(await readFile(f.source)).toEqual(f.bytes);
  } finally { await f.cleanup(); }
});
