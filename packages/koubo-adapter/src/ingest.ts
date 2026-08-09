import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VideocutError } from "@video-workbench/core";
import { serializeProjectOperation } from "@video-workbench/core/node";
import {
  createKouboProject,
  normalizeKouboTranscript,
  type CreateKouboProjectOptions,
  type CreatedKouboProject,
} from "./project";
import {
  transcribeKouboVideo,
  type TranscribeKouboVideoOptions,
} from "./transcription";

const INGEST_TRANSCRIPTION_CONTRACT = "volcengine-source-transcript-v1";

const MANAGED_PROJECT_OUTPUTS = [
  "project.json",
  "transcript.json",
  "cut-selection.json",
  "edit-list.json",
  "index.html",
  "workbench.json",
  "events.jsonl",
  "剪口播/1_转录/subtitles_words.json",
  "剪口播/3_审核/natural_pause_plan.json",
] as const;

export interface IngestKouboProjectOptions {
  video: string;
  language?: string;
  aspectRatio?: string;
  transcription?: Omit<
    TranscribeKouboVideoOptions,
    "video" | "output" | "language"
  >;
  create?: Omit<CreateKouboProjectOptions, "video" | "transcript" | "aspectRatio">;
  /**
   * Product registration authority for a response-loss retry. Existing files
   * are never accepted as success until the caller proves this exact directory
   * is still the registered project identity.
   */
  verifyExisting?: (project: CreatedKouboProject) => void | Promise<void>;
  /** Test/embedding seam; the public Product contract still owns the staging role. */
  runTranscription?: typeof transcribeKouboVideo;
}

