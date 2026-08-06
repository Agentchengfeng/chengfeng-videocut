import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DurableJob, JobKind } from "@video-workbench/contracts";
import { resolveProject, serializeProjectOperation } from "@video-workbench/core/node";
import { candidateForOutput, defaultExportOutput, exportInputFingerprint } from "./runners";
import { terminateOwnedProcessTree } from "./process";
import { JobStore, JobStoreError } from "./store";

interface RunningWorker {
  child: ChildProcess;
  token: string;
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

export class JobManager {
  readonly store: JobStore;
  readonly #concurrency: number;
  readonly #workerEntrypoint: string;
  readonly #projectsDir?: string;
  readonly #pending: string[] = [];
  readonly #pendingSet = new Set<string>();
  readonly #running = new Map<string, RunningWorker>();
  readonly #launching = new Set<string>();
  readonly #cancelIntents = new Set<string>();
  #stopping = false;

  constructor(dataDir: string, options: JobManagerOptions = {}) {
    this.store = new JobStore(dataDir);
    this.#concurrency = options.concurrency ?? 1;
    this.#workerEntrypoint = workerEntrypoint(options.workerEntrypoint);
    this.#projectsDir = options.projectsDir;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    for (const job of await this.store.list()) await this.#recover(job);
    this.#pump();
  }

  async start(input: StartManagedJobInput): Promise<DurableJob> {
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
    if (params.scale !== undefined && (typeof params.scale !== "number" || params.scale <= 0 || params.scale > 4)) {
      throw new JobStoreError("invalid_argument", "scale must be a number greater than 0 and at most 4");
    }
    if (params.fps !== undefined && (typeof params.fps !== "number" || params.fps < 1 || params.fps > 120)) {
      throw new JobStoreError("invalid_argument", "fps must be a number from 1 to 120");
    }
    if (params.keepWork !== undefined && typeof params.keepWork !== "boolean") {
      throw new JobStoreError("invalid_argument", "keepWork must be a boolean");
    }
    const jobId = randomUUID();
    const outputPath = resolve(
      typeof requestedOutput === "string" ? requestedOutput : defaultExportOutput(project.directory),
    );
    const frozen = await serializeProjectOperation(project.directory, async () => ({
      inputFingerprint: await exportInputFingerprint(project.directory),
      projectRevision: (await resolveProject(project.directory)).projectRevision,
    }));
    const job = await this.store.create({
      jobId,
      kind: "export",
      target: project.directory,
      targetKey: `project:${project.directory}`,
      projectId: project.projectId,
      frozen,
      params: {
        outputPath,
        candidatePath: candidateForOutput(outputPath, jobId),
        workDirectory: `${this.store.jobDirectory(jobId)}/work`,
        ...(typeof params.scale === "number" ? { scale: params.scale } : {}),
        ...(typeof params.fps === "number" ? { fps: params.fps } : {}),
        ...(params.keepWork === true ? { keepWork: true } : {}),
      },
    });
    this.#enqueue(job.jobId);
    this.#pump();
    return job;
  }

  read(jobId: string): Promise<DurableJob | null> { return this.store.read(jobId); }
  async list(filters: { projectId?: string; kind?: string; state?: string; limit?: number } = {}): Promise<DurableJob[]> {
    const jobs = await this.store.list(filters);
    return jobs.slice(0, filters.limit ?? 100);
  }

