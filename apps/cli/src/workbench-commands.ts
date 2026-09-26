export interface WorkbenchOperation {
  method: "GET" | "POST" | "PUT" | "PATCH";
  resource: string;
  project: boolean;
  capability: string;
  mode: "read" | "write" | "plan";
  fields: readonly string[];
  required: readonly string[];
  note: string;
}
const op = (resource: string, mode: WorkbenchOperation["mode"] = "read", fields: string[] = [], required: string[] = [], capability = "existingWorkflowApiVersion", method: WorkbenchOperation["method"] = mode === "read" ? "GET" : "POST", project = true, note = "Existing HTTP field semantics; no generated operation IDs or revisions."): WorkbenchOperation => ({ resource, mode, fields, required, capability, method, project, note });
export const WORKBENCH_OPERATIONS = {
  "sound-effects-get": op("sound-effects", "read", [], [], "soundEffectsApiVersion"),
  "sound-effects-asset-get": op("sound-effects/assets", "read", ["assetId"], ["assetId"], "soundEffectsApiVersion"),
  "sound-effects-set": op("sound-effects", "write", ["document", "expectedRevision", "expectedEditRevision", "confirmed"], ["document", "expectedRevision", "expectedEditRevision", "confirmed"], "soundEffectsApiVersion", "PUT"),
  "sound-effects-import": op("sound-effects/assets", "write", ["sourcePath", "expectedSourceSha256", "confirmed"], ["sourcePath", "expectedSourceSha256", "confirmed"], "soundEffectsApiVersion"),
  connect: op("/api/health", "read", [], [], "", "GET", false, "Read current product/version/PID/build and advertised API capabilities; does not start a service."),
  "workflow-get": op("workflow"),
  "edit-list-get": op("edit-list"),
  "edit-list-patch": op("edit-list", "write", ["expectedRevision", "operation", "actor"], ["expectedRevision", "operation"], undefined, "PATCH"),
  "cuts-get": op("cuts"),
  "subtitles-get": op("subtitles"),
  "visuals-get": op("visuals"),
  playback: op("playback", "read", ["limit", "cursor"], [], undefined, "GET", true, "limit 1..64; pass the opaque returned cursor unchanged."),
  targets: op("edit-targets", "read", ["clipIds", "paragraphs", "timeline", "text", "expectedRevision"], [], "editTargetsApiVersion", "POST", true, "Read-only EDL v2 targets. Choose exactly one selector; paragraphs are current Studio rows, text matches whole paragraphs. Returns full-project revision and related layers; never a deletion authorization."),
  "cuts-put": op("cuts", "write", ["expectedRevision", "operationId", "mode", "cutWordIds", "reasons"], ["expectedRevision", "operationId", "cutWordIds"], undefined, "PUT"),
  "workflow-action": op("actions", "write", ["action", "confirmed", "expectedRevision", "expectedEditListRevision", "config"], ["action", "expectedRevision"], undefined, "POST", true, "apply-cut requires expectedEditListRevision; start-final/confirm-storyboard/confirm-animation/confirm-timeline/request-render retain server gates."),
  "subtitle-inputs": op("subtitle-inputs", "read", [], [], undefined, "GET", true, "Stage exact transcript/edit-list/subtitles raw bytes in a NEW temporary directory. Returns inputDirectory/files; no production write."),
  "subtitle-submit": op("subtitles/candidate", "write", ["expectedRevision", "candidateDirectory"], ["expectedRevision", "candidateDirectory"], undefined, "POST", true, "Read subtitles.json and candidate-receipt.json from absolute ordinary candidate directory; reject INCOMPLETE, hashes/receipt mismatch; server performs authoritative source/result CAS."),
  "visuals-put": op("visuals", "write", ["expectedRevision", "document"], ["expectedRevision", "document"], undefined, "PUT"),
  "media-import": op("media-assets", "write", ["confirmed", "sourcePath", "expectedSourceSha256"], ["sourcePath", "expectedSourceSha256"], "mediaAssetsApiVersion"),
  "media-get": op("media-assets", "read", ["assetId"], ["assetId"], "mediaAssetsApiVersion"),
  "config-get": op("project-config", "read", [], [], "projectConfigApiVersion"),
  "config-set": op("project-config", "write", ["confirmed", "expectedRevision", "config"], ["expectedRevision", "config"], "projectConfigApiVersion", "PATCH"),
  "export-plan": op("export-plan", "read", ["profile"], [], undefined, "GET", true, "profile fast/master; snapshotFingerprint must be reviewed before export-start."),
  "export-start": op("/api/v1/jobs", "write", ["operationId", "expectedSnapshot", "outputPath", "profile"], ["operationId", "expectedSnapshot", "outputPath", "profile"], undefined, "POST", true, "Fixed kind=export,target=--project. Returns admission/job status, NOT finished film; query job-by-operation after uncertainty."),
  "job-get": op("/api/v1/jobs", "read", ["jobId"], ["jobId"]),
  "job-by-operation": op("/api/v1/jobs/by-operation", "read", ["operationId"], ["operationId"]),
  "job-list": op("/api/v1/jobs", "read", ["limit", "state"], [], undefined, "GET", true, "Project-bound export jobs only; never use a recent list to establish non-submission."),
  "job-cancel": op("/api/v1/jobs", "write", ["jobId"], ["jobId"], undefined, "POST", true, "Read and verify project-bound export job before cancellation; cancellation request is not completion."),
  "ingest-start": op("/api/v1/ingests", "write", ["confirmed", "operationId", "sourcePath", "expectedSourceSha256", "taskDirectory", "language", "aspectRatio"], ["operationId", "sourcePath", "expectedSourceSha256", "taskDirectory"], "ingestApiVersion", "POST", false, "Authorized WAV ASR may be paid. Preserve operationId and query ingest-status; never replay an unknown admission."),
  "ingest-status": op("/api/v1/ingests", "read", ["operationId"], ["operationId"], "ingestApiVersion", "GET", false),
  "transcript-correct": op("transcript-corrections", "write", ["confirmed", "operationId", "expectedRevision", "corrections"], ["operationId", "expectedRevision", "corrections"], "transcriptCorrectionApiVersion"),
  "sources-get": op("sources", "read", [], [], "multisourceAudioApiVersion"),
  "prepend-plan": op("sources", "plan", ["operationId", "sourceProjectId", "expectedTargetRevision", "expectedSourceRevision", "confirmed"], ["operationId", "sourceProjectId", "expectedTargetRevision", "expectedSourceRevision", "confirmed"], "multisourceAudioApiVersion"),
  "prepend-commit": op("sources", "write", ["operationId", "sourceProjectId", "expectedTargetRevision", "expectedSourceRevision", "confirmed", "planRevision"], ["operationId", "sourceProjectId", "expectedTargetRevision", "expectedSourceRevision", "confirmed", "planRevision"], "multisourceAudioApiVersion"),
  "word-cuts-plan": op("sources/word-cuts", "plan", ["operationId", "expectedTargetRevision", "wordIds", "reviewedVisualReplacements", "confirmed"], ["operationId", "expectedTargetRevision", "wordIds", "confirmed"], "multisourceAudio.wordCutsApiVersion"),
  "word-cuts-commit": op("sources/word-cuts", "write", ["operationId", "expectedTargetRevision", "wordIds", "reviewedVisualReplacements", "confirmed", "planRevision"], ["operationId", "expectedTargetRevision", "wordIds", "confirmed", "planRevision"], "multisourceAudio.wordCutsApiVersion"),
  "segment-cuts-plan": op("sources/segment-cuts", "plan", ["operationId", "expectedTargetRevision", "clipIds", "removeVisualLayerIds", "reviewedVisualReplacements", "confirmed"], ["operationId", "expectedTargetRevision", "clipIds", "confirmed"], "multisourceAudio.segmentCutsApiVersion"),
  "segment-cuts-commit": op("sources/segment-cuts", "write", ["operationId", "expectedTargetRevision", "clipIds", "removeVisualLayerIds", "reviewedVisualReplacements", "confirmed", "planRevision"], ["operationId", "expectedTargetRevision", "clipIds", "confirmed", "planRevision"], "multisourceAudio.segmentCutsApiVersion"),
  "operation-get": op("sources/operations", "read", ["operationId"], ["operationId"], "multisourceAudioApiVersion"),
  "operation-recover": op("sources/operations", "write", ["operationId", "confirmed", "action"], ["operationId", "action"], "multisourceAudioApiVersion", "POST", true, "Explicit finish/rollback of one unchanged transaction; query original operation before recovery. Not arbitrary undo/redo."),
} as const satisfies Record<string, WorkbenchOperation>;
export type WorkbenchOperationName = keyof typeof WORKBENCH_OPERATIONS;

