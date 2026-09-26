import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { parseEditListDocument, parseTranscriptWords, assertSubtitleDocument, assertVisualDocument, subtitleCueTimings, visualLayerTimings, VideocutError, asVideocutError } from "@video-workbench/core";
import { assertProjectReadable, serializeProjectOperation, readModuleFile } from "@video-workbench/core/node";
import { snapshotProjectFiles, projectFilesRevision, commitProjectTransaction, recoverProjectTransaction, readProjectTransaction, getProjectTransactionStatus, type ProjectFiles } from "../../../../packages/core/src/projectTransaction";
import { buildMultisourceWordCuts, buildMultisourceSegmentCuts, assertReviewedVisualReplacements, type ReviewedVisualReplacement } from "../../../../packages/core/src/multisourceWordCuts";
import { validateModuleManifest, checkResources } from "./module-api";
import { resolveMainSources, patchKouboProjectIndex } from "@video-workbench/koubo-adapter";
import { isLoopbackAddress, trustedLoopbackOrigin } from "./jobs-api";
import type { EditListDocument, EditListSource } from "@video-workbench/contracts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const bad = (message: string): never => { throw new VideocutError("invalid_argument", message); };
const parse = (f: ProjectFiles, name: keyof ProjectFiles): any => f[name] === null ? null : JSON.parse(f[name]!);
const safeId = (id: unknown): id is string => typeof id === "string" && !!id && !/[\\/\0]/.test(id) && id !== "." && id !== "..";

