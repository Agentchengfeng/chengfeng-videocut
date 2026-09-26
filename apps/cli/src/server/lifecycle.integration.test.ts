import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStudioServer } from "./start";
import { readDiagnosticLogs } from "../service/diagnostics";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "studio-lifecycle-real-"));
  const staticDir = join(root, "static"), projectsDir = join(root, "projects");
  await mkdir(staticDir); await mkdir(projectsDir);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  return { root, options: { port: 0, dataDir: root, staticDir, projectsDir, installSignalHandlers: true } };
}
async function records(root: string) {
  return readDiagnosticLogs(root, 1000).trim().split("\n").map(line => JSON.parse(line));
}
const entry = fileURLToPath(new URL("./start.ts", import.meta.url));
async function child(options: object, after = "") {
  const process = Bun.spawn([Bun.argv[0]!, "-e", `import {startStudioServer} from ${JSON.stringify(entry)}; const server=await startStudioServer(${JSON.stringify(options)}); console.log(JSON.stringify({port:server.port,pid:process.pid})); ${after}`], { stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader();
  const first = await reader.read();
  const identity = JSON.parse(new TextDecoder().decode(first.value).trim());
  reader.releaseLock();
  return { process, identity };
}

test("real random-port start, health capability, conflict and explicit stop leave diagnostic evidence", async () => {
  const f = await fixture();
  const server = await startStudioServer({ ...f.options, installSignalHandlers: false });
  try {
    const health = await (await fetch(server.url + "/api/health")).json();
    expect(health.multisourceAudio.segmentCutsApiVersion).toBe(1);
    expect(health.multisourceAudio.operations).toContain("delete-segments");
    await expect(startStudioServer({ ...f.options, port: server.port, installSignalHandlers: false })).rejects.toThrow();
  } finally { await server.stop(); }
  const phases = (await records(f.root)).map(row => row.phase);
  expect(phases).toContain("startup_failed"); expect(phases).toContain("stopped");
  console.log(JSON.stringify({ evidence: f.root, phases }));
}, 20000);

test("real isolated SIGTERM and uncaught crash preserve exit evidence without restart", async () => {
  for (const mode of ["term", "crash"]) {
    const f = await fixture();
    const c = await child(f.options, mode === "crash" ? 'setTimeout(()=>{throw new Error("isolated fault")},100)' : "");
    if (mode === "term") c.process.kill("SIGTERM");
    const exit = await c.process.exited;
    const rows = await records(f.root);
    expect(exit).not.toBe(0);
    expect(rows.some(row => row.phase === "listening")).toBe(true);
    expect(rows.some(row => row.phase === (mode === "term" ? "stopped" : "process_exit"))).toBe(true);
    console.log(JSON.stringify({ evidence: f.root, mode, pid: c.identity.pid, port: c.identity.port, exit, phases: rows.map(row => row.phase) }));
  }
}, 20000);

test("parent exit is observed but does not terminate a detached random-port service", async () => {
  const f = await fixture();
  const source = `import {startStudioServer} from ${JSON.stringify(entry)}; const server=await startStudioServer(${JSON.stringify(f.options)}); console.log(JSON.stringify({pid:process.pid,port:server.port}));`;
  const parent = Bun.spawn([Bun.argv[0]!, "-e", `const child=Bun.spawn(${JSON.stringify([Bun.argv[0], "-e", source])},{stdout:"inherit",stderr:"inherit",stdin:"ignore"}); child.unref(); setTimeout(()=>process.exit(0),1000);`], { stdout: "pipe", stderr: "pipe" });
  const reader = parent.stdout.getReader();
  const first = await reader.read();
  const identity = JSON.parse(new TextDecoder().decode(first.value).trim());
  reader.releaseLock();
  try {
    expect(await parent.exited).toBe(0);
    // The process's own unref'ed observer checks reparenting once per second.
    for (let i = 0; i < 30 && !(await records(f.root)).some(row => row.phase === "parent_unavailable"); i++) await Bun.sleep(100);
    const rows = await records(f.root);
    expect(rows.some(row => row.phase === "parent_unavailable")).toBe(true);
    expect((await fetch(`http://127.0.0.1:${identity.port}/api/health`)).ok).toBe(true);
    console.log(JSON.stringify({ evidence: f.root, pid: identity.pid, port: identity.port, parentExit: 0, phases: rows.map(row => row.phase) }));
  } finally { process.kill(identity.pid, "SIGTERM"); }
}, 20000);