  async cancel(jobId: string): Promise<DurableJob> {
    let cancelling: DurableJob;
    while (true) {
      const job = await this.store.read(jobId);
      if (!job) throw new JobStoreError("job_not_found", "Job not found", { jobId });
      if (["succeeded", "failed", "cancelled", "recovery_blocked"].includes(job.state)) {
        throw new JobStoreError("job_not_cancellable", "Job is already terminal", { jobId, state: job.state });
      }
      if (job.phase === "publishing") {
        throw new JobStoreError("job_not_cancellable", "Job is atomically publishing its verified output", {
          jobId, state: job.state, phase: job.phase,
        });
      }
      if (job.state === "cancelling") return job;
      try {
        if (job.state === "queued") {
          this.#pendingSet.delete(jobId);
          return await this.store.update(jobId, (value) => ({
            ...value,
            state: "cancelled",
            phase: "cancelled",
            cancelRequestedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            owner: null,
          }), ["queued"]);
        }
        cancelling = await this.store.update(jobId, (value) => ({
          ...value,
          state: "cancelling",
          phase: "cancelling",
          cancelRequestedAt: new Date().toISOString(),
        }), ["running"]);
        break;
      } catch (error) {
        if (error instanceof JobStoreError && error.code === "job_state_conflict") continue;
        throw error;
      }
    }
    this.#cancelIntents.add(jobId);
    const worker = this.#running.get(jobId);
    if (!worker || !cancelling.owner) {
      return this.#blockRecovery(cancelling, "job_process_unproven", "Running worker ownership is missing");
    }
    const result = await terminateOwnedProcessTree(cancelling.owner.pid, worker.token);
    if (result === "identity_mismatch" || result === "cleanup_failed") {
      return this.#blockRecovery(cancelling, "job_process_unproven", `Worker cleanup failed: ${result}`);
    }
    return (await this.store.read(jobId)) ?? cancelling;
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    for (const [jobId, worker] of [...this.#running]) {
      let job = await this.store.read(jobId);
      if (!job?.owner) continue;
      if (job.phase === "publishing") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && this.#running.has(jobId)) await Bun.sleep(20);
        job = await this.store.read(jobId);
        if (!job || ["succeeded", "failed", "recovery_blocked"].includes(job.state)) continue;
        await this.#blockRecovery(job, "job_publish_timeout", "Publishing did not settle before Runtime shutdown");
        continue;
      }
      const result = await terminateOwnedProcessTree(job.owner.pid, worker.token);
      if (result === "identity_mismatch" || result === "cleanup_failed") {
        await this.#blockRecovery(job, "job_process_unproven", `Worker cleanup failed: ${result}`);
      } else {
        await this.#cleanupArtifacts(job);
        await this.store.update(jobId, (value) => value.state === "cancelling" ? ({
          ...value, state: "cancelled", phase: "cancelled", owner: null,
          finishedAt: new Date().toISOString(),
        }) : ({
          ...value, state: "queued", phase: "queued_after_shutdown", owner: null,
        }));
      }
    }
    this.#running.clear();
  }

  async #recover(job: DurableJob): Promise<void> {
    if (job.state === "queued") { this.#enqueue(job.jobId); return; }
    if (job.state !== "running" && job.state !== "cancelling") return;
    if (!job.owner) {
      await this.#blockRecovery(job, "job_process_unproven", "Persisted running job has no owner");
      return;
    }
    const cleanup = await terminateOwnedProcessTree(job.owner.pid, job.owner.token);
    if (cleanup === "identity_mismatch" || cleanup === "cleanup_failed") {
      await this.#blockRecovery(job, "job_process_unproven", `Recovery cleanup failed: ${cleanup}`);
      return;
    }
    if (job.state === "running" && job.phase === "publishing") {
      const candidate = typeof job.params.candidatePath === "string" && await this.#pathExists(job.params.candidatePath);
      const output = typeof job.params.outputPath === "string" && await this.#pathExists(job.params.outputPath);
      if (output && !candidate && job.result) {
        await this.store.update(job.jobId, (value) => ({
          ...value, state: "succeeded", phase: "published", owner: null,
          finishedAt: new Date().toISOString(), error: null,
        }), ["running"]);
        return;
      }
      if (!(candidate && !output)) {
        await this.#blockRecovery(job, "job_publish_ambiguous", "Cannot prove whether candidate was published");
        return;
      }
    }
    await this.#cleanupArtifacts(job);
    if (job.state === "cancelling") {
      await this.store.update(job.jobId, (value) => ({
        ...value, state: "cancelled", phase: "cancelled", owner: null,
        finishedAt: new Date().toISOString(),
      }), ["cancelling"]);
      return;
    }
    await this.store.update(job.jobId, (value) => ({
      ...value, state: "queued", phase: "queued_after_recovery", owner: null,
    }));
    this.#enqueue(job.jobId);
  }

