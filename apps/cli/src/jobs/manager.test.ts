import { afterEach, describe, expect, it } from "bun:test";
import { link, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "./manager";
import {
  candidateForOutput,
  createExportSnapshot,
  exportDependencyFingerprint,
  fileIdentity,
} from "./runners";

const cleanup: string[] = [];
const managers: JobManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "job-manager-"));
  cleanup.push(root);
  const dataDir = join(root, "data");
  const projects = [join(root, "one"), join(root, "two")];
  for (const [index, project] of projects.entries()) {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "project.json"), JSON.stringify({ jobId: index ? "two" : "one", inputVideo: "input.mp4" }));
    await writeFile(join(project, "input.mp4"), `source-${index}`);
    await writeFile(join(project, "overlay.html"), `<p>overlay-${index}</p>`);
  }
  const slowWorker = join(root, "slow-worker.ts");
  await writeFile(slowWorker, "await Bun.sleep(60_000);\n");
  const successWorker = join(root, "success-worker.ts");
  await writeFile(successWorker, `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const argv = process.argv.slice(2);
const jobId = argv[1];
const dataDir = argv[argv.indexOf("--data-dir") + 1];
const token = process.env.CHENGFENG_JOB_OWNER_TOKEN;
let job;
for (let i = 0; i < 200; i++) {
  job = JSON.parse(await readFile(join(dataDir, "jobs", jobId, "job.json"), "utf8"));
  if (job.state === "running" && job.owner?.token === token) break;
  await Bun.sleep(10);
}
const candidate = "candidate";
await writeFile(job.params.candidatePath, candidate);
console.log(JSON.stringify({ ok: true, result: {
  worker: "test",
  dependencyFingerprint: job.frozen.dependencyFingerprint,
  candidateSha256: createHash("sha256").update(candidate).digest("hex"),
  candidateSize: Buffer.byteLength(candidate),
} }));
`);
  const delayedWorker = join(root, "delayed-worker.ts");
  await writeFile(delayedWorker, (await readFile(successWorker, "utf8")).replace(
    'const candidate = "candidate";',
    'await Bun.sleep(250);\nconst candidate = "candidate";',
  ));
  return { root, dataDir, projects, slowWorker, successWorker, delayedWorker };
}

async function createPersistedExport(
  manager: JobManager,
  input: { jobId: string; target: string; projectId: string; outputPath: string },
) {
  const candidatePath = candidateForOutput(input.outputPath, input.jobId);
  const jobDirectory = manager.store.jobDirectory(input.jobId);
  const snapshotDirectory = join(jobDirectory, "snapshot");
  const snapshot = await createExportSnapshot(input.target, snapshotDirectory);
  const dependencyFingerprint = await exportDependencyFingerprint(input.target, {
    excludePaths: [input.outputPath, candidatePath, jobDirectory],
    sourcePath: join(input.target, "input.mp4"),
  });
  return manager.store.create({
    jobId: input.jobId,
    kind: "export",
    target: input.target,
    targetKey: `project:${input.target}`,
    projectId: input.projectId,
    frozen: { ...snapshot, dependencyFingerprint },
    params: {
      outputPath: input.outputPath,
      candidatePath,
      workDirectory: join(jobDirectory, "work"),
      snapshotDirectory,
    },
  });
}

async function waitState(manager: JobManager, jobId: string, state: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = await manager.read(jobId);
    if (job?.state === state) return job;
    await Bun.sleep(20);
  }
  throw new Error(`job ${jobId} did not reach ${state}`);
}

