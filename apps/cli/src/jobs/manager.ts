import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { link, lstat, mkdir, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DurableJob, JobKind } from "@video-workbench/contracts";
import { resolveProject, serializeProjectOperation } from "@video-workbench/core/node";
import {
  candidateForOutput,
  createExportSnapshot,
  defaultExportOutput,
  exportDependencyFingerprint,
  exportInputFingerprint,
  fileIdentity,
} from "./runners";
import { terminateOwnedProcessTree } from "./process";
import { RuntimeJobLock } from "./runtime-lock";
import { JobStore, JobStoreError, syncDirectory } from "./store";

interface AttemptLease {
  jobId: string;
  attempt: number;
  pid: number;
  token: string;
}

interface RunningWorker {
  child: ChildProcess;
  token: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  lease: AttemptLease | null;
}

export interface StartManagedJobInput {
  kind: JobKind;
  target: string;
  params?: Record<string, unknown>;
}

export interface JobManagerOptions {
  concurrency?: number;
  workerEntrypoint?: string;
  projectsDir?: string;
  /** Deterministic test seam immediately before the no-replace hard link. */
  beforePublishLink?: (job: DurableJob) => void | Promise<void>;
  /** Deterministic test seam before the publishing lease transaction. */
  beforePublishingLease?: (job: DurableJob) => void | Promise<void>;
  /** Deterministic test seam before spawn; launch re-checks shutdown afterward. */
  beforeWorkerSpawn?: (job: DurableJob) => void | Promise<void>;
}

function safeError(error: unknown, fallback = "job_failed"): { code: string; message: string; details?: Record<string, unknown> } {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : fallback,
      message: typeof value.message === "string" ? value.message : "Job failed",
      ...(value.details && typeof value.details === "object" && !Array.isArray(value.details)
        ? { details: value.details as Record<string, unknown> }
        : {}),
    };
  }
  return { code: fallback, message: String(error) };
}

function workerEntrypoint(explicit?: string): string {
  if (explicit) return explicit;
  const current = process.argv[1];
  if (current && /(?:^|[/\\])cli\.(?:ts|js)$/.test(current)) return resolve(current);
  return fileURLToPath(new URL("../cli.ts", import.meta.url));
}

function terminal(job: DurableJob): boolean {
  return ["succeeded", "failed", "cancelled", "recovery_blocked"].includes(job.state);
}

