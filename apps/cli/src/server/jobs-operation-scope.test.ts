import { test, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationAuditStore, operationInputHash } from "@video-workbench/core/node";
import { startStudioServer } from "./start";

test("production export admission query proves exact project scope even without a job", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "job-operation-scope-")));
  const staticDir = join(root, "static"), projectsDir = join(root, "projects"), dataDir = join(root, "data");
  await mkdir(staticDir); await mkdir(projectsDir);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Scope fixture</title>");
  const store = new OperationAuditStore(dataDir);
  const admit = async (operationId: string, target: string) => store.admit({ operationId, kind: "job.start.export", target: { kind: "export", targetLabel: "project-a", targetHash: operationInputHash(target) }, inputHash: operationInputHash({ operationId, target }), actor: "runtime-api", entrypoint: "http.jobs" });
  await admit("pending-id", "project-a");
  await admit("legacy-absolute", join(root, "project-a"));
  await admit("failed-id", "project-a"); await store.finishFailed("failed-id", new Error("fixture failure"));
  const server = await startStudioServer({ host: "127.0.0.1", port: 0, projectsDir, dataDir, staticDir, installSignalHandlers: false });
  const origin = new URL(server.url).origin;
  const get = (operationId: string, projectId: string) => fetch(`${origin}/api/v1/jobs/by-operation?${new URLSearchParams({ operationId, projectId })}`);
  try {
    for (const operationId of ["pending-id", "failed-id"]) {
      const own = await get(operationId, "project-a"); expect(own.status).toBe(200);
      expect(await own.json()).toMatchObject({ projectId: "project-a", operationId, job: null, status: operationId === "pending-id" ? "pending" : "failed" });
      const foreign = await get(operationId, "project-b"); expect(foreign.status).toBe(409); expect(await foreign.json()).toMatchObject({ error: { code: "job_target_conflict" } });
    }
    expect((await get("legacy-absolute", "project-a")).status).toBe(409);
    expect((await get("pending-id", "")).status).toBe(400);
    expect((await get("pending-id", "../project-a")).status).toBe(400);
    const requestFile = join(root, "query.json"); await writeFile(requestFile, JSON.stringify({ operationId: "pending-id" }));
    const cli = async (projectId: string) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../cli.ts"), "workbench", "job-by-operation", "--api-base", origin, "--project", projectId, "--file", requestFile, "--json"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(""); return { code, ...JSON.parse(stdout) };
    };
    const own = await cli("project-a"); expect(own.code).toBe(0); expect(own.data).toMatchObject({ projectId: "project-a", job: null, status: "pending", readBackVerified: true, completionVerified: false });
    const foreign = await cli("project-b"); expect(foreign.code).not.toBe(0); expect(foreign.error.code).toBe("job_target_conflict");
    console.log(JSON.stringify({ test: "job-operation-project-scope", port: server.port, pid: process.pid, pendingSameProject: "pass", pendingCrossProject: "rejected", legacyAbsoluteNoJob: "rejected", cliScope: "verified" }));
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
