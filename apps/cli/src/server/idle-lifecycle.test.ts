import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleLifecycle } from "./idle-lifecycle";
import { startStudioServer } from "./start";

const port = 5190;
function request(value: unknown, options: { method?: string; origin?: string; host?: string } = {}) {
  return new Request(`http://127.0.0.1:${port}/api/runtime/activity`, {
    method: options.method ?? "POST", headers: { host: options.host ?? `127.0.0.1:${port}`,
      "content-type": "application/json", ...(options.origin ? { origin: options.origin } : {}) },
    body: JSON.stringify(value),
  });
}
const clean = (sessionId = "tab-1") => ({ sessionId, active: false, playing: false, dirty: false });
const update = (idle: IdleLifecycle, value: unknown) => idle.activity(request(value), port, "127.0.0.1");

describe("idle lifecycle", () => {
  it("disabled never exits; enabled exits only after continuous idle", async () => {
    let now = 0, stopped = 0;
    const disabled = new IdleLifecycle(0, async () => [], async () => { stopped++; }, () => now);
    now = 100_000; await disabled.check(); expect(stopped).toBe(0);
    const idle = new IdleLifecycle(1, async () => [], async () => { stopped++; }, () => now);
    now += 999; await idle.check(); expect(stopped).toBe(0);
    now++; await idle.check(); expect(stopped).toBe(1);
    expect(idle.admit(true)).toBeNull(); await idle.check(); expect(stopped).toBe(1);
  });
  it("health/status request admission doesn't refresh idle; ordinary work does", async () => {
    let now = 0, stopped = 0;
    const idle = new IdleLifecycle(1, async () => [], async () => { stopped++; }, () => now);
    now = 900; idle.admit(false)!();
    now = 1000; await idle.check(); expect(stopped).toBe(1);
    const used = new IdleLifecycle(1, async () => [], async () => { stopped++; }, () => now);
    now = 1900; const release = used.admit(true)!;
    now = 2100; await used.check(); expect(stopped).toBe(1); release();
    now = 3000; await used.check(); expect(stopped).toBe(1);
    now = 3100; await used.check(); expect(stopped).toBe(2);
  });
  it("active and playing leases protect independent tabs; clean leases expire", async () => {
    let now = 0, stopped = 0;
    const idle = new IdleLifecycle(1, async () => [], async () => { stopped++; }, () => now);
    await update(idle, { ...clean("one"), active: true });
    await update(idle, { ...clean("two"), playing: true });
    now = 2000; await idle.check(); expect(stopped).toBe(0);
    await update(idle, { sessionId: "one", release: true });
    now = 5000; await idle.check(); expect(stopped).toBe(0);
    now = 91_000; await idle.check(); expect(stopped).toBe(0);
    expect(idle.status().sessions[0]?.stalePlaying).toBe(true);
    await update(idle, { sessionId: "two", release: true });
    now += 1000; await idle.check(); expect(stopped).toBe(1);
    expect(idle.status().sessions).toHaveLength(0);
  });
  it("dirty survives expired heartbeat until explicit clean, and is observable", async () => {
    let now = 0, stopped = 0;
    const idle = new IdleLifecycle(1, async () => [], async () => { stopped++; }, () => now);
    await update(idle, { ...clean(), dirty: true });
    now = 1_000_000; await idle.check(); expect(stopped).toBe(0);
    expect(idle.status().sessions[0]?.staleDirty).toBe(true);
    await update(idle, clean()); now += 1000; await idle.check(); expect(stopped).toBe(1);
  });
  it("ordered updates reject stale clean/release and released resurrection", async () => {
    const idle = new IdleLifecycle(1, async () => [], async () => {});
    await update(idle, { ...clean(), sequence: 2, dirty: true });
    await update(idle, { ...clean(), sequence: 1 });
    await update(idle, { sessionId: "tab-1", release: true, sequence: 1 });
    expect(idle.status().sessions[0]?.dirty).toBe(true);
    await update(idle, { sessionId: "tab-1", release: true, sequence: 3 });
    await update(idle, { ...clean(), dirty: true, sequence: 2 });
    expect(idle.status().sessions).toHaveLength(0);
  });
  it("rejects hostile origin/client, malformed, oversized and over-cap leases", async () => {
    const idle = new IdleLifecycle(1, async () => [], async () => {});
    expect((await idle.activity(request(clean(), { origin: "https://evil.test" }), port, "127.0.0.1")).status).toBe(403);
    expect((await idle.activity(request(clean()), port, "192.168.1.2")).status).toBe(403);
    expect((await idle.activity(request(clean(), { host: "evil.test:5190" }), port, "127.0.0.1")).status).toBe(403);
    expect((await update(idle, { sessionId: "x", active: "yes" })).status).toBe(400);
    expect((await update(idle, { ...clean(), junk: "x".repeat(5000) })).status).toBe(413);
    expect(idle.status().sessions).toHaveLength(0);
    for (let i = 0; i < 128; i++) expect((await update(idle, clean(`tab-${i}`))).status).toBe(200);
    expect((await update(idle, clean("overflow"))).status).toBe(429);
  });
  it("busy owners and unknown owner probes reset the full idle interval", async () => {
    let now = 0, stopped = 0, blockers = ["ingest", "jobs", "preview"], unknown = false;
    const idle = new IdleLifecycle(1, async () => { if (unknown) throw Error("unreadable"); return blockers; }, async () => { stopped++; }, () => now);
    now = 2000; await idle.check(); expect(stopped).toBe(0);
    blockers = []; unknown = true; now = 5000; await idle.check();
    expect(idle.status().blockers).toEqual(["busy_unknown"]);
    unknown = false; now = 5999; await idle.check(); expect(stopped).toBe(0);
    now = 6000; await idle.check(); expect(stopped).toBe(1);
  });
  it("async probes accept requests, retry on admission races, and drain owned requests", async () => {
    let now = 0, stopped = 0;
    let finish!: () => void;
    const idle = new IdleLifecycle(1, () => new Promise(resolve => { finish = () => resolve([]); }), async () => { stopped++; }, () => now);
    const release = idle.admit(true)!;
    let drained = false; const draining = idle.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); release(); await draining;
    now = 1000; const checking = idle.check();
    const concurrent = idle.admit(false); expect(concurrent).not.toBeNull();
    concurrent!(); finish(); await checking; expect(stopped).toBe(0);
    const retry = idle.check(); finish(); await retry;
    expect(stopped).toBe(1);
    expect(idle.admit(true)).toBeNull();
  });
});