  #enqueue(jobId: string): void {
    if (this.#pendingSet.has(jobId)) return;
    this.#pending.push(jobId);
    this.#pendingSet.add(jobId);
  }

  #pump(): void {
    if (this.#stopping) return;
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
    const job = await this.store.read(jobId);
    if (!job || job.state !== "queued" || this.#stopping) { this.#pump(); return; }
    const token = randomUUID();
    const child = spawn(process.execPath, [
      this.#workerEntrypoint,
      "__job-worker", jobId,
      "--data-dir", this.store.dataDir,
      "--owner-token", token,
    ], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHENGFENG_JOB_OWNER_TOKEN: token },
    });
    if (!child.pid) {
      await this.store.update(jobId, (value) => ({
        ...value, state: "failed", phase: "launch", finishedAt: new Date().toISOString(),
        error: { code: "job_worker_launch_failed", message: "Worker did not report a PID" },
      }));
      this.#pump();
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
    this.#running.set(jobId, { child, token });
    const now = new Date().toISOString();
    try {
      await this.store.update(jobId, (value) => ({
        ...value,
        state: "running",
        phase: "export",
        attempt: value.attempt + 1,
        owner: { pid: child.pid!, token, startedAt: now, heartbeatAt: now },
        startedAt: value.startedAt ?? now,
        error: null,
        result: null,
      }), ["queued"]);
    } catch (error) {
      const cleanup = await terminateOwnedProcessTree(child.pid, token);
      if (cleanup === "identity_mismatch" || cleanup === "cleanup_failed") {
        const current = await this.store.read(jobId);
        if (current) {
          await this.#blockRecovery(current, "job_process_unproven", `Launch rollback failed: ${cleanup}`);
        }
        this.#running.delete(jobId);
        this.#pump();
        return;
      }
      await Promise.race([closed, Bun.sleep(1_000)]);
      this.#running.delete(jobId);
      this.#pump();
      if (!(error instanceof JobStoreError && error.code === "job_state_conflict")) {
        try {
          await this.store.update(jobId, (value) => ({
            ...value, state: "failed", phase: "launch", owner: null,
            finishedAt: new Date().toISOString(), error: safeError(error, "job_launch_failed"),
          }), ["queued"]);
        } catch (persistError) {
          console.error("[chengfeng-videocut] could not persist job launch failure", safeError(persistError));
        }
      }
      return;
    }
    const exit = await closed;
    try {
      await this.#settle(jobId, exit.code, exit.signal, stdout, stderr);
    } finally {
      this.#running.delete(jobId);
      this.#cancelIntents.delete(jobId);
      this.#pump();
    }
  }

