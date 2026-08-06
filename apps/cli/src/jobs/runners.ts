import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { resolveProject, serializeProjectOperation } from "@video-workbench/core/node";
import type { DurableJob, JobKind } from "@video-workbench/contracts";
import { executeExport } from "../export-command";
import { JobStore, JobStoreError } from "./store";

const EXPORT_DOCUMENTS = [
  "project.json", "edit-list.json", "transcript.json", "subtitles.json", "visuals.json",
] as const;
const PROJECT_LOCK_DIRECTORY = ".chengfeng-videocut.write.lock";

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

/** Hash only the immutable document snapshot consumed by executeExport. */
export async function exportInputFingerprint(projectDirectory: string): Promise<string> {
  const directoryInfo = await lstat(projectDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new JobStoreError("job_snapshot_changed", "Export document snapshot is not a real directory", {
      projectDirectory,
    });
  }
  const digest = createHash("sha256");
  for (const name of EXPORT_DOCUMENTS) {
    digest.update(`${name}\0`);
    const path = join(projectDirectory, name);
    try {
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new JobStoreError("job_snapshot_changed", "Export snapshot document is not a regular file", {
          path,
        });
      }
      digest.update(await readFile(path));
      const after = await lstat(path);
      if (
        after.isSymbolicLink() || !after.isFile() ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs
      ) {
        throw new JobStoreError("job_snapshot_changed", "Export snapshot changed while it was being read", {
          path,
        });
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("<missing>");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function hashStableFile(
  digest: ReturnType<typeof createHash>,
  path: string,
  identity: string,
): Promise<void> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new JobStoreError("job_dependency_unsafe", "Export dependency is not a regular file", {
      path,
    });
  }
  digest.update(`file\0${identity}\0${before.size}\0`);
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  digest.update("\0");
  const after = await lstat(path);
  if (
    !after.isFile() || after.isSymbolicLink() ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs
  ) {
    throw new JobStoreError("job_dependency_changed", "Export dependency changed while it was being hashed", {
      path,
    });
  }
}

export interface ExportDependencyFingerprintOptions {
  excludePaths?: readonly string[];
  sourcePath?: string;
}

/**
 * Hash the complete project tree that the exporter can serve to an overlay,
 * plus an inputVideo outside the project root when one is configured.
 *
 * This deliberately over-approximates the dependency set. Missing one CSS or
 * module asset is unsafe; hashing an unrelated project note only causes a
 * conservative publish conflict.
 */
export async function exportDependencyFingerprint(
  projectDirectory: string,
  options: ExportDependencyFingerprintOptions = {},
): Promise<string> {
  const root = resolve(projectDirectory);
  const exclusions = new Set((options.excludePaths ?? []).map((path) => resolve(path)));
  const digest = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (exclusions.has(path)) continue;
      const rel = relative(root, path).split(sep).join("/");
      if (rel === PROJECT_LOCK_DIRECTORY || rel.startsWith(`${PROJECT_LOCK_DIRECTORY}/`)) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new JobStoreError("job_dependency_unsafe", "Export project contains a symbolic link", {
          path, relativePath: rel,
        });
      }
      if (info.isDirectory()) {
        digest.update(`dir\0${rel}\0`);
        await walk(path);
      } else if (info.isFile()) {
        await hashStableFile(digest, path, rel);
      } else {
        throw new JobStoreError("job_dependency_unsafe", "Export project contains a special filesystem entry", {
          path, relativePath: rel,
        });
      }
    }
  };
  await walk(root);

  if (options.sourcePath) {
    const source = resolve(options.sourcePath);
    const insideRoot = source === root || source.startsWith(`${root}${sep}`);
    if (!insideRoot) await hashStableFile(digest, source, "@external-input-video");
  }
  return digest.digest("hex");
}

export async function createExportSnapshot(
  projectDirectory: string,
  snapshotDirectory: string,
): Promise<{ projectRevision: string; snapshotFingerprint: string }> {
  await mkdir(dirname(snapshotDirectory), { recursive: true });
  try { await mkdir(snapshotDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JobStoreError("job_snapshot_exists", "Immutable export snapshot already exists", {
        snapshotDirectory,
      });
    }
    throw error;
  }
  for (const name of EXPORT_DOCUMENTS) {
    try {
      const bytes = await readFile(join(projectDirectory, name));
      await writeFile(join(snapshotDirectory, name), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || name === "project.json") throw error;
    }
  }
  const snapshotProject = await resolveProject(snapshotDirectory, { cwd: "/" });
  return {
    projectRevision: snapshotProject.projectRevision,
    snapshotFingerprint: await exportInputFingerprint(snapshotDirectory),
  };
}