export function workbenchCommands() {
  const fieldSchema = (name: string, operation: string): Record<string, unknown> => {
    if (name === "expectedRevision" && operation === "sound-effects-set") return {type:["string","null"],pattern:"^[a-f0-9]{64}$",description:"Exact sound-effects revision; null only when GET reports no document."};
    if (name === "confirmed") return { type: "boolean", description: "Plan must be false; write must agree with independent --confirmed authorization." };
    if (["document", "operation", "config"].includes(name)) return { type: "object", description: "Existing Runtime HTTP document/operation schema; server remains authoritative." };
    if (["cutWordIds", "wordIds", "clipIds", "removeVisualLayerIds"].includes(name)) return { type: "array", items: { type: "string" }, ...(operation === "targets" ? { minItems: 1, maxItems: 100, uniqueItems: true } : {}), description: "Exact IDs from current Runtime document, not times or regenerated IDs." };
    if (["reasons", "corrections"].includes(name)) return { type: "array", items: { type: "object" }, description: name === "corrections" ? "Each item: {wordId,text}; 1..500." : "Existing cuts reason records." };
    if (name === "reviewedVisualReplacements") return { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false,
      required: ["layerId", "module", "expectedModuleDigest", "wordIds", "animation"], properties: {
        layerId: { type: "string" }, module: { type: "string" }, expectedModuleDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        wordIds: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: { type: "string" } },
        animation: { type: "object", description: "Complete schemaVersion:1 local0 binding, authoredDuration, anchorWordIds and optional canvas; checked by Runtime." } } },
      description: "Requires multisourceAudio.reviewedVisualReplacementsApiVersion=1. Exact reviewed published modules for partially affected HTML layers; same data in plan and commit. No generated or stretched animations." };
    if (name === "paragraphs" || name === "timeline") return { type: "object", additionalProperties: false, required: ["start", "end"], properties: {
      start: { type: name === "paragraphs" ? "integer" : "number", minimum: name === "paragraphs" ? 1 : 0 },
      end: { type: name === "paragraphs" ? "integer" : "number", minimum: name === "paragraphs" ? 1 : 0 } }, description: name === "paragraphs" ? "Inclusive 1-based current Studio row range; at most 100." : "Half-open assembled timeline seconds, end > start." };
    if (name === "text") return { type: "string", minLength: 1, maxLength: 200, description: "Find whole paragraphs containing text; repeated occurrences require selection." };
    if (name === "limit") return { type: "integer", minimum: 1, maximum: operation === "playback" ? 64 : 100 };
    if (name === "profile") return { type: "string", enum: ["fast", "master"] };
    if (/Revision$|Snapshot$|Sha256$/.test(name) || name === "assetId") return { type: "string", pattern: name === "expectedRevision" && operation !== "targets" ? "^(none|[a-f0-9]{64})$" : "^[a-f0-9]{64}$", description: "Copy the exact reviewed Runtime revision/SHA; never substitute latest." };
    return { type: "string", description: /Path$|Directory$/.test(name) ? "Absolute local path; request/candidate files must be ordinary bounded files." : "Existing HTTP field; copied from user input or the exact Runtime receipt." };
  };
  const operations = Object.fromEntries(Object.entries(WORKBENCH_OPERATIONS).map(([name, spec]) => [name, { ...spec, inputSchema: { type: "object", additionalProperties: false, required: spec.required,
    ...(name === "targets" ? { oneOf: ["clipIds", "paragraphs", "timeline", "text"].map(field => ({ required: [field] })) } : {}),
    properties: Object.fromEntries(spec.fields.map(field => [field, fieldSchema(field, name)])) } }]));
  return { schemaVersion: 1, invocation: "workbench <operation> --api-base <HTTP-loopback-origin> [--project <id>] [--file <request.json>] [--confirmed] --json", operations,
    confirmation: 'Write operations require the independent --confirmed flag expressing prior user authorization. Only operations with mode:"plan" require JSON confirmed:false and cannot use --confirmed. export-plan has mode:"read" and accepts only profile; do not include confirmed. No implicit revisions/operation IDs.',
    moduleCommands: ["module publish <project-id> --file <module-manifest.json> --api-base <origin> --confirmed --json", "module get <project-id> <module-id> <version> --api-base <origin> --json"],
    boundaries: "Fixed existing HTTP operations only. No arbitrary URL/method/shell, local registry fallback, installation or service startup. Asynchronous acceptance is not completion." };
}
