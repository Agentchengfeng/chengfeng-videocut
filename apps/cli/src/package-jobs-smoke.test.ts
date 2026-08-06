import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DurableJob } from "@video-workbench/contracts";

const packagedCli = resolve("apps/cli/dist/cli.js");
const processes: ChildProcess[] = [];
const processGroups: number[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (process.platform !== "win32") {
    for (const pgid of processGroups.splice(0)) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("close", () => resolveExit()));
}

async function startPackagedRuntime(dataDir: string, projectsDir: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [packagedCli, "start", "--port", "0", "--data-dir", dataDir, "--projects-dir", projectsDir, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  return {
    child,
    url: await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`packaged Runtime did not start: ${stderr}`)), 15_000);
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        const line = stdout.split(/\r?\n/).find((value) => value.trim());
        if (!line) return;
        try {
          const payload = JSON.parse(line) as { data?: { url?: string } };
          if (payload.data?.url) {
            clearTimeout(timer);
            resolveUrl(payload.data.url);
          }
        } catch { /* wait for a complete line */ }
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`packaged Runtime exited early (${code}): ${stderr}`));
      });
    }),
  };
}

async function waitJob(url: string, jobId: string, state: string, timeout = 30_000): Promise<DurableJob> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const job = await (await fetch(`${url}/api/v1/jobs/${jobId}`)).json() as DurableJob;
      if (job.state === state) return job;
      if (["failed", "recovery_blocked", "cancelled"].includes(job.state)) {
        throw new Error(`job stopped in ${job.state}: ${JSON.stringify(job.error)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("job stopped")) throw error;
    }
    await Bun.sleep(20);
  }
  throw new Error(`job did not reach ${state}`);
}

describe("packaged durable jobs", () => {
  it.skipIf(!existsSync(packagedCli))("kills an orphanable worker group and recovers export after Runtime SIGKILL", async () => {
    const root = await mkdtemp(join(tmpdir(), "packaged-jobs-"));
    cleanup.push(root);
    const dataDir = join(root, "data");
    const projectsDir = join(root, "projects");
    const project = join(root, "project");
    await mkdir(projectsDir, { recursive: true });
    await mkdir(project, { recursive: true });
    await cp(resolve("apps/studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4"), join(project, "input.mp4"));
    await writeFile(join(project, "project.json"), `${JSON.stringify({ jobId: "packaged", inputVideo: "input.mp4" })}\n`);
    await writeFile(join(project, "edit-list.json"), `${JSON.stringify({
      schemaVersion: 1, projectId: "packaged", sourceDuration: 2,
      baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "b".repeat(64),
      mode: "manual", duration: 2,
      segments: [{ id: "a-roll-0001", source: "input.mp4", sourceStart: 0, sourceEnd: 2, timelineStart: 0, trackId: "a-roll", playbackRate: 1 }],
    })}\n`);

    const firstRuntime = await startPackagedRuntime(dataDir, projectsDir);
    const outputPath = join(root, "result.mp4");
    const response = await fetch(`${firstRuntime.url}/api/v1/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "export", target: project, params: { outputPath, scale: 2, fps: 15 } }),
    });
    expect(response.status).toBe(202);
    const started = await response.json() as DurableJob;
    const running = await waitJob(firstRuntime.url, started.jobId, "running");
    const oldWorkerPid = running.owner!.pid;
    processGroups.push(oldWorkerPid);

    firstRuntime.child.kill("SIGKILL");
    await waitForExit(firstRuntime.child);
    const secondRuntime = await startPackagedRuntime(dataDir, projectsDir);
    const succeeded = await waitJob(secondRuntime.url, started.jobId, "succeeded");
    expect(succeeded.attempt).toBe(2);
    expect(succeeded.result).toMatchObject({ outputPath, hasAudio: true, problems: [] });
    if (process.platform !== "win32") expect(() => process.kill(-oldWorkerPid, 0)).toThrow();
  }, 45_000);
});