export async function fileIdentity(path: string): Promise<{ sha256: string; size: number }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new JobStoreError("job_candidate_invalid", "Candidate is not a regular file", { path });
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  const after = await lstat(path);
  if (
    after.isSymbolicLink() || !after.isFile() ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs
  ) {
    throw new JobStoreError("job_candidate_changed", "Candidate changed while it was being verified", { path });
  }
  return { sha256: digest.digest("hex"), size: after.size };
}

function exportSourcePath(job: DurableJob, snapshotProject: Awaited<ReturnType<typeof resolveProject>>): string {
  const inputVideo = (snapshotProject.project as Record<string, unknown>).inputVideo;
  if (typeof inputVideo !== "string" || !inputVideo.trim()) {
    throw new JobStoreError("invalid_project", "This project has no inputVideo to export", {
      jobId: job.jobId,
    });
  }
  return resolve(job.target, inputVideo);
}

export async function runJobWorker(
  dataDir: string,
  jobId: string,
  ownerToken: string,
  workerSecret: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(workerSecret)) {
    throw new JobStoreError("job_worker_unauthorized", "Internal job worker capability is missing");
  }
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
  if (job.owner.managerPid !== process.ppid) {
    throw new JobStoreError("job_worker_unauthorized", "Internal worker was not spawned by its owning Runtime", {
      jobId,
    });
  }
  const expectedProof = createHmac("sha256", workerSecret)
    .update(`${job.jobId}\0${ownerToken}\0${job.owner.pid}\0${job.attempt}`)
    .digest();
  const persistedProof = typeof job.owner.secretProof === "string"
    ? Buffer.from(job.owner.secretProof, "hex")
    : Buffer.alloc(0);
  if (persistedProof.length !== expectedProof.length || !timingSafeEqual(persistedProof, expectedProof)) {
    throw new JobStoreError("job_worker_unauthorized", "Internal worker capability does not match its Runtime", {
      jobId,
    });
  }
  if (job.kind !== "export") {
    throw new JobStoreError("unsupported_job_kind", `Job kind is not implemented: ${job.kind}`, {
      jobId,
      supportedKinds: ["export"],
    });
  }

  const paths = store.exportPaths(job);
  const snapshotProject = await resolveProject(paths.snapshotDirectory, { cwd: "/" });
  const snapshotFingerprint = await exportInputFingerprint(paths.snapshotDirectory);
  if (snapshotFingerprint !== job.frozen.snapshotFingerprint) {
    throw new JobStoreError("job_snapshot_changed", "Immutable export snapshot no longer matches its identity", {
      jobId,
    });
  }
  const sourcePath = exportSourcePath(job, snapshotProject);
  const fingerprintOptions = {
    excludePaths: [paths.outputPath, paths.candidatePath, dirname(paths.snapshotDirectory)],
    sourcePath,
  } as const;
  const frozenFingerprint = job.frozen.dependencyFingerprint;
  const beforeFingerprint = await serializeProjectOperation(job.target, () =>
    exportDependencyFingerprint(job!.target, fingerprintOptions));
  if (beforeFingerprint !== frozenFingerprint) {
    throw new JobStoreError("job_input_changed", "Project dependencies changed before export started", {
      jobId,
      frozenFingerprint,
      currentFingerprint: beforeFingerprint,
    });
  }

  // Every destructive path has already been checked against the job directory
  // and output-derived candidate by JobStore.exportPaths.
  await rm(paths.candidatePath, { force: true });
  await rm(paths.workDirectory, { recursive: true, force: true });
  await mkdir(dirname(paths.candidatePath), { recursive: true });
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Worker stopped", "AbortError"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const result = await executeExport({
      project: snapshotProject,
      assetProjectDirectory: job.target,
      sourcePathOverride: sourcePath,
      outputPath: paths.candidatePath,
      workDirectory: paths.workDirectory,
      scale: typeof job.params.scale === "number" ? job.params.scale : undefined,
      fps: typeof job.params.fps === "number" ? job.params.fps : undefined,
      keepWork: Boolean(job.params.keepWork),
      signal: controller.signal,
    });
    const afterFingerprint = await serializeProjectOperation(job.target, () =>
      exportDependencyFingerprint(job!.target, fingerprintOptions));
    if (afterFingerprint !== frozenFingerprint) {
      throw new JobStoreError("job_input_changed", "Project dependencies changed while export was running", {
        jobId,
        frozenFingerprint,
        currentFingerprint: afterFingerprint,
      });
    }
    const identity = await fileIdentity(paths.candidatePath);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      result: {
        ...result,
        dependencyFingerprint: afterFingerprint,
        candidateSha256: identity.sha256,
        candidateSize: identity.size,
      },
    })}\n`);
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
}

export function defaultExportOutput(projectDirectory: string): string {
  return join(projectDirectory, "成片.mp4");
}

export function candidateForOutput(outputPath: string, jobId: string): string {
  return join(dirname(outputPath), `.${basename(outputPath)}.${jobId}.candidate`);
}
