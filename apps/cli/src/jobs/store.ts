import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  JOB_SCHEMA_VERSION,
  type DurableJob,
  type JobState,
} from "@video-workbench/contracts";

const ACTIVE_STATES = new Set<JobState>(["queued", "running", "cancelling"]);

export class JobStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JobStoreError";
  }
}

export interface AtomicWriteHooks {
  afterFileSync?: (temporaryPath: string) => void | Promise<void>;
  beforeRename?: (temporaryPath: string, targetPath: string) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertJob(value: unknown, path: string): asserts value is DurableJob {
  if (!isRecord(value) || value.schemaVersion !== JOB_SCHEMA_VERSION) {
    throw new JobStoreError("job_store_corrupt", "Job record has an unsupported schema", { path });
  }
  const strings = ["jobId", "kind", "targetKey", "target", "state", "phase", "createdAt", "updatedAt"];
  if (strings.some((key) => typeof value[key] !== "string")) {
    throw new JobStoreError("job_store_corrupt", "Job record is missing required fields", { path });
  }
  if (!["transcribe", "cut", "export", "render"].includes(String(value.kind)) ||
      !["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "recovery_blocked"].includes(String(value.state)) ||
      !isRecord(value.params) || !isRecord(value.frozen)) {
    throw new JobStoreError("job_store_corrupt", "Job record contains invalid fields", { path });
  }
  const nullableStrings = ["cancelRequestedAt", "startedAt", "finishedAt"];
  const owner = value.owner;
  const progress = value.progress;
  const error = value.error;
  if (
    !/^[a-zA-Z0-9_-]+$/.test(String(value.jobId)) ||
    (value.projectId !== undefined && typeof value.projectId !== "string") ||
    !Number.isInteger(value.attempt) || Number(value.attempt) < 0 ||
    nullableStrings.some((key) => value[key] !== null && typeof value[key] !== "string") ||
    (value.result !== null && !isRecord(value.result)) ||
    (progress !== null && (!isRecord(progress) || typeof progress.done !== "number" || typeof progress.total !== "number")) ||
    (owner !== null && (!isRecord(owner) || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0 ||
      typeof owner.token !== "string" || typeof owner.startedAt !== "string" || typeof owner.heartbeatAt !== "string")) ||
    (error !== null && (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string" ||
      (error.details !== undefined && !isRecord(error.details))))
  ) {
    throw new JobStoreError("job_store_corrupt", "Job record failed schema validation", { path });
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const directory = resolve(path, "..");
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await hooks.afterFileSync?.(temporaryPath);
    await hooks.beforeRename?.(temporaryPath, path);
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export interface CreateJobInput extends Omit<DurableJob,
  "schemaVersion" | "jobId" | "state" | "phase" | "progress" | "attempt" | "owner" |
  "cancelRequestedAt" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "result" | "error"> {
  jobId?: string;
}

export class JobStore {
  readonly jobsDir: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string, private readonly hooks: AtomicWriteHooks = {}) {
    this.jobsDir = resolve(dataDir, "jobs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await this.list();
  }

  jobDirectory(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new JobStoreError("invalid_job_id", "Invalid job id", { jobId });
    }
    return join(this.jobsDir, jobId);
  }

  jobPath(jobId: string): string {
    return join(this.jobDirectory(jobId), "job.json");
  }

  async read(jobId: string): Promise<DurableJob | null> {
    const path = this.jobPath(jobId);
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch {
      throw new JobStoreError("job_store_corrupt", "Job record is not valid JSON", { path, jobId });
    }
    assertJob(value, path);
    if (value.jobId !== jobId) {
      throw new JobStoreError("job_store_corrupt", "Job id does not match its directory", { path, jobId });
    }
    return value;
  }

  async list(filters: { projectId?: string; kind?: string; state?: string } = {}): Promise<DurableJob[]> {
    await mkdir(this.jobsDir, { recursive: true });
    const entries = await readdir(this.jobsDir, { withFileTypes: true });
    const jobs: DurableJob[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const job = await this.read(entry.name);
      if (!job) continue;
      if (filters.projectId && job.projectId !== filters.projectId) continue;
      if (filters.kind && job.kind !== filters.kind) continue;
      if (filters.state && job.state !== filters.state) continue;
      jobs.push(job);
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(input: CreateJobInput): Promise<DurableJob> {
    return this.#withRegistryLock(async () => {
      const existing = (await this.list()).find((job) =>
        ACTIVE_STATES.has(job.state) && (
          job.targetKey === input.targetKey ||
          (typeof job.params.outputPath === "string" &&
            typeof input.params.outputPath === "string" &&
            job.params.outputPath === input.params.outputPath)
        ));
      if (existing) {
        throw new JobStoreError("job_target_conflict", "Target already has an active job", {
          existingJobId: existing.jobId,
          targetKey: input.targetKey,
        });
      }
      const now = new Date().toISOString();
      const job: DurableJob = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: input.jobId ?? randomUUID(),
        kind: input.kind,
        targetKey: input.targetKey,
        projectId: input.projectId,
        target: input.target,
        params: input.params,
        frozen: input.frozen,
        state: "queued",
        phase: "queued",
        progress: null,
        attempt: 0,
        owner: null,
        cancelRequestedAt: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      };
      await writeJsonAtomic(this.jobPath(job.jobId), job, this.hooks);
      return job;
    });
  }

  async update(
    jobId: string,
    updater: (job: DurableJob) => DurableJob,
    expectedStates?: readonly JobState[],
  ): Promise<DurableJob> {
    return this.#withRegistryLock(async () => {
      const current = await this.read(jobId);
      if (!current) throw new JobStoreError("job_not_found", "Job not found", { jobId });
      if (expectedStates && !expectedStates.includes(current.state)) {
        throw new JobStoreError("job_state_conflict", "Job state changed before the update", {
          jobId, expectedStates, actualState: current.state,
        });
      }
      const next = updater(structuredClone(current));
      next.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.jobPath(jobId), next, this.hooks);
      return next;
    });
  }

  async #withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      // The Runtime is the sole writer. Workers only read their immutable input
      // and return a result over stdout, so an in-process queue is the registry
      // transaction and there is no stale filesystem lock to guess at or reap.
      return await operation();
    } finally {
      release();
    }
  }
}