  async #settle(jobId: string, code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): Promise<void> {
    if (this.#stopping) return;
    const job = await this.store.read(jobId);
    if (!job || ["recovery_blocked", "cancelled"].includes(job.state)) return;
    if (job.state === "cancelling" || this.#cancelIntents.has(jobId)) {
      await this.#cleanupArtifacts(job);
      try {
        await this.store.update(jobId, (value) => ({
          ...value, state: "cancelled", phase: "cancelled", owner: null,
          finishedAt: new Date().toISOString(),
        }), ["cancelling"]);
      } catch (error) {
        if (!(error instanceof JobStoreError && error.code === "job_state_conflict")) throw error;
      }
      return;
    }
    if (code !== 0) {
      await this.#cleanupArtifacts(job);
      let workerError: unknown;
      try { workerError = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "").error; }
      catch { workerError = null; }
      await this.#failRunning(job, "worker_exit", workerError
        ? safeError(workerError, "job_worker_failed")
        : { code: "job_worker_failed", message: "Export worker failed", details: {
            exitCode: code, signal, stderr: stderr.slice(-3_000),
          } });
      return;
    }
    let payload: { ok?: boolean; result?: Record<string, unknown>; error?: unknown };
    try { payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? ""); }
    catch { payload = { ok: false, error: { code: "job_worker_protocol", message: "Worker returned invalid JSON" } }; }
    if (!payload.ok || !payload.result) {
      await this.#cleanupArtifacts(job);
      await this.#failRunning(job, "worker_result", safeError(payload.error, "job_worker_protocol"));
      return;
    }
    const projectDirectory = job.target;
    const candidatePath = String(job.params.candidatePath);
    const outputPath = String(job.params.outputPath);
    try {
      await this.store.update(jobId, (value) => ({
        ...value,
        phase: "publishing",
        result: { ...payload.result!, outputPath },
      }), ["running"]);
      await serializeProjectOperation(projectDirectory, async () => {
        const current = await exportInputFingerprint(projectDirectory);
        if (current !== job.frozen.inputFingerprint) {
          throw new JobStoreError("job_publish_conflict", "Project changed while export was running", {
            jobId, frozenFingerprint: job.frozen.inputFingerprint, currentFingerprint: current,
          });
        }
        await mkdir(dirname(outputPath), { recursive: true });
        try {
          await lstat(outputPath);
          throw new JobStoreError("job_output_exists", "Export output already exists", {
            jobId, outputPath,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(candidatePath, outputPath);
      });
      await this.store.update(jobId, (value) => ({
        ...value, state: "succeeded", phase: "published", owner: null,
        finishedAt: new Date().toISOString(), error: null,
      }), ["running"]);
    } catch (error) {
      if (error instanceof JobStoreError && error.code === "job_state_conflict") {
        const latest = await this.store.read(jobId);
        if (latest?.state === "cancelling") {
          await this.#cleanupArtifacts(latest);
          await this.store.update(jobId, (value) => ({
            ...value, state: "cancelled", phase: "cancelled", owner: null,
            finishedAt: new Date().toISOString(), result: null,
          }), ["cancelling"]);
          return;
        }
      }
      await this.#cleanupArtifacts(job);
      await this.#failRunning(job, "publish", safeError(error, "job_publish_failed"));
    }
  }

  async #cleanupArtifacts(job: DurableJob): Promise<void> {
    const candidate = job.params.candidatePath;
    const work = job.params.workDirectory;
    if (typeof candidate === "string") await rm(candidate, { force: true });
    if (typeof work === "string") await rm(work, { recursive: true, force: true });
  }

  async #pathExists(path: string): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #failRunning(
    job: DurableJob,
    phase: string,
    error: { code: string; message: string; details?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.store.update(job.jobId, (value) => ({
        ...value, state: "failed", phase, owner: null,
        finishedAt: new Date().toISOString(), error,
      }), ["running"]);
    } catch (transitionError) {
      if (!(transitionError instanceof JobStoreError && transitionError.code === "job_state_conflict")) {
        throw transitionError;
      }
      const latest = await this.store.read(job.jobId);
      if (latest?.state === "cancelling") {
        await this.#cleanupArtifacts(latest);
        await this.store.update(job.jobId, (value) => ({
          ...value, state: "cancelled", phase: "cancelled", owner: null,
          finishedAt: new Date().toISOString(), result: null,
        }), ["cancelling"]);
      } else if (latest && !["succeeded", "failed", "cancelled", "recovery_blocked"].includes(latest.state)) {
        throw transitionError;
      }
    }
  }

  #blockRecovery(job: DurableJob, code: string, message: string): Promise<DurableJob> {
    return this.store.update(job.jobId, (value) => ({
      ...value,
      state: "recovery_blocked",
      phase: "recovery_blocked",
      finishedAt: new Date().toISOString(),
      error: { code, message, details: { jobId: job.jobId, kind: job.kind, phase: job.phase } },
    }));
  }
}
