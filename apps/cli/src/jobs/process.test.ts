import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proveWorkerOwnership,
  runWindowsTaskkill,
  trackedProcessMatches,
  windowsProcessMatchesToken,
} from "./process";

describe("durable worker process cleanup", () => {
  it("treats every taskkill error as cleanup_failed without a root-liveness exception", async () => {
    expect(await runWindowsTaskkill(1234, async () => {
      throw Object.assign(new Error("taskkill raced with root exit"), { code: "ESRCH" });
    })).toBe("cleanup_failed");
  });

  it("accepts only a successful taskkill invocation as tree termination proof", async () => {
    const calls: Array<[string, string[], number]> = [];
    expect(await runWindowsTaskkill(4321, async (file, args, options) => {
      calls.push([file, args, options.timeout]);
    }, 321)).toBe("terminated");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["taskkill.exe", ["/PID", "4321", "/T", "/F"]]);
    expect(calls[0]?.[2]).toBeGreaterThan(0);
    expect(calls[0]?.[2]).toBeLessThan(321);
  });

  it("does not start taskkill after the shared cleanup budget is exhausted", async () => {
    let called = false;
    expect(await runWindowsTaskkill(4321, async () => {
      called = true;
    }, 0)).toBe("cleanup_failed");
    expect(called).toBe(false);
  });

  it("bounds the Windows identity query and treats timeout failures as unproven", async () => {
    const calls: Array<[string, string[], number]> = [];
    expect(await windowsProcessMatchesToken(1234, "owner-token", 250, async (file, args, options) => {
      calls.push([file, args, options.timeout]);
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    })).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("powershell.exe");
    expect(calls[0]?.[1].join(" ")).toContain("ProcessId=1234");
    expect(calls[0]?.[2]).toBeGreaterThan(0);
    expect(calls[0]?.[2]).toBeLessThan(250);
  });

  it("hard-bounds a command executor that ignores its AbortSignal", async () => {
    const neverReturns = async () => new Promise<never>(() => undefined);
    const startedAt = Date.now();
    expect(await windowsProcessMatchesToken(1234, "owner-token", 25, neverReturns)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(await runWindowsTaskkill(1234, neverReturns, 25)).toBe("cleanup_failed");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("proves a live worker through IPC and holds its PID through the cleanup window", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-owner-proof-"));
    const workerPath = join(root, "worker.ts");
    const token = "owner-token";
    const secret = "a".repeat(64);
    await writeFile(workerPath, `
import { installWorkerOwnershipResponder } from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)};
const dispose = installWorkerOwnershipResponder(${JSON.stringify(token)}, ${JSON.stringify(secret)});
await Bun.sleep(100);
dispose();
try { if (process.connected) process.disconnect?.(); } catch {}
`);
    const child = spawn(process.execPath, [workerPath], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await Bun.sleep(50);
      expect(await proveWorkerOwnership(child, token, secret, 500)).toBe(true);
      expect(await proveWorkerOwnership(child, token, "b".repeat(64), 50)).toBe(false);
      await Bun.sleep(150);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a live tracked child only when PID and owner token both match", () => {
    const liveChild = { pid: 4444, exitCode: null, signalCode: null };
    const proveOwnership = async () => true;
    expect(trackedProcessMatches(4444, "token", { child: liveChild, token: "token", proveOwnership })).toBe(true);
    expect(trackedProcessMatches(5555, "token", { child: liveChild, token: "token", proveOwnership })).toBe(false);
    expect(trackedProcessMatches(4444, "token", { child: liveChild, token: "other", proveOwnership })).toBe(false);
    expect(trackedProcessMatches(4444, "token", {
      child: { ...liveChild, exitCode: 0 }, token: "token", proveOwnership,
    })).toBe(false);
    expect(trackedProcessMatches(4444, "token", {
      child: { ...liveChild, signalCode: "SIGTERM" }, token: "token", proveOwnership,
    })).toBe(false);
  });
});
