import { test, expect } from "bun:test";
import { mkdtemp, realpath, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./args";
import { runWorkbenchCommand } from "./workbench-command";
import { WORKBENCH_OPERATIONS, workbenchCommands } from "./workbench-commands";
import { PRODUCT_VERSION } from "./output";
import { sanitized } from "./workbench-client";
import { createHash } from "node:crypto";

const rev = "a".repeat(64), next = "b".repeat(64);
const health = { ok: true, product: "chengfeng-videocut", productVersion: PRODUCT_VERSION, pid: process.pid, studioBuildId: "fixture", existingWorkflowApiVersion: 1, mediaAssetsApiVersion: 1, projectConfigApiVersion: 1, ingestApiVersion: 1, transcriptCorrectionApiVersion: 1, multisourceAudioApiVersion: 1, multisourceAudio: { wordCutsApiVersion: 1, segmentCutsApiVersion: 1 } };

test("workbench discoverability, parser and fixed operation scope", () => {
  expect(Object.keys(workbenchCommands().operations)).toEqual(Object.keys(WORKBENCH_OPERATIONS));
  expect(workbenchCommands().confirmation).toContain('Only operations with mode:"plan"');
  expect(workbenchCommands().confirmation).toContain('export-plan has mode:"read" and accepts only profile');
  expect(parseArgs(["workbench", "commands", "--json"]).action).toBe("commands");
  for (const [name, spec] of Object.entries(WORKBENCH_OPERATIONS)) {
    const args = ["workbench", name, "--api-base", "http://127.0.0.1:1234", ...(spec.project ? ["--project", "demo"] : []), ...(spec.required.length ? ["--file", "request.json"] : []), ...(spec.mode === "write" ? ["--confirmed"] : [])];
    expect(parseArgs(args).action).toBe(name);
    expect(() => parseArgs([...args, "--projects-dir", "/tmp/other"])).toThrow();
  }
  for (const args of [["workbench", "https://evil"], ["workbench", "connect"], ["workbench", "commands", "--api-base", "http://127.0.0.1"], ["workbench", "word-cuts-plan", "--api-base", "http://127.0.0.1", "--project", "demo", "--file", "plan.json", "--confirmed"]]) expect(() => parseArgs(args)).toThrow();
});

test("workbench preserves structured diagnostic details with credential redaction", () => {
  expect(sanitized({ cueId: "c1", reason: "revision mismatch", currentRevision: rev, credentials: { key: "secret" }, nested: { accessToken: "abc", tokenCount: 3, message: "Bearer abc123" } })).toEqual({ cueId: "c1", reason: "revision mismatch", currentRevision: rev, credentials: "[redacted]", nested: { accessToken: "[redacted]", tokenCount: 3, message: "Bearer [redacted]" } });
});

test("bounded target reads retain before/after identity checks and optional replacement capability gates", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbench-target-gates-"))), file = join(root, "request.json");
  let healthCalls = 0, dataCalls = 0, advertise = false, changed = false, drift = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/health") {
      healthCalls++;
      return Response.json({ ...health, studioBuildId: changed ? "changed" : "fixture", ...(advertise ? { editTargetsApiVersion: 1 } : {}) });
    }
    dataCalls++; if (drift) changed = true;
    const body = await req.json();
    return Response.json({ projectId: "demo", schemaVersion: 1, editListSchemaVersion: 2, revision: rev, matches: [], query: body });
  } });
  const call = async (name: string, body: unknown) => {
    await writeFile(file, JSON.stringify(body));
    return runWorkbenchCommand(parseArgs(["workbench", name, "--api-base", `http://127.0.0.1:${server.port}`, "--project", "demo", "--file", file]), root);
  };
  try {
    const schema = workbenchCommands().operations.targets.inputSchema;
    expect(schema.properties.clipIds.maxItems).toBe(100);
    expect(schema.properties.expectedRevision.pattern).toBe("^[a-f0-9]{64}$");
    await expect(call("targets", { text: "一句", clipIds: ["clip"] })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(call("targets", { text: "一句", expectedRevision: "none" })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(healthCalls).toBe(0); expect(dataCalls).toBe(0);
    await expect(call("targets", { text: "一句" })).rejects.toMatchObject({ code: "workbench_capability_missing" });
    expect(dataCalls).toBe(0);
    advertise = true; healthCalls = 0;
    expect((await call("targets", { text: "一句", expectedRevision: rev })).readBackVerified).toBe(true);
    expect(healthCalls).toBe(2); expect(dataCalls).toBe(1);
    drift = true;
    await expect(call("targets", { paragraphs: { start: 1, end: 1 } })).rejects.toMatchObject({ code: "workbench_source_changed" });
    changed = false; drift = false; const before = dataCalls;
    await expect(call("word-cuts-plan", { operationId: "reviewed", confirmed: false, expectedTargetRevision: rev, wordIds: ["w1"], reviewedVisualReplacements: [] }))
      .rejects.toMatchObject({ code: "workbench_capability_missing" });
    expect(dataCalls).toBe(before);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("real HTTP gates confirmation/plan/identity/readback and never retries writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbench-cli-unit-")));
  const file = join(root, "request.json");
  let calls: { method: string; path: string; body: any }[] = [], patch: Record<string, any> = {}, driftOnGet = false, responseMode = "normal";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return Response.json({ ...health, ...patch });
    const body = req.method === "GET" ? undefined : await req.json();
    calls.push({ method: req.method, path: url.pathname, body });
    if (responseMode === "error") return Response.json({ error: { code: "revision_conflict", details: { currentRevision: next, cueId: "c1", authorization: "secret" } } }, { status: 409 });
    if (responseMode === "redirect") return new Response(null, { status: 302, headers: { location: "http://example.com" } });
    if (responseMode === "500") return Response.json({ error: { code: "committed_partial", details: { committed: true } } }, { status: 500 });
    if (req.method === "GET" && driftOnGet) patch.studioBuildId = "replacement";
    if (url.pathname.endsWith("sources/word-cuts")) return Response.json({ operationId: body.operationId, committed: false, planRevision: rev, afterRevision: next });
    if (url.pathname.endsWith("subtitle-inputs")) return Response.json({ projectId: "demo", files: { "transcript.json": '{ "words": [] }\n', "edit-list.json": '{ "segments": [] }\n', "subtitles.json": null } });
    return Response.json({ projectId: "demo", revision: responseMode === "bad-readback" && req.method === "GET" ? rev : next, document: { projectId: "demo" } });
  } });
  const call = async (name: string, body: any = undefined, confirmed = false) => {
    if (body !== undefined) await writeFile(file, JSON.stringify(body));
    const spec = WORKBENCH_OPERATIONS[name as keyof typeof WORKBENCH_OPERATIONS];
    return runWorkbenchCommand(parseArgs(["workbench", name, "--api-base", `http://127.0.0.1:${server.port}`, ...(spec.project ? ["--project", "demo"] : []), ...(body === undefined ? [] : ["--file", file]), ...(confirmed ? ["--confirmed"] : [])]), root);
  };
  try {
    await expect(call("visuals-put", { expectedRevision: rev, document: {} })).rejects.toMatchObject({ code: "confirmation_required" }); expect(calls).toHaveLength(0);
    await expect(call("visuals-put", { confirmed: true, expectedRevision: rev, document: {} })).rejects.toThrow(); expect(calls).toHaveLength(0);
    await expect(call("word-cuts-plan", { confirmed: true, operationId: "op", expectedTargetRevision: rev, wordIds: ["w1"] })).rejects.toThrow(); expect(calls).toHaveLength(0);
    const plan = await call("word-cuts-plan", { confirmed: false, operationId: "op", expectedTargetRevision: rev, wordIds: ["w1"] });
    expect(plan.committed).toBe(false); expect(calls.at(-1)?.body.confirmed).toBe(false);
    calls = []; patch.existingWorkflowApiVersion = 2;
    await expect(call("cuts-get")).rejects.toMatchObject({ code: "workbench_capability_missing" }); expect(calls).toHaveLength(0); patch = {};
    patch.product = "wrong"; await expect(call("cuts-get")).rejects.toMatchObject({ code: "workbench_source_mismatch" }); patch = {};
    const saved = await call("visuals-put", { expectedRevision: rev, document: {} }, true); expect(saved.readBackVerified).toBe(true); expect(calls.filter(c => c.method === "PUT")).toHaveLength(1); expect(calls[0]?.body.expectedRevision).toBe(rev);
    calls = []; responseMode = "error";
    await expect(call("visuals-put", { expectedRevision: rev, document: {} }, true)).rejects.toMatchObject({ code: "workbench_result_unknown", details: { causeCode: "revision_conflict", recoveryOperation: "visuals-get", serviceError: { details: { currentRevision: next, cueId: "c1", authorization: "[redacted]" } } } }); expect(calls).toHaveLength(1);
    responseMode = "500"; calls = [];
    await expect(call("visuals-put", { expectedRevision: rev, document: {} }, true)).rejects.toMatchObject({ code: "workbench_result_unknown" }); expect(calls).toHaveLength(1);
    responseMode = "redirect"; await expect(call("cuts-get")).rejects.toMatchObject({ code: "workbench_redirect_rejected" });
    responseMode = "bad-readback"; await expect(call("visuals-put", { expectedRevision: rev, document: {} }, true)).rejects.toMatchObject({ code: "workbench_result_unknown", details: { causeCode: "workbench_readback_mismatch" } });
    responseMode = "normal"; driftOnGet = true;
    await expect(call("cuts-get")).rejects.toMatchObject({ code: "workbench_source_changed" }); patch = {}; driftOnGet = false;
    const staged = await call("subtitle-inputs");
    expect(staged.productionCommitted).toBe(false); expect(await readFile(staged.files["transcript.json"], "utf8")).toBe('{ "words": [] }\n');
    expect(await readdir(staged.inputDirectory)).toHaveLength(2); await rm(staged.inputDirectory, { recursive: true, force: true });
    await symlink(file, join(root, "linked.json"));
    await expect(runWorkbenchCommand(parseArgs(["workbench", "playback", "--api-base", `http://127.0.0.1:${server.port}`, "--project", "demo", "--file", join(root, "linked.json")]), root)).rejects.toMatchObject({ code: "invalid_argument" });
    calls = [];
    await writeFile(join(root, "INCOMPLETE"), "not ready");
    await expect(call("subtitle-submit", { expectedRevision: "none", candidateDirectory: root }, true)).rejects.toMatchObject({ code: "invalid_argument" }); expect(calls).toHaveLength(0);
    await rm(join(root, "INCOMPLETE"));
    await writeFile(join(root, "subtitles.json"), "{}"); await writeFile(join(root, "candidate-receipt.json"), "{}");
    await expect(call("subtitle-submit", { expectedRevision: "none", candidateDirectory: root }, true)).rejects.toMatchObject({ details: { submitted: false } }); expect(calls).toHaveLength(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("job, media, canvas, ingest and transaction adapters keep IDs and read back fixed routes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbench-routing-"))), file = join(root, "request.json");
  const calls: { method: string; path: string; body: any }[] = [];
  let wrongJob = false, recovered = false, omitAdmissionProject = false;
  const job = () => ({ schemaVersion: 1, jobId: "job-1", projectId: wrongJob ? "foreign" : "demo", kind: "export", state: "queued" });
  const manifest = { schemaVersion: 1, assetId: rev, sha256: rev, bytes: 12 };
  const transcript = '{"words":[]}';
  const transcriptRevision = createHash("sha256").update(transcript).digest("hex");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/api/health") return Response.json(health);
    const body = req.method === "GET" ? undefined : await req.json(); calls.push({ method: req.method, path: path + url.search, body });
    if (path === "/api/v1/jobs/by-operation") return Response.json({ schemaVersion: 1, ...(omitAdmissionProject ? {} : { projectId: "demo" }), operationId: "op-1", status: "succeeded", job: omitAdmissionProject ? null : job() });
    if (path === "/api/v1/jobs") return Response.json(req.method === "POST" ? job() : { schemaVersion: 1, jobs: [job()] }, { status: req.method === "POST" ? 202 : 200 });
    if (path.startsWith("/api/v1/jobs/")) return Response.json(job());
    if (path.startsWith("/api/v1/ingests")) return Response.json({ schemaVersion: 1, operationId: "op-1", status: "accepted", stage: "accepted" }, { status: req.method === "POST" ? 202 : 200 });
    if (path.endsWith("project-config")) return Response.json({ schemaVersion: 1, projectId: "demo", projectRevision: next, configRevision: next, config: { aspectRatio: "4:3" }, ...(req.method === "PATCH" ? { changed: true, previousRevision: rev } : {}) });
    if (path.includes("media-assets")) return Response.json({ schemaVersion: 1, projectId: "demo", manifest });
    if (path.endsWith("transcript-corrections")) return Response.json({ schemaVersion: 1, projectId: "demo", operationId: "op-1", revision: transcriptRevision });
    if (path.endsWith("subtitle-inputs")) return Response.json({ projectId: "demo", files: { "transcript.json": transcript } });
    if (path.includes("sources/operations/")) {
      if (req.method === "POST") recovered = true;
      return Response.json({ operationId: "op-1", revision: next, currentRevision: next, state: recovered ? "rolled_back" : "committed" });
    }
    if (path.endsWith("sources/segment-cuts")) return Response.json({ operationId: "op-1", committed: true, revision: next });
    return Response.json({ projectId: "demo", revision: next, document: {} });
  } });
  const run = async (name: string, body: any = undefined, confirmed = false) => {
    const spec = WORKBENCH_OPERATIONS[name as keyof typeof WORKBENCH_OPERATIONS];
    if (body !== undefined) await writeFile(file, JSON.stringify(body));
    return runWorkbenchCommand(parseArgs(["workbench", name, "--api-base", `http://127.0.0.1:${server.port}`, ...(spec.project ? ["--project", "demo"] : []), ...(body === undefined ? [] : ["--file", file]), ...(confirmed ? ["--confirmed"] : [])]), root);
  };
  try {
    const exported = await run("export-start", { operationId: "op-1", expectedSnapshot: rev, outputPath: join(root, "film.mp4"), profile: "fast" }, true);
    expect(exported.jobId).toBe("job-1"); expect(exported.admissionOnly).toBe(true); expect(exported.completionVerified).toBe(false);
    expect(calls[0]!.body).toEqual({ kind: "export", target: "demo", operationId: "op-1", params: { expectedSnapshot: rev, outputPath: join(root, "film.mp4"), profile: "fast" } });
    const admission = await run("job-by-operation", { operationId: "op-1" }); expect(admission.statusScope).toBe("admission"); expect(admission.completionVerified).toBe(false);
    omitAdmissionProject = true; await expect(run("job-by-operation", { operationId: "op-1" })).rejects.toMatchObject({ code: "workbench_readback_mismatch" }); omitAdmissionProject = false;
    expect((await run("job-list", { limit: 1 })).jobs).toHaveLength(1);
    expect((await run("job-get", { jobId: "job-1" })).jobId).toBe("job-1");
    wrongJob = true; const before = calls.filter(c => c.method === "POST").length;
    await expect(run("job-cancel", { jobId: "job-1" }, true)).rejects.toMatchObject({ code: "workbench_readback_mismatch" });
    expect(calls.filter(c => c.method === "POST")).toHaveLength(before); wrongJob = false;
    expect((await run("job-cancel", { jobId: "job-1" }, true)).jobId).toBe("job-1");
    expect(calls.some(c => c.path === "/api/v1/jobs/job-1/cancel" && JSON.stringify(c.body) === "{}")).toBe(true);
    expect((await run("config-get")).projectRevision).toBe(next);
    expect((await run("config-set", { expectedRevision: rev, config: { aspectRatio: "4:3" } }, true)).readBackVerified).toBe(true);
    expect((await run("media-import", { sourcePath: join(root, "broll.mp4"), expectedSourceSha256: rev }, true)).manifest.assetId).toBe(rev);
    expect((await run("media-get", { assetId: rev })).manifest.sha256).toBe(rev);
    expect((await run("ingest-start", { operationId: "op-1", sourcePath: join(root, "source.wav"), taskDirectory: root, expectedSourceSha256: rev }, true)).admissionOnly).toBe(true);
    expect((await run("ingest-status", { operationId: "op-1" })).status).toBe("accepted");
    expect((await run("transcript-correct", { operationId: "op-1", expectedRevision: rev, corrections: [{ wordId: "w1", text: "字" }] }, true)).revision).toBe(transcriptRevision);
    expect((await run("segment-cuts-commit", { operationId: "op-1", confirmed: true, expectedTargetRevision: rev, planRevision: rev, clipIds: ["clip-1"], removeVisualLayerIds: ["layer-1"] }, true)).readback.state).toBe("committed");
    expect((await run("operation-get", { operationId: "op-1" })).state).toBe("committed");
    expect((await run("operation-recover", { operationId: "op-1", action: "rollback" }, true)).readback.state).toBe("rolled_back");
    const recovery = calls.find(c => c.path.endsWith("sources/operations/op-1") && c.method === "POST"); expect(recovery?.body).toEqual({ action: "rollback", confirmed: true });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
