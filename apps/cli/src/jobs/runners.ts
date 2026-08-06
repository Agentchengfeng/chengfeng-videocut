import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { resolveProject, serializeProjectOperation } from "@video-workbench/core/node";
import type { DurableJob, JobKind } from "@video-workbench/contracts";
import { executeExport } from "../export-command";
import { JobStore, JobStoreError } from "./store";

const EXPORT_INPUTS = ["project.json", "edit-list.json", "transcript.json", "subtitles.json", "visuals.json"];

export interface JobRunnerDefinition {
  kind: JobKind;
  recover: "rerun" | "checkpoint" | "unsupported";
}
export const JOB_RUNNERS: readonly JobRunnerDefinition[] = [
  { kind: "transcribe", recover: "checkpoint" },
  { kind: "cut", recover: "rerun" },
  { kind: "export", recover: "rerun" },
  { kind: "render", recover: "rerun" },
];

export async function exportInputFingerprint(projectDirectory: string): Promise<string> {
  const digest = createHash("sha256");
  for (const name of EXPORT_INPUTS) {
    digest.update(name);
    try { digest.update(await readFile(`${projectDirectory}/${name}`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("<missing>");
    }
  }
  return digest.digest("hex");
}

function stringParam(job: DurableJob, name: string): string {
  const value = job.params[name];
  if (typeof value !== "string" || !value) {
    throw new JobStoreError("invalid_job_record", `Export job is missing ${name}`, { jobId: job.jobId });
  }
  return value;
}

export async function runJobWorker(dataDir: string, jobId: string, ownerToken: string): Promise<void> {
  const store = new JobStore(dataDir);
  await store.initialize();
  let job: DurableJob | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = await store.read(jobId);
    if (job?.state === "running" && job.owner?.token === ownerToken) break;
    await Bun.sleep(10);
  }
  if (!job || job.state !== "running" || job.owner?.token !== ownerToken) {
    throw new JobStoreError("job_owner_mismatch", "Worker ownership was not persisted", { jobId });
  }
  if (job.kind !== "export") {
    throw new JobStoreError("unsupported_job_kind", `Job kind is not implemented: ${job.kind}`, {
      jobId,
      supportedKinds: ["export"],
    });
  }

  const project = await resolveProject(job.target, { cwd: "/" });
  const frozenFingerprint = job.frozen.inputFingerprint;
  const currentFingerprint = await serializeProjectOperation(project.directory, () =>
    exportInputFingerprint(project.directory));
  if (currentFingerprint !== frozenFingerprint) {
    throw new JobStoreError("job_input_changed", "Project changed before export started", {
      jobId,
      frozenFingerprint,
      currentFingerprint,
    });
  }

  const candidatePath = stringParam(job, "candidatePath");
  const workDirectory = stringParam(job, "workDirectory");
  await rm(candidatePath, { force: true });
  await rm(workDirectory, { recursive: true, force: true });
  await mkdir(dirname(candidatePath), { recursive: true });
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Worker stopped", "AbortError"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const result = await executeExport({
      project,
      outputPath: candidatePath,
      workDirectory,
      scale: typeof job.params.scale === "number" ? job.params.scale : undefined,
      fps: typeof job.params.fps === "number" ? job.params.fps : undefined,
      keepWork: Boolean(job.params.keepWork),
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
}

export function defaultExportOutput(projectDirectory: string): string {
  return `${projectDirectory}/成片.mp4`;
}

export function candidateForOutput(outputPath: string, jobId: string): string {
  return `${dirname(outputPath)}/.${basename(outputPath)}.${jobId}.candidate`;
}
