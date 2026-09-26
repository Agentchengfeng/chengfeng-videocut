import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertSubtitleDocument } from "@video-workbench/core";
import { assertCandidateReceipt } from "../../../packages/core/src/skillResults";
import { assertEditTargetQuery } from "../../../packages/core/src/editTargets";
import { assertReviewedVisualReplacements } from "../../../packages/core/src/multisourceWordCuts";
import type { ParsedArgs } from "./args";
import { ordinaryFile } from "./module-command";
import { WORKBENCH_OPERATIONS, workbenchCommands, type WorkbenchOperationName } from "./workbench-commands";
import { object, WorkbenchClient, WorkbenchError, workbenchFail as fail, sanitized } from "./workbench-client";

const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const REV = /^(none|[a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const enc = (v: string) => encodeURIComponent(v);
function equal(a: unknown, b: unknown, label: string) { if (a === undefined || a !== b) fail("workbench_readback_mismatch", `${label} does not match`); }
function query(path: string, fields: Record<string, unknown>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) q.set(k, String(v));
  return path + (q.size ? `?${q}` : "");
}
function scoped(data: Record<string, any>, project?: string) {
  if (project && data.projectId !== undefined && data.projectId !== project) fail("workbench_readback_mismatch", "Response project identity does not match requested project");
}
function jobIdentity(data: Record<string, any>, project: string) {
  if (data.projectId !== project || data.kind !== "export" || typeof data.jobId !== "string" || !ID.test(data.jobId)) fail("workbench_readback_mismatch", "Response is not the requested project-bound export job");
}

async function input(args: ParsedArgs, cwd: string, operation: WorkbenchOperationName) {
  let body: unknown = {};
  if (args.file) {
    try { body = JSON.parse((await ordinaryFile(resolve(cwd, args.file), 8 * 1024 * 1024)).toString("utf8")); }
    catch { fail("invalid_argument", "Request must be bounded ordinary JSON; reject symlinks and malformed files"); }
  }
  if (!object(body)) fail("invalid_argument", "Request JSON must be an object");
  const spec = WORKBENCH_OPERATIONS[operation];
  for (const key of Object.keys(body)) if (!spec.fields.includes(key)) fail("invalid_argument", "Unknown request field", { field: key });
  for (const key of spec.required) if (body[key] === undefined) fail("invalid_argument", "Missing request field", { field: key });
  if (spec.mode === "plan" && body.confirmed !== false) fail("confirmation_required", "Plan requires explicit JSON confirmed:false");
  if (spec.mode === "write") {
    if (!args.confirmed) fail("confirmation_required", "This operation requires --confirmed after user authorization; JSON alone cannot authorize writing");
    if (body.confirmed !== undefined && body.confirmed !== true) fail("confirmation_required", "Write confirmation conflicts with request JSON");
    if (spec.fields.includes("confirmed")) body.confirmed = true;
  }
  for (const key of ["expectedRevision", "expectedEditRevision", "expectedEditListRevision", "expectedTargetRevision", "expectedSourceRevision", "planRevision", "expectedSnapshot", "expectedSourceSha256", "assetId"]) {
    if (operation === "sound-effects-set" && key === "expectedRevision" && body[key] === null) continue;
    if (body[key] !== undefined && (typeof body[key] !== "string" || !(key === "expectedRevision" ? REV : SHA).test(body[key]))) fail("invalid_argument", "Invalid revision or SHA256 field", { field: key });
  }
  for (const key of ["operationId", "jobId"]) if (body[key] !== undefined && (typeof body[key] !== "string" || !ID.test(body[key]))) fail("invalid_argument", "Invalid bounded identifier", { field: key });
  if (operation.includes("prepend") || operation.startsWith("word-cuts-") || operation.startsWith("segment-cuts-") || operation.startsWith("operation-")) {
    if (body.operationId !== undefined && !/^[A-Za-z0-9_-]{1,96}$/.test(body.operationId)) fail("invalid_argument", "Transaction operationId must use 1..96 letters, digits, underscores or hyphens");
  }
  if (body.sourceProjectId !== undefined && (typeof body.sourceProjectId !== "string" || !body.sourceProjectId || /[\\/\x00-\x1f]/.test(body.sourceProjectId) || [".", ".."].includes(body.sourceProjectId))) fail("invalid_argument", "Invalid source project ID");
  for (const key of ["sourcePath", "taskDirectory", "outputPath", "candidateDirectory"]) if (body[key] !== undefined && (typeof body[key] !== "string" || !isAbsolute(body[key]) || body[key].length > 4096 || /[\x00-\x1f]/.test(body[key]))) fail("invalid_argument", "An absolute bounded local path is required", { field: key });
  if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > (operation === "playback" ? 64 : 100))) fail("invalid_argument", "Invalid page limit");
  if (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 16384)) fail("invalid_argument", "Invalid playback cursor");
  if (body.profile !== undefined && !["master", "fast"].includes(body.profile)) fail("invalid_argument", "profile must be master or fast");
  if (operation === "workflow-action" && body.action === "apply-cut" && !body.expectedEditListRevision) fail("revision_required", "apply-cut requires the explicitly confirmed expectedEditListRevision");
  if (operation === "operation-recover" && !["finish", "rollback"].includes(body.action)) fail("invalid_argument", "Recovery action must be finish or rollback");
  if (body.reviewedVisualReplacements !== undefined) {
    try { assertReviewedVisualReplacements(body.reviewedVisualReplacements); } catch (e) { fail("invalid_argument", e instanceof Error ? e.message : "Invalid reviewed replacements"); }
  }
  if (operation === "targets") {
    try { assertEditTargetQuery(body); } catch (e) { fail("invalid_argument", e instanceof Error ? e.message : "Invalid target selector"); }
  }
  return body;
}

