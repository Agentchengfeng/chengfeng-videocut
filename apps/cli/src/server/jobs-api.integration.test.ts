import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DurableJob } from "@video-workbench/contracts";
import { OperationAuditStore } from "@video-workbench/core/node";
import { startStudioServer, type RunningStudioServer } from "./start";
import { createJobsApi } from "./jobs-api";
import { JobManager } from "../jobs/manager";
import { runCli } from "../run";

const cleanup: string[] = [];
const servers: RunningStudioServer[] = [];
const managers: JobManager[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => undefined)));
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jobs-api-real-"));
  cleanup.push(root);
  const staticDir = join(root, "static");
  const projectsDir = join(root, "projects");
  const dataDir = join(root, "data");
  await mkdir(staticDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>jobs test</title>");
  const media = resolve("apps/studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4");
  const projectDirs: string[] = [];
  for (const id of ["one", "two"]) {
    const project = join(root, id);
    projectDirs.push(project);
    await mkdir(project, { recursive: true });
    await cp(media, join(project, "input.mp4"));
    await writeFile(join(project, "project.json"), `${JSON.stringify({ jobId: id, inputVideo: "input.mp4" })}\n`);
    await writeFile(join(project, "edit-list.json"), `${JSON.stringify({
      schemaVersion: 1,
      projectId: id,
      sourceDuration: 2,
      baseCutsRevision: "a".repeat(64),
      baseTranscriptRevision: "b".repeat(64),
      mode: "manual",
      duration: 2,
      segments: [{
        id: "a-roll-0001", source: "input.mp4", sourceStart: 0, sourceEnd: 2,
        timelineStart: 0, trackId: "a-roll", playbackRate: 1,
      }],
    })}\n`);
    await symlink(project, join(projectsDir, id), "dir");
  }
  const successWorker = join(root, "success-worker.ts");
  await writeFile(successWorker, `
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const argv = process.argv.slice(2);
const jobId = argv[1];
const dataDir = argv[argv.indexOf("--data-dir") + 1];
const token = process.env.CHENGFENG_JOB_OWNER_TOKEN;
let job;
for (let i = 0; i < 200; i += 1) {
  job = JSON.parse(await readFile(join(dataDir, "jobs", jobId, "job.json"), "utf8"));
  if (job.state === "running" && job.owner?.token === token) break;
  await Bun.sleep(10);
}
const candidate = "candidate";
await writeFile(job.params.candidatePath, candidate);
console.log(JSON.stringify({ ok: true, result: {
  dependencyFingerprint: job.frozen.dependencyFingerprint,
  candidateSha256: createHash("sha256").update(candidate).digest("hex"),
  candidateSize: Buffer.byteLength(candidate),
} }));
`);
  return { root, staticDir, projectsDir, dataDir, projectDirs, successWorker };
}

