import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDiagnosticLogs } from "./service/diagnostics";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-idle-process-"));
  const projectsDir = join(root, "projects"), dataDir = join(root, "data"), staticDir = join(root, "static");
  await Promise.all([mkdir(projectsDir), mkdir(dataDir), mkdir(staticDir)]);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Idle process test</title>");
  return { root, projectsDir, dataDir, staticDir };
}

async function start(f: Awaited<ReturnType<typeof fixture>>, seconds: number) {
  const child = Bun.spawn([process.execPath, cli, "start", "--port", "0", "--data-dir", f.dataDir,
    "--projects-dir", f.projectsDir, "--idle-timeout-seconds", String(seconds), "--json"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.root,
      CHENGFENG_VIDEOCUT_STATIC_DIR: f.staticDir },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  // Drain both streams immediately so a full pipe cannot masquerade as lifecycle work.
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let startup = "";
  const deadline = setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 15_000);
  try {
    while (!startup.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error(`Startup exited ${await child.exited}: ${await stderr}`);
      startup += new TextDecoder().decode(next.value);
    }
    const receipt = JSON.parse(startup.split("\n")[0]!);
    expect(receipt.ok).toBe(true);
    expect(receipt.data.pid).toBe(child.pid);
    const stdout = (async () => {
      let tail = "";
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
      } finally { reader.releaseLock(); }
      return tail;
    })();
    return { child, url: receipt.data.url as string, stderr, stdout };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    throw error;
  } finally { clearTimeout(deadline); }
}

async function exited(c: Awaited<ReturnType<typeof start>>, timeoutMs = 8_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([c.child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("idle process did not exit in bounded time")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function clean(c: Awaited<ReturnType<typeof start>>) {
  if (c.child.exitCode === null) c.child.kill("SIGTERM");
  await exited(c);
  await Promise.all([c.stdout, c.stderr]);
}

async function lease(c: Awaited<ReturnType<typeof start>>, payload: object) {
  const response = await fetch(c.url + "/api/runtime/activity", {
    method: "POST", headers: { "content-type": "application/json", origin: c.url }, body: JSON.stringify(payload),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

test("real CLI idle exit persists evidence, ignores probes, releases ownership and can restart", async () => {
  const f = await fixture();
  const identities: Array<{ pid: number; url: string; exit: number }> = [];
  for (let run = 0; run < 2; run++) {
    const c = await start(f, 2);
    const poll = setInterval(() => { void fetch(c.url + "/api/health").catch(() => {}); }, 100);
    try {
      expect((await fetch(c.url + "/api/health")).ok).toBe(true);
      expect(await exited(c)).toBe(0);
      identities.push({ pid: c.child.pid, url: c.url, exit: c.child.exitCode! });
      await expect(fetch(c.url + "/api/health")).rejects.toThrow();
    } finally { clearInterval(poll); await clean(c); }
  }
  const rows = (await readDiagnosticLogs(f.dataDir, 1000)).trim().split("\n").map(line => JSON.parse(line));
  expect(rows.filter(row => row.phase === "idle_timeout")).toHaveLength(2);
  expect(rows.filter(row => row.phase === "stopped")).toHaveLength(2);
  expect(identities[0]!.pid).not.toBe(identities[1]!.pid);
  console.log(JSON.stringify({ evidence: f.root, identities, phases: rows.map(row => row.phase) }));
}, 25_000);

test("real CLI stays alive for hidden playback and dirty drafts across multiple sessions", async () => {
  const f = await fixture();
  const c = await start(f, 1);
  try {
    await lease(c, { sessionId: "tab-a", active: false, playing: false, dirty: true });
    await lease(c, { sessionId: "tab-b", active: false, playing: true, dirty: false });
    await Bun.sleep(1600);
    expect(c.child.exitCode).toBeNull();
    await lease(c, { sessionId: "tab-a", active: false, playing: false, dirty: false });
    await lease(c, { sessionId: "tab-a", release: true });
    await Bun.sleep(1600);
    expect(c.child.exitCode).toBeNull();
    await lease(c, { sessionId: "tab-b", active: false, playing: false, dirty: false });
    await lease(c, { sessionId: "tab-b", release: true });
    expect(await exited(c)).toBe(0);
    console.log(JSON.stringify({ evidence: f.root, pid: c.child.pid, exit: c.child.exitCode, scenario: "dirty-and-playing-multitab" }));
  } finally { await clean(c); }
}, 20_000);

test("explicit zero preserves a long-lived CLI until owned explicit stop", async () => {
  const f = await fixture();
  const c = await start(f, 0);
  try {
    await Bun.sleep(1600);
    expect(c.child.exitCode).toBeNull();
    expect((await fetch(c.url + "/api/health")).ok).toBe(true);
  } finally { await clean(c); }
  expect(c.child.exitCode).toBe(143);
}, 20_000);