export interface IngestKouboProjectResult extends CreatedKouboProject {
  transcription: {
    role: "source-transcript";
    provider: "volcengine";
    reused: boolean;
    reusedProject: boolean;
  };
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

async function directoryEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function resolveTaskDirectory(inputDirectory: string): Promise<string> {
  try {
    const directory = await realpath(resolve(inputDirectory));
    if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
    return directory;
  } catch (error) {
    throw new VideocutError(
      "invalid_argument",
      `project ingest requires an existing task directory: ${resolve(inputDirectory)}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function assertTaskRelativeVideo(jobDir: string, video: string): void {
  if (!video.trim() || isAbsolute(video)) {
    throw new VideocutError(
      "invalid_argument",
      "project ingest --video must be a non-empty task-relative path",
      { video },
    );
  }
  const candidate = resolve(jobDir, video);
  const rel = relative(jobDir, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new VideocutError(
      "invalid_argument",
      "project ingest --video must stay inside the task directory",
      { video },
    );
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function resolveTaskVideo(
  jobDir: string,
  video: string,
): Promise<{ path: string; sha256: string }> {
  assertTaskRelativeVideo(jobDir, video);
  try {
    const path = await realpath(resolve(jobDir, video));
    const rel = relative(jobDir, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("resolved outside the task directory");
    }
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error("not a non-empty regular file");
    return { path, sha256: await sha256File(path) };
  } catch (error) {
    throw new VideocutError(
      "invalid_argument",
      "project ingest --video must name a non-empty task-local file",
      { video, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function transcriptionIdentity(options: IngestKouboProjectOptions): {
  language: string;
  resourceId: string;
  modelName: string;
} {
  return {
    language: options.language?.trim() || "zh-CN",
    resourceId: options.transcription?.resourceId?.trim()
      || process.env.VOLCENGINE_ASR_RESOURCE_ID?.trim()
      || "<runtime-default-resource>",
    modelName: options.transcription?.modelName?.trim()
      || process.env.VOLCENGINE_ASR_MODEL_NAME?.trim()
      || "<runtime-default-model>",
  };
}

function ingestStagePath(input: {
  video: string;
  mediaSha256: string;
  language: string;
  resourceId: string;
  modelName: string;
}): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ contract: INGEST_TRANSCRIPTION_CONTRACT, ...input }))
    .digest("hex");
  return `.chengfeng-videocut/ingest/${key}/source-transcript.json`;
}

async function assertReusableStage(input: {
  jobDir: string;
  stage: string;
  video: string;
  mediaSha256: string;
  language: string;
}): Promise<void> {
  const path = join(input.jobDir, input.stage);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular Product stage");
    const resolved = await realpath(path);
    const rel = relative(input.jobDir, resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("stage resolves outside the task directory");
    }
    const document = JSON.parse(await readFile(resolved, "utf8")) as {
      provider?: unknown;
      language?: unknown;
      media?: { source?: unknown; sha256?: unknown };
      cues?: unknown[];
    };
    if (
      document.provider !== "volcengine"
      || document.language !== input.language
      || document.media?.source !== input.video
      || document.media?.sha256 !== input.mediaSha256
      || !Array.isArray(document.cues)
      || document.cues.length === 0
    ) {
      throw new Error("stage identity does not match this ingest request");
    }
  } catch (error) {
    throw new VideocutError(
      "invalid_transcript",
      "Product ingest stage does not match the current video and transcription configuration",
      {
        reason: "ingest_stage_mismatch",
        video: input.video,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function assertFreshProjectState(jobDir: string): Promise<void> {
  for (const name of MANAGED_PROJECT_OUTPUTS) {
    const path = join(jobDir, name);
    if (await directoryEntryExists(path)) {
      throw new VideocutError(
        "project_id_conflict",
        `project ingest refuses an existing or partial project artifact: ${path}`,
        { projectId: jobDir.split(sep).at(-1), path },
      );
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readManagedJson(path: string): Promise<unknown> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular managed file");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new VideocutError(
      "project_id_conflict",
      `project ingest cannot verify an existing managed project artifact: ${path}`,
      { path, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

async function assertManagedFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
      throw new Error("not a non-empty regular managed file");
    }
  } catch (error) {
    throw new VideocutError(
      "project_id_conflict",
      `project ingest cannot verify an existing managed project artifact: ${path}`,
      { path, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * Recognizes only a fully-created Product project for response-loss recovery.
 * Any missing, foreign, symlinked, source-mismatched, or config-mismatched
 * state remains a conflict and is never repaired or overwritten here.
 */
async function verifyExistingProject(input: {
  jobDir: string;
  mediaSha256: string;
  stage: string;
  video: string;
  language: string;
  verifyRegistration?: IngestKouboProjectOptions["verifyExisting"];
}): Promise<CreatedKouboProject> {
  if (!input.verifyRegistration) {
    throw new VideocutError(
      "project_id_conflict",
      "project ingest requires Product registration verification before reusing an existing project",
      { projectId: basename(input.jobDir), reason: "ingest_registration_unverified" },
    );
  }

  const projectId = basename(input.jobDir);
  const videoExtension = extname(input.video).toLowerCase();
  const canonicalVideo = `input/source${videoExtension}`;
  const canonicalTranscript = "剪口播/1_转录/subtitles_words.json";
  for (const name of [...MANAGED_PROJECT_OUTPUTS, canonicalVideo]) {
    await assertManagedFile(join(input.jobDir, name));
  }
  const [projectValue, metadataValue, transcriptValue, canonicalTranscriptValue, cutsValue] =
    await Promise.all([
      readManagedJson(join(input.jobDir, "project.json")),
      readManagedJson(join(input.jobDir, "workbench.json")),
      readManagedJson(join(input.jobDir, "transcript.json")),
      readManagedJson(join(input.jobDir, canonicalTranscript)),
      readManagedJson(join(input.jobDir, "cut-selection.json")),
    ]);
  const project = record(projectValue);
  const metadata = record(metadataValue);
  const source = record(project?.source);
  const workbench = record(project?.workbench);
  const cuts = record(cutsValue);
  const transcript = record(transcriptValue);
  const canonical = record(canonicalTranscriptValue);
  const transcriptMedia = record(transcript?.media);
  const canonicalMedia = record(canonical?.media);
  const cutWordIds = Array.isArray(cuts?.cutWordIds) && cuts.cutWordIds.every((id) => typeof id === "string")
    ? cuts.cutWordIds as string[]
    : null;
  const canonicalVideoSha256 = await sha256File(join(input.jobDir, canonicalVideo));
  const normalizedTranscript = normalizeKouboTranscript(transcriptValue);
  const wordIdentity = (value: unknown) => JSON.stringify(
    normalizeKouboTranscript(value).cues.flatMap((cue) => cue.words),
  );
  const transcriptMatches = wordIdentity(transcriptValue) === wordIdentity(canonicalTranscriptValue);

  if (
    !project || !metadata || !transcript || !canonical || !cutWordIds
    || project.jobId !== projectId
    || project.inputVideo !== canonicalVideo
    || source?.path !== canonicalVideo
    || source?.sha256 !== input.mediaSha256
    || source?.immutable !== true
    || canonicalVideoSha256 !== input.mediaSha256
    || workbench?.projectId !== projectId
    || workbench?.surface !== "koubo"
    || metadata.projectId !== projectId
    || metadata.jobDir !== input.jobDir
    || metadata.videoSource !== canonicalVideo
    || metadata.sourceSha256 !== input.mediaSha256
    || metadata.transcriptSource !== canonicalTranscript
    || transcriptMedia?.sha256 !== input.mediaSha256
    || canonicalMedia?.sha256 !== input.mediaSha256
    || !transcriptMatches
    || !Array.isArray(transcript.cues)
    || transcript.cues.length === 0
  ) {
    throw new VideocutError(
      "project_id_conflict",
      "project ingest refuses an existing project whose Product identity or immutable source does not match",
      {
        projectId,
        reason: "ingest_existing_project_mismatch",
        projectJobId: project?.jobId,
        projectInputVideo: project?.inputVideo,
        projectSourcePath: source?.path,
        projectSourceSha256: source?.sha256,
        metadataProjectId: metadata?.projectId,
        metadataJobDir: metadata?.jobDir,
        metadataVideoSource: metadata?.videoSource,
        metadataSourceSha256: metadata?.sourceSha256,
        metadataTranscriptSource: metadata?.transcriptSource,
        canonicalVideoSha256,
        requestedSourceSha256: input.mediaSha256,
        transcriptMatches,
      },
    );
  }

  await assertReusableStage({
    jobDir: input.jobDir,
    stage: input.stage,
    video: input.video,
    mediaSha256: input.mediaSha256,
    language: input.language,
  });
  const stageValue = await readManagedJson(join(input.jobDir, input.stage));
  if (wordIdentity(transcriptValue) !== wordIdentity(stageValue)) {
    throw new VideocutError(
      "project_id_conflict",
      "project ingest refuses an existing project whose retained Product stage changed",
      { projectId, reason: "ingest_existing_stage_mismatch" },
    );
  }

  const existing: CreatedKouboProject = {
    projectId,
    directory: input.jobDir,
    metadata,
    transcript: normalizedTranscript,
    cutWordIds,
    indexWritten: false,
    canonicalVideo,
    canonicalTranscript,
  };
  await input.verifyRegistration(existing);
  return existing;
}

/**
 * Turns one real task-local video into a registered Product project without
 * exposing the raw ASR output name. A completed matching stage survives a
 * captured create/registration failure and is reused on the next invocation.
 *
 * Provider request-id recovery after process death is deliberately not claimed
 * here; that requires a durable transcription job rather than a path contract.
 */
export async function ingestKouboProject(
  inputDirectory: string,
  options: IngestKouboProjectOptions,
): Promise<IngestKouboProjectResult> {
  const jobDir = await resolveTaskDirectory(inputDirectory);
  const media = await resolveTaskVideo(jobDir, options.video);
  const identity = transcriptionIdentity(options);
  const stage = ingestStagePath({
    video: options.video,
    mediaSha256: media.sha256,
    ...identity,
  });

  const hasManagedProjectState = (await Promise.all(
    MANAGED_PROJECT_OUTPUTS.map((name) => directoryEntryExists(join(jobDir, name))),
  )).some(Boolean);
  if (hasManagedProjectState) {
    const existing = await verifyExistingProject({
      jobDir,
      mediaSha256: media.sha256,
      stage,
      video: options.video,
      language: identity.language,
      verifyRegistration: options.verifyExisting,
    });
    return {
      ...existing,
      transcription: {
        role: "source-transcript",
        provider: "volcengine",
        reused: true,
        reusedProject: true,
      },
    };
  }
  await assertFreshProjectState(jobDir);
  const stageDirectory = join(jobDir, dirname(stage));
  await mkdir(stageDirectory, { recursive: true });
  // This is deliberately a stage-local lock, not the shared project mutation
  // lock: remote ASR may take minutes and must not block Studio/project writes.
  const reusedStage = await serializeProjectOperation(stageDirectory, async () => {
    if (await directoryEntryExists(join(jobDir, stage))) {
      await assertReusableStage({
        jobDir,
        stage,
        video: options.video,
        mediaSha256: media.sha256,
        language: identity.language,
      });
      return true;
    }
    await (options.runTranscription ?? transcribeKouboVideo)(jobDir, {
      ...options.transcription,
      video: options.video,
      output: stage,
      language: identity.language,
    });
    await assertReusableStage({
      jobDir,
      stage,
      video: options.video,
      mediaSha256: media.sha256,
      language: identity.language,
    });
    return false;
  });

  let created: CreatedKouboProject;
  try {
    created = await createKouboProject(jobDir, {
      ...options.create,
      video: options.video,
      transcript: stage,
      aspectRatio: options.aspectRatio,
    });
  } catch (error) {
    // Two identical callers may both observe the fresh state before ASR. The
    // stage lock prevents duplicate transcription; the project lock lets one
    // create/register first. Recheck only that captured post-stage conflict,
    // and only through the same strict identity + registration verifier used
    // for a later response-loss retry.
    if (errorCode(error) !== "project_id_conflict" || !options.verifyExisting) throw error;
    const existing = await verifyExistingProject({
      jobDir,
      mediaSha256: media.sha256,
      stage,
      video: options.video,
      language: identity.language,
      verifyRegistration: options.verifyExisting,
    });
    return {
      ...existing,
      transcription: {
        role: "source-transcript",
        provider: "volcengine",
        reused: true,
        reusedProject: true,
      },
    };
  }
  return {
    ...created,
    transcription: {
      role: "source-transcript",
      provider: "volcengine",
      reused: reusedStage,
      reusedProject: false,
    },
  };
}