async function subtitleCandidate(body: Record<string, any>, project: string) {
  const directory = body.candidateDirectory;
  try { await lstat(join(directory, "INCOMPLETE")); fail("invalid_argument", "Subtitle candidate is incomplete"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const raw = await ordinaryFile(join(directory, "subtitles.json"), 8 * 1024 * 1024);
  const receipt: unknown = JSON.parse((await ordinaryFile(join(directory, "candidate-receipt.json"), 1024 * 1024)).toString("utf8"));
  assertCandidateReceipt(receipt);
  const document: unknown = JSON.parse(raw.toString("utf8"));
  assertSubtitleDocument(document);
  if (document.projectId !== project || receipt.inputs.projectId !== project || receipt.inputs.resultRevision !== body.expectedRevision || sha(raw) !== receipt.outputSha256 || document.skillResult !== undefined) fail("invalid_argument", "Subtitle candidate identity, output SHA or result revision does not match its receipt");
  return { expectedRevision: body.expectedRevision, documentContent: raw.toString("utf8"), receipt };
}

async function stageInputs(data: Record<string, any>, project: string) {
  if (data.projectId !== project || !object(data.files)) fail("workbench_response_invalid", "Invalid subtitle input snapshot");
  const names = ["transcript.json", "edit-list.json", "subtitles.json"];
  if (Object.keys(data.files).some(k => !names.includes(k))) fail("workbench_response_invalid", "Unexpected subtitle input file");
  for (const name of names) if (typeof data.files[name] !== "string" && !(name === "subtitles.json" && data.files[name] === null)) fail("workbench_response_invalid", "Missing required raw subtitle input", { name });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "videocut-subtitle-inputs-")));
  try {
    const files: Record<string, string> = {}, hashes: Record<string, string> = {};
    for (const name of names) if (typeof data.files[name] === "string") {
      const path = join(directory, name), bytes = Buffer.from(data.files[name]);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      equal(sha(await ordinaryFile(path, 8 * 1024 * 1024)), sha(bytes), "Staged input bytes");
      files[name] = path; hashes[name] = sha(bytes);
    }
    return { schemaVersion: 1, projectId: project, inputDirectory: directory, files, hashes, productionCommitted: false };
  } catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
}