async function waitJob(url: string, jobId: string, states: string[], timeout = 30_000): Promise<DurableJob> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/v1/jobs/${jobId}`);
    const job = await response.json() as DurableJob;
    if (states.includes(job.state)) return job;
    await Bun.sleep(25);
  }
  throw new Error(`job ${jobId} did not reach ${states.join("/")}`);
}

async function waitManagedJob(manager: JobManager, jobId: string, states: string[], timeout = 10_000): Promise<DurableJob> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = await manager.read(jobId);
    if (job && states.includes(job.state)) return job;
    await Bun.sleep(20);
  }
  throw new Error(`job ${jobId} did not reach ${states.join("/")}`);
}

async function postJob(handler: ReturnType<typeof createJobsApi>, body: unknown): Promise<Response> {
  const response = await handler(new Request("http://127.0.0.1:5190/api/v1/jobs", {
    method: "POST",
    headers: { Host: "127.0.0.1:5190", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), "127.0.0.1");
  if (!response) throw new Error("jobs API did not handle request");
  return response;
}

describe("durable jobs HTTP and real export", () => {
  it("rejects a non-loopback client before dispatching into the manager", async () => {
    const handler = createJobsApi({} as never, 5190);
    const response = await handler(new Request("http://127.0.0.1:5190/api/v1/jobs", {
      headers: { Host: "127.0.0.1:5190" },
    }), "192.168.1.50");
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: { code: "local_only" } });
  });

  it("fails closed without a peer and accepts only canonical loopback authorities", async () => {
    const manager = {
      list: async () => [],
    } as never;
    const handler = createJobsApi(manager, 5190);
    const request = (authority: string, options: { host?: string; origin?: string } = {}) => new Request(
      `http://${authority}/api/v1/jobs`,
      { headers: {
        Host: options.host ?? authority,
        ...(options.origin ? { Origin: options.origin } : {}),
      } },
    );

    const missingPeer = await handler(request("127.0.0.1:5190"));
    expect(missingPeer?.status).toBe(403);
    expect(await missingPeer?.json()).toMatchObject({ error: { code: "local_only" } });

    for (const [authority, peer] of [
      ["127.0.0.1:5190", "127.0.0.1"],
      ["localhost:5190", "127.0.0.1"],
      ["[::1]:5190", "::1"],
    ] as const) {
      const withoutOrigin = await handler(request(authority), peer);
      expect(withoutOrigin?.status).toBe(200);
      expect(await withoutOrigin?.json()).toEqual({ schemaVersion: 1, jobs: [] });

      const sameOrigin = await handler(request(authority, { origin: `http://${authority}` }), peer);
      expect(sameOrigin?.status).toBe(200);
    }
  });

  it("rejects DNS rebinding and noncanonical Host header tricks", async () => {
    const handler = createJobsApi({ list: async () => [] } as never, 5190);
    const rebound = await handler(new Request("http://attacker.invalid:5190/api/v1/jobs", {
      headers: { Host: "attacker.invalid:5190", Origin: "http://attacker.invalid:5190" },
    }), "127.0.0.1");
    expect(rebound?.status).toBe(403);
    expect(await rebound?.json()).toMatchObject({ error: { code: "host_forbidden" } });

    const missingHost = await handler(new Request("http://127.0.0.1:5190/api/v1/jobs"), "127.0.0.1");
    expect(missingHost?.status).toBe(403);
    expect(await missingHost?.json()).toMatchObject({ error: { code: "host_forbidden" } });

    for (const host of [
      "127.0.0.1",
      "127.0.0.1:5191",
      "127.0.0.1:05190",
      "127.0.0.1.evil.invalid:5190",
      "127.0.0.1:5190@evil.invalid",
      "2130706433:5190",
      "[::ffff:127.0.0.1]:5190",
      "localhost.:5190",
      "localhost:5190,evil.invalid",
      "::1:5190",
    ]) {
      const response = await handler(new Request("http://127.0.0.1:5190/api/v1/jobs", {
        headers: { Host: host },
      }), "127.0.0.1");
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ error: { code: "host_forbidden" } });
    }

    const decoupledUrl = await handler(new Request("http://attacker.invalid:5190/api/v1/jobs", {
      headers: { Host: "127.0.0.1:5190" },
    }), "127.0.0.1");
    expect(decoupledUrl?.status).toBe(403);
    expect(await decoupledUrl?.json()).toMatchObject({ error: { code: "host_forbidden" } });
  });

  it("enforces conflict/list/cancel, survives Runtime restart, and publishes a real MP4", async () => {
    const f = await fixture();
    let server = await startStudioServer({
      port: 0, dataDir: f.dataDir, projectsDir: f.projectsDir, staticDir: f.staticDir,
    });
    servers.push(server);
    const outputPath = join(f.root, "finished.mp4");
    const wrongType = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", body: JSON.stringify({ kind: "export", target: "one" }),
    });
    expect(wrongType.status).toBe(415);
    const wrongOrigin = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
      body: JSON.stringify({ kind: "export", target: "one" }),
    });
    expect(wrongOrigin.status).toBe(403);
    const reboundAuthority = `attacker.invalid:${server.port}`;
    const rebound = await fetch(`${server.url}/api/v1/jobs`, {
      headers: { Host: reboundAuthority, Origin: `http://${reboundAuthority}` },
    });
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toMatchObject({ error: { code: "host_forbidden" } });
    const invalidBody = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "export", target: "one", operationId: "invalid-job-body", params: [] }),
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({ error: { code: "invalid_argument" } });
    const rejectedFiles = await readdir(new OperationAuditStore(f.dataDir).rejectionsDir);
    expect(rejectedFiles).toHaveLength(1);
    const rejectedText = await readFile(
      join(new OperationAuditStore(f.dataDir).rejectionsDir, rejectedFiles[0]!),
      "utf8",
    );
    expect(rejectedText).toContain("invalid-job-body");
    expect(rejectedText).not.toContain(f.root);
    const startBody = { kind: "export", target: "one", operationId: "job-start-op-1", params: { outputPath, scale: 2, fps: 15 } };
    const start = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(startBody),
    });
    expect(start.status).toBe(202);
    const first = await start.json() as DurableJob & { operationId?: string; operationReplay?: boolean };
    expect(first.operationId).toBe("job-start-op-1");
    expect(await new OperationAuditStore(f.dataDir).read("job-start-op-1")).toMatchObject({
      kind: "job.start.export",
      accepted: true,
      succeeded: true,
      result: { jobId: first.jobId, projectId: "one" },
    });
    expect(await readFile(
      new OperationAuditStore(f.dataDir).recordPath("job-start-op-1"),
      "utf8",
    )).not.toContain(f.root);

    const replay = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(startBody),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      jobId: first.jobId,
      operationId: "job-start-op-1",
      operationReplay: true,
    });

    const tamperedOperation = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...startBody,
        params: { outputPath: join(f.root, "tampered.mp4"), scale: 2, fps: 15 },
      }),
    });
    expect(tamperedOperation.status).toBe(409);
    expect(await tamperedOperation.json()).toMatchObject({ error: { code: "operation_id_conflict" } });

    const conflict = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "export", target: f.projectDirs[0] }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "job_target_conflict", details: { existingJobId: first.jobId } } });

    const secondStart = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "export", target: f.projectDirs[1] }),
    });
    const second = await secondStart.json() as DurableJob & { operationId?: string };
    expect(second.state).toBe("queued");
    expect(second.operationId).toMatch(/^op_/);
    expect(await new OperationAuditStore(f.dataDir).read(second.operationId!)).toMatchObject({
      kind: "job.start.export",
      accepted: true,
      succeeded: true,
      result: { jobId: second.jobId, projectId: "two" },
    });
    const cancel = await fetch(`${server.url}/api/v1/jobs/${second.jobId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    expect((await cancel.json() as DurableJob).state).toBe("cancelled");

    const list = await fetch(`${server.url}/api/v1/jobs?projectId=one`);
    expect(await list.json()).toMatchObject({ schemaVersion: 1, jobs: [{ jobId: first.jobId }] });
    expect((await fetch(`${server.url}/api/v1/jobs?limit=0`)).status).toBe(400);
    const limited = await fetch(`${server.url}/api/v1/jobs?limit=1`);
    expect((await limited.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
    const unsupported = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "render", target: f.projectDirs[1] }),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: { code: "unsupported_job_kind" } });
    expect((await fetch(`${server.url}/api/v1/jobs/missing`)).status).toBe(404);

    const beforeRestart = await waitJob(server.url, first.jobId, ["running"]);
    const oldWorkerPid = beforeRestart.owner?.pid;
    expect(beforeRestart.owner).not.toHaveProperty("token");
    expect(JSON.stringify(beforeRestart)).not.toContain('"token"');
    const privateRecord = JSON.parse(await readFile(
      join(f.dataDir, "jobs", first.jobId, "job.json"),
      "utf8",
    ));
    expect(typeof privateRecord.owner.token).toBe("string");
    const runningCliLines: string[] = [];
    expect(await runCli(["job", "get", first.jobId, "--api-base", server.url], {
      io: { stdout: (line) => runningCliLines.push(line), stderr: (line) => runningCliLines.push(line) },
    })).toBe(0);
    const runningCliPayload = JSON.parse(runningCliLines[0]!);
    expect(runningCliPayload.data.owner).not.toHaveProperty("token");
    expect(JSON.stringify(runningCliPayload)).not.toContain('"token"');
    await server.stop();
    servers.splice(servers.indexOf(server), 1);

    server = await startStudioServer({
      port: 0, dataDir: f.dataDir, projectsDir: f.projectsDir, staticDir: f.staticDir,
    });
    servers.push(server);
    const finished = await waitJob(server.url, first.jobId, ["succeeded", "failed", "recovery_blocked"]);
    expect(finished.state).toBe("succeeded");
    expect(finished.attempt).toBe(2);
    expect(finished.result).toMatchObject({ outputPath, hasAudio: true, problems: [] });

    const cliLines: string[] = [];
    expect(await runCli(["job", "get", first.jobId, "--api-base", server.url], {
      io: { stdout: (line) => cliLines.push(line), stderr: (line) => cliLines.push(line) },
    })).toBe(0);
    expect(JSON.parse(cliLines[0]!)).toMatchObject({
      schemaVersion: 1, command: "job.get", ok: true,
      data: { jobId: first.jobId, state: "succeeded" },
    });

    const legacyOutput = join(f.root, "legacy-export.mp4");
    const legacyLines: string[] = [];
    expect(await runCli([
      "export", "two", "--projects-dir", f.projectsDir,
      "--out", legacyOutput, "--scale", "1", "--fps", "15",
      "--api-base", server.url, "--json",
    ], {
      io: { stdout: (line) => legacyLines.push(line), stderr: (line) => legacyLines.push(line) },
    })).toBe(0);
    expect(JSON.parse(legacyLines.at(-1)!)).toMatchObject({
      command: "export", ok: true, data: { outputPath: legacyOutput, hasAudio: true, problems: [] },
    });
    const projectTwoJobs = await (await fetch(`${server.url}/api/v1/jobs?projectId=two`)).json() as { jobs: DurableJob[] };
    expect(projectTwoJobs.jobs.map((job) => job.state).sort()).toEqual(["cancelled", "succeeded"]);

    const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath]);
    expect(probe.exitCode).toBe(0);
    expect(Number(probe.stdout.toString().trim())).toBeGreaterThan(1.9);
    if (process.platform !== "win32" && oldWorkerPid) {
      expect(() => process.kill(-oldWorkerPid, 0)).toThrow();
    }
  }, 45_000);

  it("refuses a job-start replay when another active job now owns the target", async () => {
    const f = await fixture();
    let holdSecond = false;
    let enteredSecond!: () => void;
    let releaseSecond!: () => void;
    let releasedSecond = false;
    const secondEntered = new Promise<void>((resolveEntered) => { enteredSecond = resolveEntered; });
    const secondGate = new Promise<void>((resolveRelease) => {
      releaseSecond = () => {
        releasedSecond = true;
        resolveRelease();
      };
    });
    const manager = new JobManager(f.dataDir, {
      projectsDir: f.projectsDir,
      workerEntrypoint: f.successWorker,
      async beforeWorkerSpawn() {
        if (!holdSecond) return;
        enteredSecond();
        await secondGate;
      },
    });
    managers.push(manager);
    await manager.initialize();
    const auditStore = new OperationAuditStore(f.dataDir);
    const handler = createJobsApi(manager, 5190, { operationAuditStore: auditStore });

    try {
      const firstBody = {
        kind: "export",
        target: "one",
        operationId: "job-replay-active-conflict",
        params: { outputPath: join(f.root, "first.mp4"), scale: 1, fps: 12 },
      };
      const firstResponse = await postJob(handler, firstBody);
      expect(firstResponse.status).toBe(202);
      const first = await firstResponse.json() as DurableJob;
      expect((await waitManagedJob(manager, first.jobId, ["succeeded"])).state).toBe("succeeded");

      holdSecond = true;
      const secondResponse = await postJob(handler, {
        kind: "export",
        target: "one",
        params: { outputPath: join(f.root, "second.mp4"), scale: 1, fps: 12 },
      });
      expect(secondResponse.status).toBe(202);
      await secondEntered;

      const replay = await postJob(handler, firstBody);
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ error: { code: "job_target_conflict" } });
    } finally {
      if (!releasedSecond) releaseSecond();
    }
  });
});