async function readBody(request: Request, limit = 8192): Promise<Record<string, any>> {
  const reader = request.body?.getReader();
  if (!reader) return bad("Body required");
  const parts: Uint8Array[] = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try {
    while (true) { const r = await reader.read(); if (expired) bad("Request body timeout"); if (r.done) break;
      size += r.value.byteLength; if (size > limit) { await reader.cancel(); bad("Request too large"); } parts.push(r.value); }
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) bad("Body must be an object");
    return body;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

function assertIdentity(files: ProjectFiles, id: string) {
  const edl = parseEditListDocument(parse(files, "edit-list.json"));
  const project = parse(files, "project.json");
  if (edl.projectId !== id || project?.jobId !== id) bad("Project identity does not match registered project");
  for (const name of ["cut-selection.json", "subtitles.json", "visuals.json", "workbench.json"] as const) {
    const doc = parse(files, name);
    if (doc?.projectId !== undefined && doc.projectId !== id) bad(`${name} belongs to another project`);
  }
}

function sourcesFor(files: ProjectFiles, edl: EditListDocument): EditListSource[] {
  if (edl.schemaVersion === 2) return edl.sources!;
  const project = parse(files, "project.json"), workbench = parse(files, "workbench.json");
  const path = project?.source?.path ?? project?.inputVideo;
  const sha256 = project?.source?.sha256 ?? workbench?.sourceSha256;
  if (project?.source?.mediaKind !== "audio" || typeof path !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || edl.segments.some(s => s.source !== path)) bad("Only verified audio-source projects can be prepended in this version");
  return [{ path, sha256, duration: edl.sourceDuration, mediaKind: "audio" }];
}

function validateDocumentBindings(files: ProjectFiles, edl: EditListDocument) {
  const words = parseTranscriptWords(parse(files, "transcript.json"));
  const ids = new Set(words.map(w => w.id));
  const transcriptRevision = hash(files["transcript.json"] ?? "");
  const sources = sourcesFor(files, edl);
  const instanceSources = new Map<string, string>();
  for (const segment of edl.segments) if (segment.instanceId) instanceSources.set(segment.instanceId, segment.source);
  for (const word of words) {
    const source = edl.schemaVersion === 2 ? sources.find(s => s.path === word.source) : sources[0];
    if (!source || word.end > source.duration + 0.001) bad(`Word is outside its source: ${word.id}`);
    if (edl.schemaVersion === 2) {
      if (!word.instanceId?.trim() || !word.sourceWordId?.trim()) bad(`Word requires source and instance identity: ${word.id}`);
      const known = instanceSources.get(word.instanceId!);
      if (known && known !== word.source) bad(`Word instance belongs to another source: ${word.id}`);
      instanceSources.set(word.instanceId!, word.source!);
    }
  }
  for (const name of ["subtitles.json", "visuals.json"] as const) {
    const doc = parse(files, name); if (!doc) continue;
    if (name === "subtitles.json") assertSubtitleDocument(doc); else assertVisualDocument(doc);
    if (doc.projectId !== edl.projectId || doc.baseTranscriptRevision !== transcriptRevision) bad(`${name} is stale or belongs to another project`);
    for (const item of "cues" in doc ? doc.cues : doc.layers) if (item.wordIds.some((id: string) => !ids.has(id))) bad(`${name} refers to an unknown word`);
  }
  const cuts = parse(files, "cut-selection.json");
  if (!Array.isArray(cuts?.cutWordIds) || cuts.cutWordIds.some((id: unknown) => typeof id !== "string" || !ids.has(id)) || new Set(cuts.cutWordIds).size !== cuts.cutWordIds.length) bad("Cut selection has invalid word references");
}

/** Pure transformation. Media remains separate and each occurrence has its own identity. */
export function buildPrependDocuments(target: ProjectFiles, source: ProjectFiles, operationId: string) {
  const targetEdl = parseEditListDocument(parse(target, "edit-list.json"));
  const sourceEdl = parseEditListDocument(parse(source, "edit-list.json"));
  for (const [files, edl] of [[target, targetEdl], [source, sourceEdl]] as const) {
    if (edl.baseTranscriptRevision !== hash(files["transcript.json"] ?? "") || edl.baseCutsRevision !== hash(files["cut-selection.json"] ?? "")) bad("EDL must bind the current transcript and cuts revisions");
    validateDocumentBindings(files, edl);
  }
  if (sourceEdl.schemaVersion !== 1) bad("Importing an already-multisource project is not supported yet");
  const sourceSources = sourcesFor(source, sourceEdl), targetSources = sourcesFor(target, targetEdl);
  const sourceVisuals = parse(source, "visuals.json");
  if (sourceVisuals?.layers?.length) bad("Source visual dependencies require a separate reviewed import; this version does not drop them silently");
  const original = sourceSources[0]!;
  const existing = targetSources.find(s => s.sha256 === original.sha256 && s.duration === original.duration);
  const extension = extname(original.path).toLowerCase();
  if (!/\.(wav|mp3|m4a|flac|aac|ogg)$/.test(extension)) bad("Unsupported audio source extension");
  const imported = existing ?? { ...original, path: `input/sources/${original.sha256}/source${extension}` };
  const prefix = `import-${operationId}`;
  const instanceId = prefix;
  const baseInstance = "original";
  const namespaced = (id: string) => `${prefix}:${id}`;
  const targetTranscript = parse(target, "transcript.json"), sourceTranscript = parse(source, "transcript.json");
  parseTranscriptWords(targetTranscript); parseTranscriptWords(sourceTranscript);
  const targetWords = targetTranscript.cues.map((c: any) => ({ ...c, words: c.words.map((w: any) => targetEdl.schemaVersion === 2 ? w :
    { ...w, source: targetSources[0]!.path, instanceId: baseInstance, sourceWordId: w.id }) }));
  const newCues = sourceTranscript.cues.map((c: any) => ({ ...c, id: namespaced(c.id), words: c.words.map((w: any) =>
    ({ ...w, id: namespaced(w.id), sourceWordId: w.id, source: imported.path, instanceId })) }));
  const transcript = { ...targetTranscript, cues: [...newCues, ...targetWords] };
  const transcriptRaw = json(transcript), transcriptRevision = hash(transcriptRaw);
  const words = parseTranscriptWords(transcript);
  const targetCuts = parse(target, "cut-selection.json"), sourceCuts = parse(source, "cut-selection.json");
  if (!Array.isArray(targetCuts?.cutWordIds) || !Array.isArray(sourceCuts?.cutWordIds)) bad("Both projects require confirmed cut selections");
  const cuts = { ...targetCuts, cutWordIds: [...sourceCuts.cutWordIds.map(namespaced), ...targetCuts.cutWordIds],
    reasons: [...(sourceCuts.reasons ?? []).map((r: any) => ({ ...r, wordIds: r.wordIds.map(namespaced) })), ...(targetCuts.reasons ?? [])],
    cutRanges: [...(sourceCuts.cutRanges ?? []).map((r: any) => ({ ...r, source: imported.path, instanceId })),
      ...(targetCuts.cutRanges ?? []).map((r: any) => targetEdl.schemaVersion === 2 ? r : ({ ...r, source: targetSources[0]!.path, instanceId: baseInstance }))] };
  const cutRaw = json(cuts);
  const sources = existing ? targetSources : [...targetSources, imported];
  let cursor = 0;
  const segments = [...sourceEdl.segments.map(s => ({ ...s, id: namespaced(s.id), source: imported.path, instanceId })),
    ...targetEdl.segments.map(s => ({ ...s, instanceId: s.instanceId ?? baseInstance }))].map(s => {
      const next = { ...s, timelineStart: cursor }; cursor = Math.round((cursor + s.sourceEnd - s.sourceStart) * 1e6) / 1e6; return next;
    });
  const edl = parseEditListDocument({ ...targetEdl, schemaVersion: 2, sources, sourceDuration: Math.max(...sources.map(s => s.duration)),
    mode: "manual", segments, duration: cursor, baseTranscriptRevision: transcriptRevision, baseCutsRevision: hash(cutRaw) });
  const targetSubs = parse(target, "subtitles.json"), sourceSubs = parse(source, "subtitles.json");
  if (targetSubs && sourceSubs?.cues?.length && JSON.stringify(sourceSubs.style) !== JSON.stringify(targetSubs.style)) bad("Source subtitle style differs; import captions separately rather than discard styling");
  const subtitles = targetSubs || sourceSubs ? { ...(targetSubs ?? sourceSubs), projectId: edl.projectId, baseTranscriptRevision: transcriptRevision,
    cues: [...(sourceSubs?.cues ?? []).map((c: any) => ({ ...c, id: namespaced(c.id), wordIds: c.wordIds.map(namespaced) })), ...(targetSubs?.cues ?? [])] } : null;
  // Preserve existing provenance/review as old-revision evidence. The normal
  // source-revision checker reports it stale; do not relabel it as regenerated.
  const targetVisuals = parse(target, "visuals.json");
  const visuals = targetVisuals ? { ...targetVisuals, baseTranscriptRevision: transcriptRevision } : null;
  const after: ProjectFiles = { ...target, "transcript.json": transcriptRaw, "cut-selection.json": cutRaw,
    "edit-list.json": json(edl), "subtitles.json": subtitles ? json(subtitles) : null, "visuals.json": visuals ? json(visuals) : null };
  validateDocumentBindings(after, edl);
  if (!target["index.html"]?.includes("generated-by:")) bad("Target requires a product-generated index");
  after["index.html"] = patchKouboProjectIndex(target["index.html"]!, edl, hash(after["edit-list.json"]!));
  const oldWords = parseTranscriptWords(targetTranscript);
  const verifyShift = (before: Array<any>, next: Array<any>, key: string) => {
    for (const a of before) { const b = next.find(x => x[key] === a[key]);
      if (!b || b.orphaned !== a.orphaned || !a.orphaned && (Math.abs(b.start - a.start - sourceEdl.duration) > 0.001 || Math.abs(b.end - a.end - sourceEdl.duration) > 0.001)) bad(`Cannot preserve ${key} timing: ${a[key]}`);
    }
  };
  if (targetSubs) verifyShift(subtitleCueTimings(targetSubs, oldWords, targetEdl), subtitleCueTimings(subtitles, words, edl), "cueId");
  if (targetVisuals) verifyShift(visualLayerTimings(targetVisuals, oldWords, targetEdl), visualLayerTimings(visuals, words, edl), "layerId");
  return { after, imported, original, sources, sourceSources, targetSources, summary: { mode: "prepend", addedDuration: sourceEdl.duration, duration: edl.duration,
    previousDuration: targetEdl.duration, sourceCount: sources.length, addedSubtitleScreens: sourceSubs?.cues?.length ?? 0,
    newNarrationHasSubtitles: Boolean(sourceSubs?.cues?.length), retainedSubtitleScreens: targetSubs?.cues?.length ?? 0,
    retainedVisualLayers: targetVisuals?.layers?.length ?? 0, transcriptWords: words.length, editListRevision: hash(after["edit-list.json"]!) } };
}

/** Bind the instance-aware deletion result to the exact persisted input bytes. */
export function buildSegmentCutDocuments(before: ProjectFiles, clipIds: string[], operationId: string, removeVisualLayerIds?: string[], reviewedVisualReplacements?: ReviewedVisualReplacement[]) {
  return buildWordCutDocuments(before, clipIds, operationId, "segment-cuts", removeVisualLayerIds, reviewedVisualReplacements);
}

export function buildWordCutDocuments(before: ProjectFiles, wordIds: string[], operationId: string, kind: "word-cuts" | "segment-cuts" = "word-cuts", removeVisualLayerIds?: string[], reviewedVisualReplacements?: ReviewedVisualReplacement[]) {
  const edl = parseEditListDocument(parse(before, "edit-list.json"));
  if (edl.schemaVersion !== 2) bad("Word-cuts requires an explicit multisource v2 EDL");
  if (edl.baseTranscriptRevision !== hash(before["transcript.json"] ?? "") || edl.baseCutsRevision !== hash(before["cut-selection.json"] ?? "")) bad("EDL must bind the current transcript and cuts revisions");
  validateDocumentBindings(before, edl);
  const input = { editList: edl, words: parseTranscriptWords(parse(before, "transcript.json")), cutSelection: parse(before, "cut-selection.json"),
    subtitles: parse(before, "subtitles.json"), visuals: parse(before, "visuals.json"), operationId, reviewedVisualReplacements };
  const built = kind === "segment-cuts" ? buildMultisourceSegmentCuts({ ...input, clipIds: wordIds, removeVisualLayerIds }) : buildMultisourceWordCuts({ ...input, wordIds });
  const cutsRaw = json(built.cutSelection);
  const afterEdl = parseEditListDocument({ ...built.editList, baseCutsRevision: hash(cutsRaw) });
  const after: ProjectFiles = { ...before, "cut-selection.json": cutsRaw, "edit-list.json": json(afterEdl),
    "subtitles.json": built.subtitles === null ? null : json(built.subtitles), "visuals.json": built.visuals === null ? null : json(built.visuals) };
  validateDocumentBindings(after, afterEdl);
  if (!before["index.html"]?.includes("generated-by:")) bad("Target requires a product-generated index");
  after["index.html"] = patchKouboProjectIndex(before["index.html"]!, afterEdl, hash(after["edit-list.json"]!));
  return { after, summary: built.summary, sources: sourcesFor(before, edl) };
}

/** Verify the entire immutable package, not merely a path that looks published. */
async function verifyReviewedModules(directory: string, replacements: readonly ReviewedVisualReplacement[]) {
  for (const replacement of replacements) {
    try {
      const parts = replacement.module.split("/");
      const prefix = parts.slice(0, 4).join("/");
      const manifest = validateModuleManifest(JSON.parse((await readModuleFile(directory, `${prefix}/module-manifest.json`, 65536)).toString("utf8")));
      if (manifest.moduleId !== parts[2] || manifest.version !== parts[3] || `${prefix}/${manifest.entry}` !== replacement.module
        || hash(JSON.stringify(manifest)) !== replacement.expectedModuleDigest) throw Error("Published module identity or digest mismatch");
      for (const file of manifest.files) {
        const bytes = await readModuleFile(directory, `${prefix}/${file.path}`, 512 * 1024);
        if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw Error("Published module file hash mismatch");
        checkResources(file.path, bytes, manifest);
      }
    } catch (error) {
      throw new VideocutError("invalid_argument", "Reviewed replacement module is not a verified published package", {
        reason: "replacement_module_invalid", layerId: replacement.layerId, module: replacement.module,
        cause: error instanceof Error ? error.message : "Module verification failed",
        nextActions: ["verify_published_module_receipt_and_files", "review_replacement_before_replanning"],
      });
    }
  }
}

interface Options { projectsDir: string; port: number; isBusy: (directory: string) => Promise<boolean>; onChanged?: (projectId: string) => void; }
export function createMultisourceApi(options: Options) {
  const notify = (id: string) => { try { options.onChanged?.(id); } catch { /* Commit is durable; a UI notification cannot undo it. */ } };
  return async (request: Request, client?: string): Promise<Response | null> => {
    const url = new URL(request.url), match = /^\/api\/v1\/projects\/([^/]+)\/sources(?:\/operations\/([A-Za-z0-9_-]+)|\/(word-cuts|segment-cuts))?$/.exec(url.pathname);
    if (!match) return null;
    try {
      const origin = trustedLoopbackOrigin(request.headers.get("host"), options.port);
      if (!client || !isLoopbackAddress(client) || !origin || url.origin !== origin || request.headers.has("origin") && request.headers.get("origin") !== origin) return Response.json({ error: { code: "origin_forbidden" } }, { status: 403 });
      const id = decodeURIComponent(match[1]!); if (!safeId(id)) bad("Invalid project id");
      const directory = await realpath(resolve(options.projectsDir, id));
      if (request.method === "GET" && !match[3]) {
        if (match[2]) { const status = await getProjectTransactionStatus(directory, match[2]); return Response.json(status ?? { error: { code: "not_found" } }, { status: status ? 200 : 404 }); }
        return await serializeProjectOperation(directory, async () => { await assertProjectReadable(directory); const files = await snapshotProjectFiles(directory);
          assertIdentity(files, id);
          const edl = parseEditListDocument(parse(files, "edit-list.json")); return Response.json({ projectId: id, revision: projectFilesRevision(files), editListRevision: hash(files["edit-list.json"]!), sources: sourcesFor(files, edl), duration: edl.duration }); });
      }
      if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0] !== "application/json") bad("Use GET or application/json POST");
      const body = await readBody(request, match[3] ? 256 * 1024 : 8192);
      if (match[2]) {
        if (Object.keys(body).some(k => !["confirmed", "action"].includes(k)) || body.confirmed !== true || !["finish", "rollback"].includes(body.action)) bad("Explicit confirmed recovery action required");
        const result = await serializeProjectOperation(directory, async () => {
          if (await options.isBusy(directory)) throw new VideocutError("project_busy", "Wait for current project jobs");
          const record = await readProjectTransaction(directory, match[2]!);
          if (!record) return bad("Transaction not found");
          const chosen = body.action === "finish" ? record.after : record.before;
          assertIdentity(chosen, id);
          await resolveMainSources(directory, sourcesFor(chosen, parseEditListDocument(parse(chosen, "edit-list.json"))));
          if (body.action === "finish") {
            // This planner appends its reason. An older imported/manual reason
            // may carry the same operationId; it must not shadow this receipt.
            const replacements = parse(record.after, "cut-selection.json")?.reasons?.filter((r: any) => r.operationId === match[2]).at(-1)?.reviewedVisualReplacements ?? [];
            assertReviewedVisualReplacements(replacements);
            await verifyReviewedModules(directory, replacements);
          }
          return recoverProjectTransaction(directory, match[2]!, body.action);
        }); notify(id); return Response.json(result);
      }
      if (match[3]) {
        const kind = match[3] as "word-cuts" | "segment-cuts";
        const selectionKey = kind === "segment-cuts" ? "clipIds" : "wordIds";
        const selection = body[selectionKey];
        const allowed = new Set(["operationId", "expectedTargetRevision", selectionKey, "confirmed", "planRevision", "reviewedVisualReplacements"]);
        if (body.reviewedVisualReplacements !== undefined) assertReviewedVisualReplacements(body.reviewedVisualReplacements);
        if (kind === "segment-cuts") allowed.add("removeVisualLayerIds");
        if (body.removeVisualLayerIds !== undefined && (!Array.isArray(body.removeVisualLayerIds) || body.removeVisualLayerIds.length > 500 || body.removeVisualLayerIds.some((id: unknown) => typeof id !== "string" || !id.trim()) || new Set(body.removeVisualLayerIds).size !== body.removeVisualLayerIds.length)) bad("Invalid removeVisualLayerIds");
        if (Object.keys(body).some(k => !allowed.has(k)) || typeof body.operationId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(body.operationId) ||
          typeof body.expectedTargetRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedTargetRevision) || ![true, false].includes(body.confirmed) ||
          !Array.isArray(selection) || selection.length === 0 || selection.length > 500 || selection.some((id: unknown) => typeof id !== "string" || !id.trim()) || new Set(selection).size !== selection.length) bad(`Invalid ${kind} request: require 1–500 unique ${selectionKey} and exact project revision`);
        const inputKey = hash(json({ kind, operationId: body.operationId, expectedTargetRevision: body.expectedTargetRevision, [selectionKey]: selection,
          ...(kind === "segment-cuts" ? { removeVisualLayerIds: body.removeVisualLayerIds ?? [] } : {}),
          ...(body.reviewedVisualReplacements !== undefined ? { reviewedVisualReplacements: body.reviewedVisualReplacements } : {}) }));
        return await serializeProjectOperation(directory, async () => {
          await assertProjectReadable(directory);
          if (await options.isBusy(directory)) throw new VideocutError("project_busy", "Wait for project jobs before deleting words");
          const before = await snapshotProjectFiles(directory);
          assertIdentity(before, id);
          const old = await readProjectTransaction(directory, body.operationId);
          if (old && old.inputKey !== inputKey) throw new VideocutError("operation_id_conflict", "operationId has different inputs");
          if (old) {
            const status = await getProjectTransactionStatus(directory, body.operationId);
            if (status?.state === "prepared" || status?.state === "interrupted") throw new VideocutError("operation_in_progress", "Explicit recovery of the original operation is required");
            if (status?.state !== "committed") throw new VideocutError("operation_replay_stale", "Operation was rolled back or has subsequent changes");
          } else if (body.expectedTargetRevision !== projectFilesRevision(before)) throw new VideocutError("revision_conflict", "Read the exact target snapshot before planning word deletion");
          const built = buildWordCutDocuments(old?.before ?? before, selection, body.operationId, kind, body.removeVisualLayerIds, body.reviewedVisualReplacements);
          const afterRevision = projectFilesRevision(old?.after ?? built.after);
          if (old && projectFilesRevision(built.after) !== afterRevision) throw new VideocutError("operation_replay_conflict", "Saved operation differs from this planner; query its status instead of replaying");
          const planRevision = hash(json({ inputKey, afterRevision }));
          await resolveMainSources(directory, built.sources);
          await verifyReviewedModules(directory, body.reviewedVisualReplacements ?? []);
          const receipt = { mode: kind, operationId: body.operationId, summary: built.summary, deletion: built.summary, planRevision,
            targetRevision: projectFilesRevision(old?.before ?? before), afterRevision,
            restore: { method: "POST", path: `/api/v1/projects/${encodeURIComponent(id)}/sources/operations/${body.operationId}`,
              body: { confirmed: true, action: "rollback" }, requiresCurrentRevision: afterRevision, scope: "whole_transaction", subsequentEditsAllowed: false, redoSupported: false } };
          if (body.confirmed && body.planRevision !== planRevision) throw new VideocutError("revision_conflict", "Confirm the exact preview planRevision");
          if (old) return Response.json({ ...receipt, changed: false, committed: true, revision: afterRevision });
          if (!body.confirmed) return Response.json({ ...receipt, changed: false, committed: false });
          const result = await commitProjectTransaction(directory, { schemaVersion: 1, operationId: body.operationId, inputKey, before, after: built.after });
          notify(id); return Response.json({ ...receipt, ...result, committed: true });
        });
      }
      const allowed = new Set(["operationId", "sourceProjectId", "expectedTargetRevision", "expectedSourceRevision", "confirmed", "planRevision"]);
      if (Object.keys(body).some(k => !allowed.has(k)) || typeof body.operationId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(body.operationId) || !safeId(body.sourceProjectId) || ![true, false].includes(body.confirmed) || ![body.expectedTargetRevision, body.expectedSourceRevision].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) bad("Invalid prepend request");
      const sourceDirectory = await realpath(resolve(options.projectsDir, body.sourceProjectId));
      if (sourceDirectory === directory) bad("Cross-project import requires a different source project");
      const inputKey = hash(json({ operationId: body.operationId, sourceProjectId: body.sourceProjectId, expectedTargetRevision: body.expectedTargetRevision, expectedSourceRevision: body.expectedSourceRevision }));
      const dirs = [directory, sourceDirectory].sort();
      return await serializeProjectOperation(dirs[0]!, () => serializeProjectOperation(dirs[1]!, async () => {
        await assertProjectReadable(directory); await assertProjectReadable(sourceDirectory);
        if (await options.isBusy(directory) || await options.isBusy(sourceDirectory)) throw new VideocutError("project_busy", "Wait for project jobs before prepend");
        const before = await snapshotProjectFiles(directory), source = await snapshotProjectFiles(sourceDirectory);
        assertIdentity(before, id); assertIdentity(source, body.sourceProjectId);
        const old = await readProjectTransaction(directory, body.operationId);
        if (old) {
          if (old.inputKey !== inputKey) throw new VideocutError("operation_id_conflict", "operationId has different inputs");
          const status = await getProjectTransactionStatus(directory, body.operationId);
          if (status?.state === "prepared" || status?.state === "interrupted") throw new VideocutError("operation_in_progress", "Explicit recovery of the original operation is required");
          if (status?.state !== "committed") throw new VideocutError("operation_replay_stale", "Operation was rolled back or has subsequent changes");
          return Response.json({ changed: false, operationId: body.operationId, revision: projectFilesRevision(before) });
        }
        if (body.expectedTargetRevision !== projectFilesRevision(before) || body.expectedSourceRevision !== projectFilesRevision(source)) throw new VideocutError("revision_conflict", "Read both source and target snapshots before planning");
        const built = buildPrependDocuments(before, source, body.operationId);
        const sourcePaths = await resolveMainSources(sourceDirectory, built.sourceSources);
        await resolveMainSources(directory, built.targetSources);
        const planRevision = hash(json({ inputKey, afterRevision: projectFilesRevision(built.after), imported: built.imported }));
        if (!body.confirmed) return Response.json({ ...built.summary, planRevision, targetRevision: projectFilesRevision(before), sourceRevision: projectFilesRevision(source), committed: false });
        if (body.planRevision !== planRevision) throw new VideocutError("revision_conflict", "Confirm the exact preview planRevision");
        const dest = join(directory, built.imported.path);
        if (!built.targetSources.some(s => s.path === built.imported.path)) {
          let parent = directory;
          for (const part of built.imported.path.split("/").slice(0, -1)) { parent = join(parent, part); await mkdir(parent).catch((e: any) => { if (e.code !== "EEXIST") throw e; }); const s = await lstat(parent); if (!s.isDirectory() || s.isSymbolicLink()) bad("Unsafe source destination"); }
          await copyFile(sourcePaths[built.original.path]!, dest, constants.COPYFILE_EXCL).catch((e: any) => { if (e.code !== "EEXIST") throw e; });
        }
        await resolveMainSources(directory, built.sources);
        await resolveMainSources(sourceDirectory, built.sourceSources);
        const result = await commitProjectTransaction(directory, { schemaVersion: 1, operationId: body.operationId, inputKey, before, after: built.after });
        notify(id); return Response.json({ ...result, ...built.summary, planRevision });
      }));
    } catch (error) { const e = asVideocutError(error); return Response.json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, { status: ["revision_conflict", "project_busy", "operation_in_progress", "operation_replay_stale", "operation_replay_conflict", "operation_id_conflict"].includes(e.code) ? 409 : 400 }); }
  };
}