export class JobManager {
  readonly store: JobStore;
  readonly #concurrency: number;
  readonly #workerEntrypoint: string;
  readonly #projectsDir?: string;
  readonly #runtimeLock: RuntimeJobLock;
  readonly #workerSecret = randomBytes(32).toString("hex");
  readonly #beforePublishLink?: JobManagerOptions["beforePublishLink"];
  readonly #beforePublishingLease?: JobManagerOptions["beforePublishingLease"];
  readonly #beforeWorkerSpawn?: JobManagerOptions["beforeWorkerSpawn"];
  readonly #pending: string[] = [];
  readonly #pendingSet = new Set<string>();
  readonly #running = new Map<string, RunningWorker>();
  readonly #launching = new Set<string>();
  readonly #shutdownAttempts = new Set<string>();
  #initialized = false;
  #stopping = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(dataDir: string, options: JobManagerOptions = {}) {
    this.store = new JobStore(dataDir);
    this.#runtimeLock = new RuntimeJobLock(dataDir);
    this.#concurrency = options.concurrency ?? 1;
    this.#workerEntrypoint = workerEntrypoint(options.workerEntrypoint);
    this.#projectsDir = options.projectsDir;
    this.#beforePublishLink = options.beforePublishLink;
    this.#beforePublishingLease = options.beforePublishingLease;
    this.#beforeWorkerSpawn = options.beforeWorkerSpawn;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    if (this.#stopping) throw new JobStoreError("job_runtime_stopping", "Durable job Runtime is stopping");
    await this.#runtimeLock.acquire();
    try {
      await this.store.initialize();
      for (const job of await this.store.list()) await this.#recover(job);
      this.#initialized = true;
      this.#pump();
    } catch (error) {
      await this.#runtimeLock.release().catch(() => undefined);
      throw error;
    }
  }

  async start(input: StartManagedJobInput): Promise<DurableJob> {
    if (!this.#initialized || this.#stopping) {
      throw new JobStoreError("job_runtime_stopping", "Durable job Runtime is not accepting work");
    }
    if (input.kind !== "export") {
      throw new JobStoreError("unsupported_job_kind", `Job kind is not implemented: ${input.kind}`, {
        supportedKinds: ["export"],
      });
    }
    const project = await resolveProject(input.target, { projectsDir: this.#projectsDir });
    const params = input.params ?? {};
    const requestedOutput = params.outputPath;
    if (requestedOutput !== undefined && (typeof requestedOutput !== "string" || !requestedOutput)) {
      throw new JobStoreError("invalid_argument", "outputPath must be a non-empty string");
    }
    if (typeof requestedOutput === "string" && !isAbsolute(requestedOutput)) {
      throw new JobStoreError("invalid_argument", "outputPath must be absolute");
    }
    if (params.scale !== undefined && (typeof params.scale !== "number" || !Number.isFinite(params.scale) || params.scale <= 0 || params.scale > 4)) {
      throw new JobStoreError("invalid_argument", "scale must be a number greater than 0 and at most 4");
    }
    if (params.fps !== undefined && (typeof params.fps !== "number" || !Number.isFinite(params.fps) || params.fps < 1 || params.fps > 120)) {
      throw new JobStoreError("invalid_argument", "fps must be a number from 1 to 120");
    }
    if (params.keepWork !== undefined && typeof params.keepWork !== "boolean") {
      throw new JobStoreError("invalid_argument", "keepWork must be a boolean");
    }

    const jobId = randomUUID();
    const outputPath = resolve(
      typeof requestedOutput === "string" ? requestedOutput : defaultExportOutput(project.directory),
    );
    if (!dirname(outputPath) || dirname(outputPath) === outputPath) {
      throw new JobStoreError("invalid_argument", "outputPath must name a file below a directory");
    }
    const candidatePath = candidateForOutput(outputPath, jobId);
    const jobDirectory = this.store.jobDirectory(jobId);
    const workDirectory = resolve(jobDirectory, "work");
    const snapshotDirectory = resolve(jobDirectory, "snapshot");
    try {
      const frozen = await serializeProjectOperation(project.directory, async () => {
        const current = await resolveProject(project.directory, { cwd: "/" });
        const snapshot = await createExportSnapshot(current.directory, snapshotDirectory);
        const inputVideo = (current.project as Record<string, unknown>).inputVideo;
        if (typeof inputVideo !== "string" || !inputVideo.trim()) {
          throw new JobStoreError("invalid_project", "This project has no inputVideo to export");
        }
        const dependencyFingerprint = await exportDependencyFingerprint(current.directory, {
          excludePaths: [outputPath, candidatePath, jobDirectory],
          sourcePath: resolve(current.directory, inputVideo),
        });
        return { ...snapshot, dependencyFingerprint };
      });
      const job = await this.store.create({
        jobId,
        kind: "export",
        target: project.directory,
        targetKey: `project:${project.directory}`,
        projectId: project.projectId,
        frozen,
        params: {
          outputPath,
          candidatePath,
          workDirectory,
          snapshotDirectory,
          ...(typeof params.scale === "number" ? { scale: params.scale } : {}),
          ...(typeof params.fps === "number" ? { fps: params.fps } : {}),
          ...(params.keepWork === true ? { keepWork: true } : {}),
        },
      });
      this.#enqueue(job.jobId);
      this.#pump();
      return job;
    } catch (error) {
      // This path is generated from a fresh UUID and is asserted above, never
      // taken from an untrusted record.
      await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  read(jobId: string): Promise<DurableJob | null> { return this.store.read(jobId); }

  async list(filters: { projectId?: string; kind?: string; state?: string; limit?: number } = {}): Promise<DurableJob[]> {
    const jobs = await this.store.list(filters);
    return jobs.slice(0, filters.limit ?? 100);
  }

  async cancel(jobId: string): Promise<DurableJob> {
    const transitioned = await this.store.update(jobId, (value) => {
      if (terminal(value)) {
        throw new JobStoreError("job_not_cancellable", "Job is already terminal", {
          jobId, state: value.state,
        });
      }
      // This check lives in the same registry transaction as the transition.
      // Once a publishing lease exists, cancellation can no longer write over it.
      if (value.phase === "publishing") {
        throw new JobStoreError("job_not_cancellable", "Job is atomically publishing its verified output", {
          jobId, state: value.state, phase: value.phase,
        });
      }
      if (value.state === "cancelling") return value;
      const now = new Date().toISOString();
      if (value.state === "queued") {
        return {
          ...value,
          state: "cancelled",
          phase: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          owner: null,
        };
      }
      return { ...value, state: "cancelling", phase: "cancelling", cancelRequestedAt: now };
    });
    if (transitioned.state === "cancelled") {
      this.#pendingSet.delete(jobId);
      return transitioned;
    }
    if (transitioned.state !== "cancelling") return transitioned;
    const worker = this.#running.get(jobId);
    if (!worker || !transitioned.owner || !worker.lease || !this.#sameLease(transitioned, worker.lease)) {
      return this.#blockRecovery(transitioned, "job_process_unproven", "Running worker ownership is missing");
    }
    const result = await terminateOwnedProcessTree(transitioned.owner.pid, worker.token);
    if (result === "identity_mismatch" || result === "cleanup_failed") {
      return this.#blockRecovery(
        transitioned,
        "job_process_unproven",
        `Worker cleanup failed: ${result}`,
        {},
        worker.lease,
      );
    }
    await Promise.race([worker.closed, Bun.sleep(5_000)]);
    return (await this.store.read(jobId)) ?? transitioned;
  }

  shutdown(): Promise<void> {
    if (!this.#shutdownPromise) this.#shutdownPromise = this.#shutdown();
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    this.#stopping = true;
    // A launch that has entered its atomic record write must finish or roll
    // back before the singleton lock is released. Timing out here would let a
    // stale manager publish `running` after a replacement Runtime recovered.
    while (this.#launching.size > 0) await Bun.sleep(10);

    for (const [jobId, worker] of [...this.#running]) {
      const lease = worker.lease;
      if (!lease) continue;
      let job = await this.store.read(jobId);
      if (!job || !this.#sameLease(job, lease) || terminal(job)) continue;
      if (job.phase === "publishing") {
        // Publishing is non-cancellable. Settlement owns the filesystem link
        // and its final state; shutdown waits rather than writing over it.
        await worker.closed;
        while (this.#running.has(jobId)) await Bun.sleep(10);
        continue;
      }
      this.#shutdownAttempts.add(jobId);
      try {
        job = await this.store.update(jobId, (value) => {
          this.#assertLease(value, lease);
          if (value.phase === "publishing") {
            throw new JobStoreError("job_publish_in_progress", "Job entered publishing during shutdown", { jobId });
          }
          if (value.state !== "running" && value.state !== "cancelling") {
            throw new JobStoreError("job_state_conflict", "Job changed during shutdown", { jobId });
          }
          return { ...value, phase: "stopping" };
        });
      } catch (error) {
        if (error instanceof JobStoreError && error.code === "job_publish_in_progress") {
          this.#shutdownAttempts.delete(jobId);
          await worker.closed;
          while (this.#running.has(jobId)) await Bun.sleep(10);
          continue;
        }
        if (error instanceof JobStoreError && ["job_attempt_superseded", "job_state_conflict"].includes(error.code)) {
          this.#shutdownAttempts.delete(jobId);
          continue;
        }
        throw error;
      }
      const result = await terminateOwnedProcessTree(lease.pid, lease.token);
      if (result === "identity_mismatch" || result === "cleanup_failed") {
        await this.#blockRecovery(job, "job_process_unproven", `Worker cleanup failed: ${result}`, {}, lease);
      } else {
        await Promise.race([worker.closed, Bun.sleep(5_000)]);
        await this.#cleanupArtifacts(job);
        await this.store.update(jobId, (value) => {
          this.#assertLease(value, lease);
          if (value.phase !== "stopping") {
            throw new JobStoreError("job_state_conflict", "Job left its shutdown lease", { jobId });
          }
          return value.state === "cancelling" ? {
            ...value,
            state: "cancelled",
            phase: "cancelled",
            owner: null,
            finishedAt: new Date().toISOString(),
          } : {
            ...value,
            state: "queued",
            phase: "queued_after_shutdown",
            owner: null,
          };
        });
      }
      this.#shutdownAttempts.delete(jobId);
    }
    await this.#runtimeLock.release();
    this.#initialized = false;
  }

  async #recover(job: DurableJob): Promise<void> {
    if (job.state === "queued") {
      this.#enqueue(job.jobId);
      return;
    }
    if (job.state !== "running" && job.state !== "cancelling") return;
    if (!job.owner) {
      await this.#blockRecovery(job, "job_process_unproven", "Persisted running job has no owner");
      return;
    }
    const lease = this.#lease(job);
    const cleanup = await terminateOwnedProcessTree(job.owner.pid, job.owner.token);
    if (cleanup === "identity_mismatch" || cleanup === "cleanup_failed") {
      await this.#blockRecovery(job, "job_process_unproven", `Recovery cleanup failed: ${cleanup}`, {}, lease);
      return;
    }
    if (job.state === "running" && job.phase === "publishing") {
      await this.#recoverPublishing(job, lease);
      return;
    }
    await this.#cleanupArtifacts(job);
    if (job.state === "cancelling") {
      await this.store.update(job.jobId, (value) => {
        this.#assertLease(value, lease);
        return {
          ...value,
          state: "cancelled",
          phase: "cancelled",
          owner: null,
          finishedAt: new Date().toISOString(),
        };
      }, ["cancelling"]);
      return;
    }
    await this.store.update(job.jobId, (value) => {
      this.#assertLease(value, lease);
      return { ...value, state: "queued", phase: "queued_after_recovery", owner: null };
    }, ["running"]);
    this.#enqueue(job.jobId);
  }

  async #recoverPublishing(job: DurableJob, lease: AttemptLease): Promise<void> {
    const paths = this.store.exportPaths(job);
    const candidate = await this.#pathExists(paths.candidatePath);
    const output = await this.#pathExists(paths.outputPath);
    const expected = this.#persistedCandidateIdentity(job);
    if (!expected) {
      await this.#blockRecovery(job, "job_candidate_identity_missing", "Publishing record has no candidate identity", {}, lease);
      return;
    }

    if (output && candidate) {
      const [outputInfo, candidateInfo] = await Promise.all([
        lstat(paths.outputPath), lstat(paths.candidatePath),
      ]);
      const sameInode = outputInfo.isFile() && candidateInfo.isFile() &&
        outputInfo.dev === candidateInfo.dev && outputInfo.ino !== 0 && outputInfo.ino === candidateInfo.ino;
      const identitiesMatch = await this.#matchesIdentity(paths.outputPath, expected) &&
        await this.#matchesIdentity(paths.candidatePath, expected);
      if (!sameInode || !identitiesMatch) {
        await this.#blockRecovery(job, "job_publish_ambiguous", "Candidate and output are not the same verified hard link", {}, lease);
        return;
      }
      try {
        await unlink(paths.candidatePath);
        await syncDirectory(dirname(paths.outputPath));
      } catch (error) {
        await this.#blockRecovery(job, "job_publish_cleanup_failed", "Verified publish hard link could not be cleaned", {
          cause: safeError(error),
        }, lease);
        return;
      }
      await this.#finishRecoveredPublish(job, lease);
      return;
    }

    if (output && !candidate) {
      if (!(await this.#matchesIdentity(paths.outputPath, expected))) {
        await this.#blockRecovery(job, "job_published_output_mismatch", "Published output does not match the verified candidate", {}, lease);
        return;
      }
      await this.#finishRecoveredPublish(job, lease);
      return;
    }

    if (candidate && !output) {
      if (!(await this.#matchesIdentity(paths.candidatePath, expected))) {
        await this.#blockRecovery(job, "job_candidate_mismatch", "Candidate no longer matches its verified identity", {}, lease);
        return;
      }
      try {
        await serializeProjectOperation(job.target, async () => {
          await this.#assertCurrentDependencies(job);
          await this.#publishNoReplace(job);
        });
        await this.#finishRecoveredPublish(job, lease);
      } catch (error) {
        await this.#blockRecovery(job, "job_recovered_publish_failed", "Recovered candidate could not be safely published", {
          cause: safeError(error),
        }, lease);
      }
      return;
    }

    await this.#blockRecovery(job, "job_publish_ambiguous", "Cannot prove whether candidate was published", {}, lease);
  }

  async #finishRecoveredPublish(job: DurableJob, lease: AttemptLease): Promise<void> {
    await this.store.update(job.jobId, (value) => {
      this.#assertLease(value, lease);
      return {
        ...value,
        state: "succeeded",
        phase: "published",
        owner: null,
        finishedAt: new Date().toISOString(),
        error: null,
      };
    }, ["running"]);
  }

  #enqueue(jobId: string): void {
    if (this.#pendingSet.has(jobId)) return;
    this.#pending.push(jobId);
    this.#pendingSet.add(jobId);
  }

  #pump(): void {
    if (this.#stopping || !this.#initialized) return;
    while (this.#running.size + this.#launching.size < this.#concurrency && this.#pending.length > 0) {
      const jobId = this.#pending.shift()!;
      if (!this.#pendingSet.delete(jobId)) continue;
      this.#launching.add(jobId);
      void this.#launch(jobId).catch((error) => {
        console.error("[chengfeng-videocut] job launch failed", safeError(error));
      }).finally(() => {
        this.#launching.delete(jobId);
        this.#pump();
      });
    }
  }

  async #launch(jobId: string): Promise<void> {
    const queued = await this.store.read(jobId);
    if (!queued || queued.state !== "queued" || this.#stopping) return;
    await this.#beforeWorkerSpawn?.(queued);
    if (this.#stopping) return;

    const token = randomUUID();
    const child = spawn(process.execPath, [
      this.#workerEntrypoint,
      "__job-worker", jobId,
      "--data-dir", this.store.dataDir,
      "--owner-token", token,
    ], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CHENGFENG_JOB_OWNER_TOKEN: token,
        CHENGFENG_INTERNAL_JOB_WORKER_SECRET: this.#workerSecret,
      },
    });
    if (!child.pid) {
      await this.store.update(jobId, (value) => ({
        ...value,
        state: "failed",
        phase: "launch",
        finishedAt: new Date().toISOString(),
        error: { code: "job_worker_launch_failed", message: "Worker did not report a PID" },
      }), ["queued"]);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      let settled = false;
      const settle = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
        if (settled) return;
        settled = true;
        resolveClose(value);
      };
      child.once("error", (error) => {
        stderr = `${stderr}\n${error.message}`.slice(-8_000);
        settle({ code: 1, signal: null });
      });
      child.once("close", (code, signal) => settle({ code, signal }));
    });
    const worker: RunningWorker = { child, token, closed, lease: null };
    this.#running.set(jobId, worker);
    const now = new Date().toISOString();
    let runningJob: DurableJob;
    try {
      runningJob = await this.store.update(jobId, (value) => {
        if (this.#stopping) {
          throw new JobStoreError("job_runtime_stopping", "Runtime stopped during worker launch", { jobId });
        }
        return {
          ...value,
          state: "running",
          phase: "export",
          attempt: value.attempt + 1,
          owner: {
            pid: child.pid!,
            managerPid: process.pid,
            secretProof: createHmac("sha256", this.#workerSecret)
              .update(`${jobId}\0${token}\0${child.pid!}\0${value.attempt + 1}`)
              .digest("hex"),
            token,
            startedAt: now,
            heartbeatAt: now,
          },
          startedAt: value.startedAt ?? now,
          error: null,
          result: null,
        };
      }, ["queued"]);
    } catch (error) {
      const cleanup = await terminateOwnedProcessTree(child.pid, token);
      if (cleanup === "identity_mismatch" || cleanup === "cleanup_failed") {
        const current = await this.store.read(jobId);
        if (current) await this.#blockRecovery(current, "job_process_unproven", `Launch rollback failed: ${cleanup}`);
      } else {
        await Promise.race([closed, Bun.sleep(1_000)]);
        if (!(error instanceof JobStoreError && ["job_state_conflict", "job_runtime_stopping"].includes(error.code))) {
          try {
            await this.store.update(jobId, (value) => ({
              ...value,
              state: "failed",
              phase: "launch",
              owner: null,
              finishedAt: new Date().toISOString(),
              error: safeError(error, "job_launch_failed"),
            }), ["queued"]);
          } catch (persistError) {
            console.error("[chengfeng-videocut] could not persist job launch failure", safeError(persistError));
          }
        }
      }
      this.#running.delete(jobId);
      return;
    }
    const lease = this.#lease(runningJob);
    worker.lease = lease;
    this.#launching.delete(jobId);
    this.#pump();

    const exit = await closed;
    try {
      await this.#settle(lease, exit.code, exit.signal, stdout, stderr);
    } finally {
      if (this.#running.get(jobId) === worker) this.#running.delete(jobId);
      this.#shutdownAttempts.delete(jobId);
      this.#pump();
    }
  }

  async #settle(
    lease: AttemptLease,
    code: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
  ): Promise<void> {
    if (this.#shutdownAttempts.has(lease.jobId)) return;
    const job = await this.store.read(lease.jobId);
    if (!job || !this.#sameLease(job, lease) || terminal(job)) return;
    if (job.state === "cancelling") {
      await this.#cleanupArtifacts(job);
      try {
        await this.store.update(job.jobId, (value) => {
          this.#assertLease(value, lease);
          if (value.phase === "stopping") {
            throw new JobStoreError("job_shutdown_in_progress", "Runtime shutdown owns this attempt", {
              jobId: job.jobId,
            });
          }
          return {
            ...value,
            state: "cancelled",
            phase: "cancelled",
            owner: null,
            finishedAt: new Date().toISOString(),
          };
        }, ["cancelling"]);
      } catch (error) {
        if (!(error instanceof JobStoreError && [
          "job_state_conflict", "job_attempt_superseded", "job_shutdown_in_progress",
        ].includes(error.code))) throw error;
      }
      return;
    }
    if (code !== 0) {
      await this.#cleanupArtifacts(job);
      let workerError: unknown;
      try { workerError = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "").error; }
      catch { workerError = null; }
      await this.#failRunning(job, lease, "worker_exit", workerError
        ? safeError(workerError, "job_worker_failed")
        : {
            code: "job_worker_failed",
            message: "Export worker failed",
            details: { exitCode: code, signal, stderr: stderr.slice(-3_000) },
          });
      return;
    }

    let payload: { ok?: boolean; result?: Record<string, unknown>; error?: unknown };
    try { payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? ""); }
    catch { payload = { ok: false, error: { code: "job_worker_protocol", message: "Worker returned invalid JSON" } }; }
    if (!payload.ok || !payload.result) {
      await this.#cleanupArtifacts(job);
      await this.#failRunning(job, lease, "worker_result", safeError(payload.error, "job_worker_protocol"));
      return;
    }

    const paths = this.store.exportPaths(job);
    let linked = false;
    try {
      const expectedIdentity = this.#resultCandidateIdentity(payload.result);
      if (!expectedIdentity || !(await this.#matchesIdentity(paths.candidatePath, expectedIdentity))) {
        throw new JobStoreError("job_candidate_mismatch", "Worker candidate identity could not be verified", {
          jobId: job.jobId,
        });
      }
      if (payload.result.dependencyFingerprint !== job.frozen.dependencyFingerprint) {
        throw new JobStoreError("job_worker_protocol", "Worker did not prove the frozen dependency fingerprint", {
          jobId: job.jobId,
        });
      }
      await this.#beforePublishingLease?.(job);
      const publishing = await this.store.update(job.jobId, (value) => {
        this.#assertLease(value, lease);
        if (value.phase !== "export") {
          throw new JobStoreError("job_state_conflict", "Job no longer holds its export lease", {
            jobId: job.jobId,
            phase: value.phase,
          });
        }
        return {
          ...value,
          phase: "publishing",
          result: { ...payload.result!, output: paths.outputPath, outputPath: paths.outputPath },
        };
      }, ["running"]);
      await serializeProjectOperation(job.target, async () => {
        await this.#assertCurrentDependencies(publishing);
        await this.#beforePublishLink?.(publishing);
        await this.#publishNoReplace(publishing);
        linked = true;
      });
      await this.store.update(job.jobId, (value) => {
        this.#assertLease(value, lease);
        if (value.phase !== "publishing") {
          throw new JobStoreError("job_state_conflict", "Job lost its publishing lease", { jobId: job.jobId });
        }
        return {
          ...value,
          state: "succeeded",
          phase: "published",
          owner: null,
          finishedAt: new Date().toISOString(),
          error: null,
        };
      }, ["running"]);
    } catch (error) {
      const normalized = safeError(error, "job_publish_failed");
      const latestBeforeCleanup = await this.store.read(job.jobId);
      if (
        this.#shutdownAttempts.has(job.jobId) ||
        (latestBeforeCleanup && this.#sameLease(latestBeforeCleanup, lease) && latestBeforeCleanup.phase === "stopping")
      ) {
        return;
      }
      const createdOutput = linked || normalized.details?.outputLinked === true;
      if (createdOutput) {
        const latest = await this.store.read(job.jobId);
        if (latest && this.#sameLease(latest, lease) && latest.state === "running") {
          try {
            await this.#blockRecovery(latest, normalized.code, normalized.message, normalized.details ?? {}, lease);
          } catch (persistError) {
            console.error("[chengfeng-videocut] could not persist ambiguous publish", safeError(persistError));
          }
        }
        return;
      }
      await this.#cleanupArtifacts(job);
      await this.#failRunning(job, lease, "publish", normalized);
    }
  }

  async #assertCurrentDependencies(job: DurableJob): Promise<void> {
    const paths = this.store.exportPaths(job);
    const snapshot = await resolveProject(paths.snapshotDirectory, { cwd: "/" });
    if (await exportInputFingerprint(paths.snapshotDirectory) !== job.frozen.snapshotFingerprint) {
      throw new JobStoreError("job_snapshot_changed", "Immutable export snapshot no longer matches its identity", {
        jobId: job.jobId,
      });
    }
    const inputVideo = (snapshot.project as Record<string, unknown>).inputVideo;
    if (typeof inputVideo !== "string" || !inputVideo.trim()) {
      throw new JobStoreError("invalid_project", "Export snapshot has no inputVideo", { jobId: job.jobId });
    }
    const current = await exportDependencyFingerprint(job.target, {
      excludePaths: [paths.outputPath, paths.candidatePath, dirname(paths.snapshotDirectory)],
      sourcePath: resolve(job.target, inputVideo),
    });
    if (current !== job.frozen.dependencyFingerprint) {
      throw new JobStoreError("job_publish_conflict", "Project dependencies changed while export was running", {
        jobId: job.jobId,
        frozenFingerprint: job.frozen.dependencyFingerprint,
        currentFingerprint: current,
      });
    }
  }

  async #publishNoReplace(job: DurableJob): Promise<void> {
    const paths = this.store.exportPaths(job);
    const expected = this.#persistedCandidateIdentity(job);
    if (!expected || !(await this.#matchesIdentity(paths.candidatePath, expected))) {
      throw new JobStoreError("job_candidate_mismatch", "Candidate changed before atomic publish", {
        jobId: job.jobId,
      });
    }
    await mkdir(dirname(paths.outputPath), { recursive: true });
    try {
      await link(paths.candidatePath, paths.outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new JobStoreError("job_output_exists", "Export output already exists", {
          jobId: job.jobId,
          outputPath: paths.outputPath,
        });
      }
      throw error;
    }
    try {
      const [candidateInfo, outputInfo] = await Promise.all([
        lstat(paths.candidatePath), lstat(paths.outputPath),
      ]);
      if (
        !candidateInfo.isFile() || !outputInfo.isFile() ||
        candidateInfo.dev !== outputInfo.dev || candidateInfo.ino !== outputInfo.ino ||
        !(await this.#matchesIdentity(paths.outputPath, expected))
      ) {
        throw new JobStoreError("job_published_output_mismatch", "Atomic publish did not link the verified candidate", {
          jobId: job.jobId,
        });
      }
      await unlink(paths.candidatePath);
      await syncDirectory(dirname(paths.outputPath));
    } catch (error) {
      throw new JobStoreError("job_publish_cleanup_failed", "Output was linked but candidate cleanup was not durable", {
        jobId: job.jobId,
        outputPath: paths.outputPath,
        outputLinked: true,
        cause: safeError(error),
      });
    }
  }

  async #cleanupArtifacts(job: DurableJob): Promise<void> {
    const paths = this.store.exportPaths(job);
    await rm(paths.candidatePath, { force: true });
    await rm(paths.workDirectory, { recursive: true, force: true });
  }

  async #pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  #resultCandidateIdentity(result: Record<string, unknown>): { sha256: string; size: number } | null {
    return typeof result.candidateSha256 === "string" && /^[a-f0-9]{64}$/.test(result.candidateSha256) &&
      typeof result.candidateSize === "number" && Number.isSafeInteger(result.candidateSize) && result.candidateSize >= 0
      ? { sha256: result.candidateSha256, size: result.candidateSize }
      : null;
  }

  #persistedCandidateIdentity(job: DurableJob): { sha256: string; size: number } | null {
    return job.result ? this.#resultCandidateIdentity(job.result) : null;
  }

  async #matchesIdentity(path: string, expected: { sha256: string; size: number }): Promise<boolean> {
    try {
      const actual = await fileIdentity(path);
      return actual.sha256 === expected.sha256 && actual.size === expected.size;
    } catch {
      return false;
    }
  }

  async #failRunning(
    job: DurableJob,
    lease: AttemptLease,
    phase: string,
    error: { code: string; message: string; details?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.store.update(job.jobId, (value) => {
        this.#assertLease(value, lease);
        if (value.phase === "stopping") {
          throw new JobStoreError("job_shutdown_in_progress", "Runtime shutdown owns this attempt", {
            jobId: job.jobId,
          });
        }
        return {
          ...value,
          state: "failed",
          phase,
          owner: null,
          finishedAt: new Date().toISOString(),
          error,
        };
      }, ["running"]);
    } catch (transitionError) {
      if (!(transitionError instanceof JobStoreError && [
        "job_state_conflict", "job_attempt_superseded", "job_shutdown_in_progress",
      ].includes(transitionError.code))) {
        throw transitionError;
      }
      if (transitionError.code === "job_shutdown_in_progress") return;
      const latest = await this.store.read(job.jobId);
      if (latest?.state === "cancelling" && this.#sameLease(latest, lease)) {
        await this.#cleanupArtifacts(latest);
        await this.store.update(job.jobId, (value) => {
          this.#assertLease(value, lease);
          return {
            ...value,
            state: "cancelled",
            phase: "cancelled",
            owner: null,
            finishedAt: new Date().toISOString(),
            result: null,
          };
        }, ["cancelling"]);
      } else if (latest && !terminal(latest) && this.#sameLease(latest, lease)) {
        throw transitionError;
      }
    }
  }

  #blockRecovery(
    job: DurableJob,
    code: string,
    message: string,
    extraDetails: Record<string, unknown> = {},
    lease?: AttemptLease,
  ): Promise<DurableJob> {
    return this.store.update(job.jobId, (value) => {
      if (lease) this.#assertLease(value, lease);
      else this.#assertRecordVersion(value, job);
      return {
        ...value,
        state: "recovery_blocked",
        phase: "recovery_blocked",
        finishedAt: new Date().toISOString(),
        error: {
          code,
          message,
          details: { jobId: job.jobId, kind: job.kind, phase: job.phase, ...extraDetails },
        },
      };
    });
  }

  #lease(job: DurableJob): AttemptLease {
    if (!job.owner) throw new JobStoreError("job_process_unproven", "Job has no worker owner", { jobId: job.jobId });
    return { jobId: job.jobId, attempt: job.attempt, pid: job.owner.pid, token: job.owner.token };
  }

  #sameLease(job: DurableJob, lease: AttemptLease): boolean {
    return job.jobId === lease.jobId && job.attempt === lease.attempt &&
      job.owner?.pid === lease.pid && job.owner.token === lease.token;
  }

  #assertLease(job: DurableJob, lease: AttemptLease): void {
    if (!this.#sameLease(job, lease)) {
      throw new JobStoreError("job_attempt_superseded", "Worker attempt no longer owns this job", {
        jobId: lease.jobId,
        attempt: lease.attempt,
        actualAttempt: job.attempt,
      });
    }
  }

  #assertRecordVersion(current: DurableJob, expected: DurableJob): void {
    const currentToken = current.owner?.token ?? null;
    const expectedToken = expected.owner?.token ?? null;
    if (current.attempt !== expected.attempt || currentToken !== expectedToken) {
      throw new JobStoreError("job_attempt_superseded", "Job record changed before recovery transition", {
        jobId: expected.jobId,
      });
    }
  }
}
