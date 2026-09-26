import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { correctTranscriptText, OperationAuditStore, operationInputHash, projectUrl, readProjectDocument, registerProject, resolveProject, resolveTranscriptionCredentials, serializeProjectOperation } from "@video-workbench/core/node";
import { assertFreshProjectState, ingestKouboProject, transcribeKouboVideo } from "@video-workbench/koubo-adapter";
import { isLoopbackAddress, trustedLoopbackOrigin } from "./jobs-api";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function reject(code: string, status = 400): never { throw Object.assign(new Error(code), { code, status }); }
async function digest(path: string) { const h = createHash("sha256"); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest("hex"); }
async function body(request: Request) {
  const reader = request.body?.getReader(); if (!reader) reject("body_required");
  const chunks: Uint8Array[] = []; let size = 0;
  const timer = setTimeout(() => { void reader.cancel(); }, 5000);
  try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 1024 * 1024) reject("body_too_large"); chunks.push(r.value); } return JSON.parse(Buffer.concat(chunks).toString()); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Execution belongs to this Runtime process. Persisted admission is NOT an automatic
 * retry queue: after process loss, uncertain provider submissions stay interrupted. */
export function createIngestApi(projectsDir: string, dataDir: string, port: number, options: { runTranscription?: typeof transcribeKouboVideo } = {}) {
  const store = new OperationAuditStore(dataDir);
  const active = new Set<string>();
  const tasks = new Set<Promise<void>>();
  const claimsDir = join(dataDir, "ingest-targets");
  const operationClaim = (id: string) => join(claimsDir, `operation-${operationInputHash(id)}.json`);
  async function orphan(id: string): Promise<{ inputHash: string } | null> {
    try { const value = JSON.parse(await readFile(operationClaim(id), "utf8")); if (value.operationId !== id || !/^[a-f0-9]{64}$/.test(value.inputHash)) reject("ingest_claim_corrupt", 409); return value; }
    catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  }
  async function status(operationId: string) {
    const record = await store.read(operationId);
    if (!record) {
      if (await orphan(operationId)) return { schemaVersion: 1, operationId, status: "interrupted", stage: "interrupted", result: null, errorCode: "ingest_admission_interrupted_requires_verification" };
      reject("operation_not_found", 404);
    }
    if (record.kind !== "project.ingest" || record.entrypoint !== "ingest-api") reject("operation_not_found", 404);
    if (record.succeeded && record.result) {
      const project = await resolveProject(String(record.result.projectId), { projectsDir });
      if (operationInputHash(await realpath(project.directory)) !== record.target.taskHash || typeof record.result.canonicalVideo !== "string" || await digest(join(project.directory, record.result.canonicalVideo)) !== record.result.sourceSha256) reject("ingest_result_changed", 409);
    }
    const state = record.succeeded ? "succeeded" : record.failed ? "failed" : active.has(operationId) ? "running" : "interrupted";
    return { schemaVersion: 1, operationId, status: state, stage: state === "succeeded" ? "complete" : state === "running" ? "ingest" : state,
      result: record.result, errorCode: state === "interrupted" ? "ingest_interrupted_requires_verification" : record.errorCode };
  }
  const handler = async (request: Request, client?: string): Promise<Response | null> => {
    const url = new URL(request.url);
    const ingest = /^\/api\/v1\/ingests(?:\/([^/]+))?$/.exec(url.pathname);
    const correction = /^\/api\/v1\/projects\/([^/]+)\/transcript-corrections$/.exec(url.pathname);
    if (!ingest && !correction) return null;
    const origin = trustedLoopbackOrigin(request.headers.get("host"), port);
    if (!client || !isLoopbackAddress(client) || !origin || url.origin !== origin || (request.headers.has("origin") && request.headers.get("origin") !== origin)) return Response.json({ error: { code: "origin_forbidden" } }, { status: 403 });
    try {
      if (ingest?.[1] && request.method === "GET") return Response.json(await status(decodeURIComponent(ingest[1])), { headers: { "Cache-Control": "no-store" } });
      if (request.method !== "POST" || ingest?.[1]) reject("method_not_allowed", 405);
      const b = await body(request);
      if (!b || b.confirmed !== true || typeof b.operationId !== "string" || !ID.test(b.operationId)) reject("confirmation_or_operation_id_invalid");
      if (correction) {
        const id = decodeURIComponent(correction[1]!);
        if (!id || /[\\/\0]/.test(id) || id === "." || id === "..") reject("project_invalid");
        if (typeof b.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(b.expectedRevision) || !Array.isArray(b.corrections) || !b.corrections.length || b.corrections.length > 500 || b.corrections.some((c: any) => !c || typeof c.wordId !== "string" || c.wordId.length > 128 || typeof c.text !== "string" || c.text.length > 1000)) reject("corrections_invalid");
        const project = await resolveProject(id, { projectsDir });
        const result = await serializeProjectOperation(project.directory, async () => {
          const admission = await store.admit({ operationId: b.operationId, kind: "transcript.correct", target: { projectId: id }, inputHash: operationInputHash({ id, expectedRevision: b.expectedRevision, corrections: b.corrections }), actor: "agent", entrypoint: "ingest-api" });
          if (admission.replay) { if (admission.replay.status !== "succeeded") reject(admission.replay.status === "committed_partial" ? "correction_requires_verification" : admission.replay.errorCode ?? "operation_failed", 409); return admission.replay.result; }
          let mutationStarted = false;
          try {
            if ((await readProjectDocument(project, "transcript.json")).revision !== b.expectedRevision) reject("revision_conflict", 409);
            // Validate the existing Product's correction/subtitle plan before writes.
            await correctTranscriptText(project, b.corrections, { dryRun: true, actor: "runtime" });
            mutationStarted = true;
            const corrected = await correctTranscriptText(project, b.corrections, { actor: "runtime" });
            const result = { schemaVersion: 1, operationId: b.operationId as string, projectId: id, previousRevision: corrected.previousRevision, revision: corrected.revision, changed: corrected.changed, correctedWordCount: corrected.applied.length, subtitleScreensUpdated: corrected.subtitles.updated.length, subtitleNeedsAttentionCount: corrected.subtitles.needsAttention.length };
            await store.finishSucceeded(b.operationId, { result }); return result;
          } catch (error) {
            if (mutationStarted) { await store.finishCommittedPartial(b.operationId, error, { result: { projectId: id, needsVerification: true } }); reject("correction_requires_verification", 409); }
            await store.finishFailed(b.operationId, error); throw error;
          }
        });
        return Response.json(result);
      }
      if (typeof b.sourcePath !== "string" || !isAbsolute(b.sourcePath) || extname(b.sourcePath).toLowerCase() !== ".wav" || typeof b.taskDirectory !== "string" || !isAbsolute(b.taskDirectory) || typeof b.expectedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.expectedSourceSha256)) reject("ingest_input_invalid");
      if ((b.language !== undefined && (typeof b.language !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(b.language))) || (b.aspectRatio !== undefined && !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(b.aspectRatio))) reject("ingest_options_invalid");
      const input = { sourcePath: resolve(b.sourcePath), taskDirectory: resolve(b.taskDirectory), sourceSha256: b.expectedSourceSha256, language: b.language ?? null, aspectRatio: b.aspectRatio ?? null };
      const inputHash = operationInputHash(input);
      await mkdir(claimsDir, { recursive: true });
      const response = await serializeProjectOperation(claimsDir, async () => {
        const old = await store.read(b.operationId);
        if (old) { if (old.inputHash !== inputHash || old.entrypoint !== "ingest-api" || old.kind !== "project.ingest") reject("operation_id_conflict", 409); return { replay: true }; }
        const incomplete = await orphan(b.operationId);
        if (incomplete) { if (incomplete.inputHash !== inputHash) reject("operation_id_conflict", 409); return { replay: true }; }
        const source = await lstat(input.sourcePath), target = await lstat(input.taskDirectory);
        if (!source.isFile() || source.isSymbolicLink() || !target.isDirectory() || target.isSymbolicLink()) reject("ingest_path_invalid");
        const sourcePath = await realpath(input.sourcePath), targetPath = await realpath(input.taskDirectory);
        if (targetPath === resolve(projectsDir) || targetPath.startsWith(resolve(projectsDir) + sep)) reject("ingest_target_unsafe");
        const claim = join(claimsDir, operationInputHash(targetPath) + ".json");
        try { await lstat(claim); reject("ingest_target_conflict", 409); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
        const projectClaim = join(claimsDir, `project-${operationInputHash(basename(targetPath))}.json`);
        try { await lstat(projectClaim); reject("project_id_reserved", 409); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
        await assertFreshProjectState(targetPath);
        try { await lstat(join(projectsDir, basename(targetPath))); reject("project_id_conflict", 409); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
        if (await digest(sourcePath) !== input.sourceSha256) reject("source_hash_mismatch", 409);
        const taskSource = sourcePath.startsWith(targetPath + sep) ? sourcePath : join(targetPath, "source.wav");
        let copyNeeded = taskSource !== sourcePath;
        if (copyNeeded) {
          try {
            const existing = await lstat(taskSource);
            if (!existing.isFile() || existing.isSymbolicLink() || await digest(taskSource) !== input.sourceSha256) reject("source_target_conflict", 409);
            copyNeeded = false;
          } catch (e: any) { if (e.code !== "ENOENT") throw e; }
        }
        // Claim first: a crash between claim and admission deliberately blocks new
        // submissions until operator verification, never allowing a second charge.
        const reservation = JSON.stringify({ operationId: b.operationId, inputHash });
        await writeFile(operationClaim(b.operationId), reservation, { flag: "wx", mode: 0o600 });
        await writeFile(claim, reservation, { flag: "wx", mode: 0o600 });
        await writeFile(projectClaim, reservation, { flag: "wx", mode: 0o600 });
        await store.admit({ operationId: b.operationId, kind: "project.ingest", target: { taskHash: operationInputHash(targetPath) }, inputHash, actor: "agent", entrypoint: "ingest-api" });
        active.add(b.operationId);
        const task = (async () => {
          try {
            if (copyNeeded) await copyFile(sourcePath, taskSource, constants.COPYFILE_EXCL);
            if (await digest(taskSource) !== input.sourceSha256) reject("source_hash_mismatch", 409);
            const result = await ingestKouboProject(targetPath, { video: relative(targetPath, taskSource), language: b.language, aspectRatio: b.aspectRatio,
              transcription: options.runTranscription ? {} : await resolveTranscriptionCredentials(),
              runTranscription: async (directory, transcriptionOptions) => {
                if (await digest(join(directory, transcriptionOptions.video)) !== input.sourceSha256) reject("source_hash_mismatch", 409);
                return (options.runTranscription ?? transcribeKouboVideo)(directory, transcriptionOptions);
              },
              create: { finalize: async prepared => {
                const project = await resolveProject(prepared.directory, { projectsDir });
                const canonicalVideo = project.project.inputVideo;
                if (typeof canonicalVideo !== "string" || await digest(join(prepared.directory, canonicalVideo)) !== input.sourceSha256) reject("source_hash_mismatch", 409);
                const registered = await registerProject(project, projectsDir);
                if (!registered.registered) reject("project_id_conflict", 409);
              } } });
            if (await digest(join(result.directory, result.canonicalVideo)) !== input.sourceSha256) reject("source_hash_mismatch", 409);
            await store.finishSucceeded(b.operationId, { result: { projectId: result.projectId, sourceSha256: input.sourceSha256, canonicalVideo: result.canonicalVideo, url: projectUrl(await resolveProject(result.directory, { projectsDir }), origin), registered: true } });
          } catch (error) { await store.finishFailed(b.operationId, error); }
          finally { active.delete(b.operationId); }
        })().catch(() => { active.delete(b.operationId); });
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return { replay: false };
      });
      return Response.json(response.replay ? await status(b.operationId) : { schemaVersion: 1, operationId: b.operationId, status: "accepted", stage: "accepted", result: null, errorCode: null }, { status: response.replay ? 200 : 202 });
    } catch (e: any) { return Response.json({ error: { code: typeof e.code === "string" ? e.code : "ingest_invalid", message: "Request rejected; inspect the operation state before retrying." } }, { status: e.status ?? 400 }); }
  };
  return Object.assign(handler, {
    isBusy: () => active.size > 0 || tasks.size > 0,
    drain: async () => { while (tasks.size) await Promise.allSettled([...tasks]); },
  });
}