describe("job manager", () => {
  it("rejects an existing default output before creating or running a job", async () => {
    const f = await fixture();
    const outputPath = join(f.projects[0]!, "成片.mp4");
    const canonicalOutputPath = join(await realpath(f.projects[0]!), "成片.mp4");
    await writeFile(outputPath, "previous-export");
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.initialize();

    let rejected: unknown;
    try {
      await manager.start({ kind: "export", target: f.projects[0]! });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code?: string }).code).toBe("job_output_exists");
    expect((rejected as { details?: { outputPath?: string } }).details?.outputPath).toBe(canonicalOutputPath);
    expect(await manager.list()).toEqual([]);
    expect(await readFile(outputPath, "utf8")).toBe("previous-export");
  });

  it("makes the publishing lease atomically non-cancellable", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const atPublish = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const continuePublish = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const manager = new JobManager(f.dataDir, {
      workerEntrypoint: f.successWorker,
      async beforePublishLink() {
        entered();
        await continuePublish;
      },
    });
    managers.push(manager);
    await manager.initialize();
    const started = await manager.start({
      kind: "export", target: f.projects[0]!, params: { outputPath: join(f.root, "atomic-cancel.mp4") },
    });
    await atPublish;
    await expect(manager.cancel(started.jobId)).rejects.toMatchObject({ code: "job_not_cancellable" });
    expect(await manager.read(started.jobId)).toMatchObject({ state: "running", phase: "publishing" });
    release();
    expect(await waitState(manager, started.jobId, "succeeded")).toMatchObject({ phase: "published" });
  });

  it("uses a no-replace publish primitive when output appears at the final seam", async () => {
    const f = await fixture();
    const outputPath = join(f.root, "publish-race.mp4");
    const manager = new JobManager(f.dataDir, {
      workerEntrypoint: f.successWorker,
      beforePublishLink: () => writeFile(outputPath, "unrelated-winner"),
    });
    managers.push(manager);
    await manager.initialize();
    const started = await manager.start({ kind: "export", target: f.projects[0]!, params: { outputPath } });
    const failed = await waitState(manager, started.jobId, "failed");
    expect(failed.error).toMatchObject({ code: "job_output_exists" });
    expect(await readFile(outputPath, "utf8")).toBe("unrelated-winner");
  });

  it("refuses cancellation after verified output enters the publishing phase", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "publishing.mp4");
    const job = await createPersistedExport(manager, {
      jobId: "publishing-job", target: f.projects[0]!, projectId: "one", outputPath,
    });
    await manager.store.update(job.jobId, (value) => ({
      ...value, state: "running", phase: "publishing", result: { outputPath },
      owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
    }), ["queued"]);
    await expect(manager.cancel(job.jobId)).rejects.toMatchObject({ code: "job_not_cancellable" });
    expect((await manager.read(job.jobId))?.phase).toBe("publishing");
  });

  it.skipIf(process.platform === "win32")("finishes a publishing record when restart proves candidate was atomically promoted", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "published.mp4");
    await writeFile(outputPath, "verified-output");
    const identity = await fileIdentity(outputPath);
    const job = await createPersistedExport(manager, {
      jobId: "published-job", target: f.projects[0]!, projectId: "one", outputPath,
    });
    await manager.store.update(job.jobId, (value) => ({
      ...value, state: "running", phase: "publishing", result: {
        outputPath, verified: true, candidateSha256: identity.sha256, candidateSize: identity.size,
      },
      owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
    }), ["queued"]);
    await manager.initialize();
    expect(await manager.read(job.jobId)).toMatchObject({
      state: "succeeded", phase: "published", result: { verified: true }, owner: null,
    });
  });

  it.skipIf(process.platform === "win32")("blocks publishing recovery when an unrelated output occupies the path", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "unrelated.mp4");
    const expectedPath = join(f.root, "expected.bin");
    await writeFile(outputPath, "unrelated-output");
    await writeFile(expectedPath, "expected-output");
    const expected = await fileIdentity(expectedPath);
    const job = await createPersistedExport(manager, {
      jobId: "unrelated-output", target: f.projects[0]!, projectId: "one", outputPath,
    });
    await manager.store.update(job.jobId, (value) => ({
      ...value, state: "running", phase: "publishing",
      result: { candidateSha256: expected.sha256, candidateSize: expected.size },
      owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
    }), ["queued"]);
    await manager.initialize();
    expect(await manager.read(job.jobId)).toMatchObject({
      state: "recovery_blocked", error: { code: "job_published_output_mismatch" },
    });
  });

  it.skipIf(process.platform === "win32")("blocks publishing recovery when the promoted output was tampered", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "tampered-output.mp4");
    await writeFile(outputPath, "verified-before-crash");
    const expected = await fileIdentity(outputPath);
    await writeFile(outputPath, "tampered-after-crash");
    const job = await createPersistedExport(manager, {
      jobId: "tampered-output", target: f.projects[0]!, projectId: "one", outputPath,
    });
    await manager.store.update(job.jobId, (value) => ({
      ...value, state: "running", phase: "publishing",
      result: { candidateSha256: expected.sha256, candidateSize: expected.size },
      owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
    }), ["queued"]);
    await manager.initialize();
    expect(await manager.read(job.jobId)).toMatchObject({
      state: "recovery_blocked", error: { code: "job_published_output_mismatch" },
    });
  });

  it.skipIf(process.platform === "win32")("blocks a tampered candidate and publishes an intact recovered candidate", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const makePublishing = async (jobId: string, content: string, tamper: boolean) => {
      const outputPath = join(f.root, `${jobId}.mp4`);
      const candidatePath = candidateForOutput(outputPath, jobId);
      await writeFile(candidatePath, content);
      const identity = await fileIdentity(candidatePath);
      if (tamper) await writeFile(candidatePath, `${content}-tampered`);
      const target = tamper ? f.projects[0]! : f.projects[1]!;
      const job = await createPersistedExport(manager, {
        jobId, target, projectId: tamper ? "one" : "two", outputPath,
      });
      await manager.store.update(job.jobId, (value) => ({
        ...value, state: "running", phase: "publishing",
        result: { candidateSha256: identity.sha256, candidateSize: identity.size },
        owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
      }), ["queued"]);
      return job;
    };
    const tampered = await makePublishing("tampered-candidate", "candidate-one", true);
    const intact = await makePublishing("intact-candidate", "candidate-two", false);
    await manager.initialize();
    expect(await manager.read(tampered.jobId)).toMatchObject({
      state: "recovery_blocked", error: { code: "job_candidate_mismatch" },
    });
    expect(await manager.read(intact.jobId)).toMatchObject({ state: "succeeded", phase: "published" });
    expect(await fileIdentity(join(f.root, "intact-candidate.mp4"))).toMatchObject({
      sha256: (await manager.read(intact.jobId))!.result!.candidateSha256,
    });
  });

  it.skipIf(process.platform === "win32")("finishes recovery only when candidate and output are the same verified inode", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "hard-linked.mp4");
    const job = await createPersistedExport(manager, {
      jobId: "hard-linked", target: f.projects[0]!, projectId: "one", outputPath,
    });
    const candidatePath = candidateForOutput(outputPath, job.jobId);
    await writeFile(candidatePath, "linked-output");
    const identity = await fileIdentity(candidatePath);
    await link(candidatePath, outputPath);
    await manager.store.update(job.jobId, (value) => ({
      ...value,
      state: "running",
      phase: "publishing",
      result: { candidateSha256: identity.sha256, candidateSize: identity.size },
      owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
    }), ["queued"]);
    await manager.initialize();
    expect(await manager.read(job.jobId)).toMatchObject({ state: "succeeded", phase: "published" });
    await expect(readFile(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outputPath, "utf8")).toBe("linked-output");
  });

  it.skipIf(process.platform === "win32")("blocks equal-hash candidate and output when their inodes differ", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "same-bytes-different-inode.mp4");
    const job = await createPersistedExport(manager, {
      jobId: "same-bytes-different-inode", target: f.projects[0]!, projectId: "one", outputPath,
    });
    const candidatePath = candidateForOutput(outputPath, job.jobId);
    await writeFile(candidatePath, "identical-bytes");
    await writeFile(outputPath, "identical-bytes");
    const identity = await fileIdentity(candidatePath);
    await manager.store.update(job.jobId, (value) => ({
      ...value,
      state: "running",
      phase: "publishing",
      result: { candidateSha256: identity.sha256, candidateSize: identity.size },
      owner: { pid: 2_000_000_000, token: "dead", startedAt: value.createdAt, heartbeatAt: value.createdAt },
    }), ["queued"]);
    await manager.initialize();
    expect(await manager.read(job.jobId)).toMatchObject({
      state: "recovery_blocked", error: { code: "job_publish_ambiguous" },
    });
    expect(await readFile(outputPath, "utf8")).toBe("identical-bytes");
    expect(await readFile(candidatePath, "utf8")).toBe("identical-bytes");
  });

  it("rejects a second Runtime before it can recover or kill the first worker", async () => {
    const f = await fixture();
    const first = new JobManager(f.dataDir, { workerEntrypoint: f.slowWorker });
    const second = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(first, second);
    await first.initialize();
    const started = await first.start({ kind: "export", target: f.projects[0]! });
    const running = await waitState(first, started.jobId, "running");
    await expect(second.initialize()).rejects.toMatchObject({ code: "job_runtime_conflict" });
    expect(() => process.kill(running.owner!.pid, 0)).not.toThrow();
    expect(await first.read(started.jobId)).toMatchObject({ state: "running", attempt: 1 });
  });

  it("does not let a worker escape when shutdown crosses the launch seam", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const atLaunch = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const continueLaunch = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const manager = new JobManager(f.dataDir, {
      workerEntrypoint: f.slowWorker,
      async beforeWorkerSpawn() {
        entered();
        await continueLaunch;
      },
    });
    managers.push(manager);
    await manager.initialize();
    const started = await manager.start({ kind: "export", target: f.projects[0]! });
    await atLaunch;
    const stopping = manager.shutdown();
    release();
    await stopping;
    expect(await manager.read(started.jobId)).toMatchObject({ state: "queued", owner: null });
  });

  it("does not let settlement overwrite a shutdown lease", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const beforeLease = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const continueLease = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const outputPath = join(f.root, "shutdown-settle.mp4");
    const manager = new JobManager(f.dataDir, {
      workerEntrypoint: f.successWorker,
      async beforePublishingLease() {
        entered();
        await continueLease;
      },
    });
    managers.push(manager);
    await manager.initialize();
    const started = await manager.start({
      kind: "export", target: f.projects[0]!, params: { outputPath },
    });
    await beforeLease;
    const stopping = manager.shutdown();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const phase = (await manager.read(started.jobId))?.phase;
      if (phase === "stopping" || phase === "queued_after_shutdown") break;
      await Bun.sleep(10);
    }
    release();
    await stopping;
    expect(await manager.read(started.jobId)).toMatchObject({
      state: "queued", phase: "queued_after_shutdown", owner: null,
    });
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks publish when the input video or an overlay asset changes during execution", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.delayedWorker });
    managers.push(manager);
    await manager.initialize();

    const sourceJob = await manager.start({
      kind: "export", target: f.projects[0]!, params: { outputPath: join(f.root, "source-change.mp4") },
    });
    await waitState(manager, sourceJob.jobId, "running");
    await writeFile(join(f.projects[0]!, "input.mp4"), "source-mutated");
    expect(await waitState(manager, sourceJob.jobId, "failed")).toMatchObject({
      error: { code: "job_publish_conflict" },
    });

    const overlayJob = await manager.start({
      kind: "export", target: f.projects[1]!, params: { outputPath: join(f.root, "overlay-change.mp4") },
    });
    await waitState(manager, overlayJob.jobId, "running");
    await writeFile(join(f.projects[1]!, "overlay.html"), "overlay-mutated");
    expect(await waitState(manager, overlayJob.jobId, "failed")).toMatchObject({
      error: { code: "job_publish_conflict" },
    });
  });

  it("ignores settlement from a superseded owner token and attempt", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.delayedWorker });
    managers.push(manager);
    await manager.initialize();
    const started = await manager.start({
      kind: "export", target: f.projects[0]!, params: { outputPath: join(f.root, "superseded.mp4") },
    });
    const first = await waitState(manager, started.jobId, "running");
    await manager.store.update(started.jobId, (value) => ({
      ...value,
      attempt: value.attempt + 1,
      owner: { ...value.owner!, token: "newer-attempt-token" },
    }), ["running"]);
    await Bun.sleep(500);
    expect(await manager.read(started.jobId)).toMatchObject({
      state: "running",
      attempt: first.attempt + 1,
      owner: { token: "newer-attempt-token" },
    });
  });

  it("does not resurrect a queued job cancelled during worker launch", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.slowWorker });
    managers.push(manager);
    await manager.initialize();
    const started = await manager.start({ kind: "export", target: f.projects[0]! });
    await manager.cancel(started.jobId);
    const cancelled = await waitState(manager, started.jobId, "cancelled");
    await Bun.sleep(100);
    expect((await manager.read(started.jobId))?.state).toBe("cancelled");
    expect(cancelled.owner).toBeNull();
  });

  it("queues different targets and cancels queued and running work without a surviving worker", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.slowWorker, concurrency: 1 });
    managers.push(manager);
    await manager.initialize();
    const first = await manager.start({ kind: "export", target: f.projects[0]! });
    const running = await waitState(manager, first.jobId, "running");
    const workerPid = running.owner!.pid;
    const second = await manager.start({ kind: "export", target: f.projects[1]! });
    expect((await manager.read(second.jobId))?.state).toBe("queued");
    await manager.cancel(second.jobId);
    expect((await manager.read(second.jobId))?.state).toBe("cancelled");
    await manager.cancel(first.jobId);
    const cancelled = await waitState(manager, first.jobId, "cancelled");
    expect(cancelled.owner).toBeNull();
    if (process.platform !== "win32") {
      expect(() => process.kill(-workerPid, 0)).toThrow();
    }
  });

  it("recovers a persisted running export whose owner is confirmed absent", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "recovered.mp4");
    const job = await createPersistedExport(manager, {
      jobId: "recovery-job", target: f.projects[0]!, projectId: "one", outputPath,
    });
    await manager.store.update(job.jobId, (value) => ({
      ...value,
      state: "running",
      phase: "export",
      attempt: 1,
      owner: {
        pid: 2_000_000_000,
        token: "confirmed-dead-owner",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    }));
    await manager.initialize();
    if (process.platform === "win32") {
      expect(await manager.read(job.jobId)).toMatchObject({
        state: "recovery_blocked", error: { code: "job_process_unproven" },
      });
    } else {
      const succeeded = await waitState(manager, job.jobId, "succeeded");
      expect(succeeded.attempt).toBe(2);
      expect(succeeded.phase).toBe("published");
    }
  });

  it("requeues on graceful Runtime stop and succeeds after a fresh manager starts", async () => {
    const f = await fixture();
    const firstManager = new JobManager(f.dataDir, { workerEntrypoint: f.slowWorker });
    await firstManager.initialize();
    const started = await firstManager.start({ kind: "export", target: f.projects[0]! });
    await waitState(firstManager, started.jobId, "running");
    await firstManager.shutdown();
    expect((await firstManager.read(started.jobId))?.state).toBe("queued");

    const secondManager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(secondManager);
    await secondManager.initialize();
    const succeeded = await waitState(secondManager, started.jobId, "succeeded");
    expect(succeeded.attempt).toBe(2);
    expect(succeeded.result).toMatchObject({ worker: "test" });
  });
});