export async function runWorkbenchCommand(args: ParsedArgs, cwd: string): Promise<Record<string, any>> {
  if (args.action === "commands") return workbenchCommands();
  const name = args.action as WorkbenchOperationName, spec = WORKBENCH_OPERATIONS[name];
  if (!spec) fail("invalid_argument", "Unknown workbench operation");
  const client = new WorkbenchClient(args.apiBase!);
  const project = args.project;
  let submitted = false, stage = "input";
  let body: Record<string, any> = {};
  let stagedDirectory: string | undefined;
  let previousCutWordIds: string[] | undefined;
  const verifyHealth = async () => {
    const health = await client.health(spec.capability);
    if (body.reviewedVisualReplacements !== undefined && health.multisourceAudio?.reviewedVisualReplacementsApiVersion !== 1) {
      fail("workbench_capability_missing", "Reviewed animation replacement is unavailable on this service", { capability: "multisourceAudio.reviewedVisualReplacementsApiVersion" });
    }
    return health;
  };
  const projectPath = (resource: string) => `/api/v1/projects/${enc(project!)}/${resource}`;
  const read = async (path: string) => {
    await verifyHealth();
    const response = await client.request(path);
    await verifyHealth();
    scoped(response.data, project);
    return response.data;
  };
  try {
    body = await input(args, cwd, name);
    stage = "health";
    const health = await verifyHealth();
    if (name === "connect") {
      await client.health();
      return { schemaVersion: 1, source: client.source, capabilities: health, readBackVerified: true };
    }
    let path = spec.resource.startsWith("/") ? spec.resource : projectPath(spec.resource);
    let payload: Record<string, any> | undefined = spec.method === "GET" ? undefined : body;
    if (name === "playback") path = query(path, body);
    if (name === "export-plan") path = query(path, { profile: body.profile });
    if (name === "job-list") path = query(path, { projectId: project, kind: "export", ...body });
    if (name === "job-by-operation") path = query(path, { operationId: body.operationId, projectId: project });
    if (name === "job-get" || name === "job-cancel") path += `/${enc(body.jobId)}`;
    if (name === "ingest-status") path += `/${enc(body.operationId)}`;
    if (name === "operation-get" || name === "operation-recover") path += `/${enc(body.operationId)}`;
    if (name === "media-get" || name === "sound-effects-asset-get") path += `/${body.assetId}`;
    if (name === "subtitle-submit") { stage = "candidate"; payload = await subtitleCandidate(body, project!); }
    if (name === "export-start") payload = { kind: "export", target: project, operationId: body.operationId, params: { expectedSnapshot: body.expectedSnapshot, outputPath: body.outputPath, profile: body.profile } };
    if (name === "job-cancel") {
      const current = await read(path); jobIdentity(current, project!); equal(current.jobId, body.jobId, "Job ID");
      path += "/cancel"; payload = {};
    }
    if (name === "operation-recover") {
      const current = await read(path); equal(current.operationId, body.operationId, "Transaction ID");
      payload = { confirmed: true, action: body.action };
    }
    if (name === "cuts-put") {
      const current = await read(path);
      if (current.revision !== body.expectedRevision) fail("revision_conflict", "Cuts changed since the reviewed proposal", { expectedRevision: body.expectedRevision, currentRevision: current.revision });
      const ids = current.document?.cutWordIds;
      if (current.document !== null && !Array.isArray(ids)) fail("workbench_response_invalid", "Current cut selection is malformed");
      previousCutWordIds = ids ?? [];
    }
    // A plain read performs no intervening I/O after its initial identity check.
    // Writes/plans still recheck after candidate preparation and prerequisite reads.
    if (spec.mode !== "read") { stage = "pre-request"; await verifyHealth(); }
    stage = "request"; submitted = spec.mode === "write";
    const response = await client.request(path, spec.method, payload);
    stage = "post-request"; await verifyHealth();
    let result = response.data;
    scoped(result, project);
    if (name === "targets") {
      equal(result.projectId, project, "Target project ID");
      if (result.schemaVersion !== 1 || result.editListSchemaVersion !== 2 || typeof result.revision !== "string" || !SHA.test(result.revision) || !Array.isArray(result.matches) || result.matches.length > 100) fail("workbench_response_invalid", "Invalid target snapshot");
      if (body.expectedRevision !== undefined) equal(result.revision, body.expectedRevision, "Target snapshot revision");
    }
    if (["workflow-get", "edit-list-get", "cuts-get", "subtitles-get", "visuals-get", "config-get", "config-set", "media-get", "media-import", "sources-get", "subtitle-inputs"].includes(name)) equal(result.projectId, project, "Project ID");
    if (["edit-list-get", "cuts-get", "subtitles-get", "visuals-get"].includes(name) && (typeof result.revision !== "string" || !REV.test(result.revision))) fail("workbench_response_invalid", "Document response lacks a valid revision");
    if (name.startsWith("ingest-")) {
      equal(result.operationId, body.operationId, "Ingest operation ID");
      if (!["accepted", "running", "succeeded", "failed", "interrupted"].includes(result.status)) fail("workbench_response_invalid", "Invalid ingest state");
      if (result.status === "succeeded" && (!object(result.result) || result.result.registered !== true || typeof result.result.projectId !== "string" || typeof result.result.sourceSha256 !== "string" || !SHA.test(result.result.sourceSha256))) fail("workbench_response_invalid", "Successful ingest lacks a registered source identity");
    }
    if (name === "job-get" || name === "job-cancel" || name === "export-start") jobIdentity(result, project!);
    if (name === "job-get" || name === "job-cancel") equal(result.jobId, body.jobId, "Job ID");
    if (name === "job-by-operation") { equal(result.projectId, project, "Export admission project ID"); equal(result.operationId, body.operationId, "Export operation ID"); if (result.job) jobIdentity(result.job, project!); }
    if (name === "job-list") { if (!Array.isArray(result.jobs)) fail("workbench_response_invalid", "Invalid job list"); for (const job of result.jobs) jobIdentity(job, project!); }
    if (name.startsWith("operation-")) equal(result.operationId, body.operationId, "Transaction ID");
    if (spec.mode === "plan" && result.committed !== false) fail("workbench_response_invalid", "Plan must not report committed state");
    if (name === "media-get" && (result.manifest?.assetId !== body.assetId || result.manifest?.sha256 !== body.assetId)) fail("workbench_readback_mismatch", "Media asset ID mismatch");
    if(name.startsWith("sound-effects-")) {
      equal(result.projectId, project, "Project ID");
      if(name === "sound-effects-get" || name === "sound-effects-set") {
        if(result.schemaVersion!==1 || (result.revision!==null && !SHA.test(result.revision)) || !SHA.test(result.editRevision) || !Array.isArray(result.document?.cues)) fail("workbench_response_invalid","Invalid sound-effects document response");
      }
      if(name === "sound-effects-asset-get") equal(result.manifest?.assetId,body.assetId,"Sound-effect asset ID");
    }
    let readback: Record<string, any> | undefined;
    if (submitted) {
      stage = "readback";
      if (["sound-effects-set", "cuts-put", "visuals-put", "edit-list-patch", "subtitle-submit"].includes(name)) {
        readback = await read(projectPath(name === "subtitle-submit" ? "subtitles" : spec.resource));
        equal(readback.revision, result.revision, "Committed revision");
        if (name === "cuts-put") {
          if (!Array.isArray(readback.document?.cutWordIds)) fail("workbench_response_invalid", "Readback cut selection is malformed");
          const kept = new Set(readback.document.cutWordIds);
          const released = previousCutWordIds!.filter(id => !kept.has(id));
          result = { ...result, noLongerCut: released.length, noLongerCutSample: released.slice(0, 8) };
        }
      } else if (name === "config-set") {
        readback = await read(projectPath("project-config"));
        equal(result.previousRevision, body.expectedRevision, "Config previous revision");
        equal(readback.projectRevision, result.projectRevision, "Project revision");
        equal(readback.configRevision, result.configRevision, "Config revision");
        equal(readback.config?.aspectRatio, body.config.aspectRatio, "Canvas aspect ratio");
      } else if (name === "sound-effects-import") {
        equal(result.manifest?.assetId,body.expectedSourceSha256,"Imported sound-effect asset ID");
        readback=await read(projectPath(`sound-effects/assets/${body.expectedSourceSha256}`));
        equal(JSON.stringify(readback.manifest),JSON.stringify(result.manifest),"Sound-effect manifest");
      } else if (name === "media-import") {
        equal(result.manifest?.assetId, body.expectedSourceSha256, "Imported asset ID");
        readback = await read(projectPath(`media-assets/${body.expectedSourceSha256}`));
        equal(JSON.stringify(readback.manifest), JSON.stringify(result.manifest), "Media manifest");
      } else if (name === "export-start" || name === "job-cancel") {
        readback = await read(`/api/v1/jobs/${enc(result.jobId)}`); jobIdentity(readback, project!); equal(readback.jobId, result.jobId, "Job ID");
      } else if (name === "ingest-start") {
        readback = await read(`/api/v1/ingests/${enc(body.operationId)}`); equal(readback.operationId, body.operationId, "Ingest operation ID");
      } else if (name === "transcript-correct") {
        equal(result.operationId, body.operationId, "Correction operation ID");
        const inputs = await read(projectPath("subtitle-inputs"));
        if (typeof inputs.files?.["transcript.json"] !== "string") fail("workbench_response_invalid", "Missing corrected transcript snapshot");
        equal(sha(inputs.files["transcript.json"]), result.revision, "Corrected transcript revision");
        readback = { projectId: project, transcriptRevision: result.revision };
      } else if (name === "workflow-action") {
        readback = await read(projectPath("workflow"));
        if (!result.accepted) equal(readback.revision, result.revision, "Workflow revision");
      } else if (name.endsWith("-commit") || name === "operation-recover") {
        readback = await read(projectPath(`sources/operations/${enc(body.operationId)}`));
        equal(readback.operationId, body.operationId, "Transaction ID");
        equal(readback.currentRevision, result.revision, "Transaction current revision");
        equal(readback.state, name === "operation-recover" && body.action === "rollback" ? "rolled_back" : "committed", "Transaction state");
      }
    }
    if (name === "subtitle-inputs") {
      stage = "stage-inputs"; result = await stageInputs(result, project!); stagedDirectory = result.inputDirectory;
    }
    if (spec.mode !== "read" || stagedDirectory) { stage = "final-identity"; await verifyHealth(); }
    const asynchronous = response.status === 202 || result.accepted === true || name === "export-start" || name === "ingest-start";
    return { ...result, source: client.source, ...(readback ? { readback } : {}), readBackVerified: true, ...(asynchronous ? { admissionOnly: true, completionVerified: false } : {}), ...(name === "job-by-operation" ? { statusScope: "admission", completionVerified: result.job?.state === "succeeded" } : {}) };
  } catch (error) {
    if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true });
    const e = error instanceof WorkbenchError ? error : new WorkbenchError("workbench_request_failed", "Workbench request or candidate validation failed", { cause: sanitized(error instanceof Error ? error.message : "Unknown failure") });
    const queryOperation = name === "sound-effects-set" ? "sound-effects-get" : name === "sound-effects-import" ? "sound-effects-asset-get" : name === "export-start" ? "job-by-operation" : name === "ingest-start" ? "ingest-status" : name.includes("-commit") || name === "operation-recover" ? "operation-get" : name === "job-cancel" ? "job-get" : name === "media-import" ? "media-get" : name === "config-set" ? "config-get" : name === "subtitle-submit" ? "subtitles-get" : name === "visuals-put" ? "visuals-get" : name === "cuts-put" ? "cuts-get" : name === "edit-list-patch" ? "edit-list-get" : name === "transcript-correct" ? "subtitle-inputs" : "workflow-get";
    fail(submitted ? "workbench_result_unknown" : e.code, submitted ? "Submission may have committed; do not retry, regenerate IDs or substitute revisions. Query the same operation/result on this service." : e.message,
      { ...e.details, causeCode: e.code, stage, submitted: submitted ? "unknown" : false, operation: name, projectId: project, operationId: body.operationId, jobId: body.jobId, ...(submitted ? { recoveryOperation: queryOperation, ...(name === "media-import" ? { assetId: body.expectedSourceSha256 } : {}) } : {}), source: client.source });
  }
}