it("real isolated server idles despite health polling and SSE, records reason, releases lock; disabled stays up", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-idle-"));
  const staticDir = join(root, "static"), dataDir = join(root, "data");
  await mkdir(staticDir); await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Idle</title>");
  let server: Awaited<ReturnType<typeof startStudioServer>> | undefined;
  try {
    server = await startStudioServer({ port: 0, staticDir, dataDir, idleTimeoutSeconds: 0.15 });
    const sse = await fetch(server.url + "/api/events");
    const eventReader = sse.body!.getReader();
    await eventReader.read();
    let closed = false;
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(20);
      try { await fetch(server.url + "/api/health"); } catch { closed = true; break; }
    }
    expect(closed).toBe(true);
    await server.stop();
    await eventReader.cancel().catch(() => undefined);
    const logDir = join(dataDir, "logs", "diagnostics-v1");
    const names = await readdir(logDir);
    const log = (await Promise.all(names.filter(name => name.endsWith(".jsonl")).map(name => readFile(join(logDir, name), "utf8")))).join("\n");
    expect(log).toContain("idle_timeout"); expect(log).toContain('"stopped"');
    // Same data directory can immediately reacquire the released job lock.
    server = await startStudioServer({ port: 0, staticDir, dataDir });
    await Bun.sleep(220);
    expect((await fetch(server.url + "/api/health")).status).toBe(200);
  } finally { await server?.stop(); await rm(root, { recursive: true, force: true }); }
});
