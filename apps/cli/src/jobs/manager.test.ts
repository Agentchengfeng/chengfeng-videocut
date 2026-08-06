import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "./manager";
import { candidateForOutput, exportInputFingerprint, fileIdentity } from "./runners";

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
const token = argv[argv.indexOf("--owner-token") + 1];
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
  candidateSha256: createHash("sha256").update(candidate).digest("hex"),
  candidateSize: Buffer.byteLength(candidate),
} }));
`);
  return { root, dataDir, projects, slowWorker, successWorker };
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
  it("refuses cancellation after verified output enters the publishing phase", async () => {
    const f = await fixture();
    const manager = new JobManager(f.dataDir, { workerEntrypoint: f.successWorker });
    managers.push(manager);
    await manager.store.initialize();
    const outputPath = join(f.root, "publishing.mp4");
    const job = await manager.store.create({
      jobId: "publishing-job", kind: "export", target: f.projects[0]!,
      targetKey: `project:${f.projects[0]}`, projectId: "one",
      frozen: { inputFingerprint: await exportInputFingerprint(f.projects[0]!) },
      params: {
        outputPath,
        candidatePath: candidateForOutput(outputPath, "publishing-job"),
        workDirectory: join(f.dataDir, "jobs", "publishing-job", "work"),
      },
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
    const job = await manager.store.create({
      jobId: "published-job", kind: "export", target: f.projects[0]!,
      targetKey: `project:${f.projects[0]}`, projectId: "one",
      frozen: { inputFingerprint: await exportInputFingerprint(f.projects[0]!) },
      params: {
        outputPath,
        candidatePath: candidateForOutput(outputPath, "published-job"),
        workDirectory: join(f.dataDir, "jobs", "published-job", "work"),
      },
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
    const job = await manager.store.create({
      jobId: "unrelated-output", kind: "export", target: f.projects[0]!,
      targetKey: `project:${f.projects[0]}`, projectId: "one",
      frozen: { inputFingerprint: await exportInputFingerprint(f.projects[0]!) },
      params: {
        outputPath, candidatePath: candidateForOutput(outputPath, "unrelated-output"),
        workDirectory: join(f.dataDir, "jobs", "unrelated-output", "work"),
      },
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
    const job = await manager.store.create({
      jobId: "tampered-output", kind: "export", target: f.projects[0]!,
      targetKey: `project:${f.projects[0]}`, projectId: "one",
      frozen: { inputFingerprint: await exportInputFingerprint(f.projects[0]!) },
      params: {
        outputPath, candidatePath: candidateForOutput(outputPath, "tampered-output"),
        workDirectory: join(f.dataDir, "jobs", "tampered-output", "work"),
      },
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
      const job = await manager.store.create({
        jobId, kind: "export", target: tamper ? f.projects[0]! : f.projects[1]!,
        targetKey: `project:${tamper ? f.projects[0] : f.projects[1]}`,
        projectId: tamper ? "one" : "two",
        frozen: { inputFingerprint: await exportInputFingerprint(tamper ? f.projects[0]! : f.projects[1]!) },
        params: { outputPath, candidatePath, workDirectory: join(f.dataDir, "jobs", jobId, "work") },
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
    const job = await manager.store.create({
      jobId: "recovery-job",
      kind: "export",
      target: f.projects[0]!,
      targetKey: `project:${f.projects[0]}`,
      projectId: "one",
      frozen: { inputFingerprint: await exportInputFingerprint(f.projects[0]!) },
      params: {
        outputPath,
        candidatePath: candidateForOutput(outputPath, "recovery-job"),
        workDirectory: join(f.dataDir, "jobs", "recovery-job", "work"),
      },
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
