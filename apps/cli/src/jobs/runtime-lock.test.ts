import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeJobLock } from "./runtime-lock";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; dataDir: string; jobsDir: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "runtime-lock-cas-"));
  cleanup.push(root);
  const dataDir = join(root, "data");
  const jobsDir = join(dataDir, "jobs");
  await mkdir(jobsDir, { recursive: true });
  return { root, dataDir, jobsDir, lockPath: join(jobsDir, ".runtime-owner.json") };
}

function owner(pid: number, token = randomUUID()) {
  return {
    version: 1 as const,
    pid,
    token,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };
}

async function writeOwnerDirectory(path: string, value: ReturnType<typeof owner>): Promise<void> {
  await mkdir(path, { recursive: false });
  await writeFile(join(path, "owner.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function runtimePaths(jobsDir: string): Promise<string[]> {
  return (await readdir(jobsDir))
    .filter((name) => name === ".runtime-owner.json" || name.startsWith(".runtime-owner.json.tombstone."))
    .sort();
}

async function garbagePaths(jobsDir: string): Promise<string[]> {
  return (await readdir(jobsDir))
    .filter((name) => name.startsWith(".runtime-owner.json.garbage."))
    .sort();
}

async function ownerTokens(jobsDir: string): Promise<string[]> {
  const tokens: string[] = [];
  for (const name of await runtimePaths(jobsDir)) {
    const path = join(jobsDir, name);
    const info = await lstat(path);
    const raw = await readFile(info.isDirectory() ? join(path, "owner.json") : path, "utf8");
    tokens.push(JSON.parse(raw).token);
  }
  return tokens;
}

describe("RuntimeJobLock stale-owner CAS", () => {
  it("allows only one of two barrier-synchronized stale contenders to acquire", async () => {
    const f = await fixture();
    await writeFile(f.lockPath, `${JSON.stringify(owner(2_000_000_000))}\n`, { mode: 0o600 });

    let arrivals = 0;
    let bothArrived!: () => void;
    let openGate!: () => void;
    const atBarrier = new Promise<void>((resolve) => { bothArrived = resolve; });
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const barrier = async () => {
      arrivals += 1;
      if (arrivals === 2) bothArrived();
      await gate;
    };
    const first = new RuntimeJobLock(f.dataDir, { afterStaleOwnerRead: barrier });
    const second = new RuntimeJobLock(f.dataDir, { afterStaleOwnerRead: barrier });
    const attempts = [first.acquire(), second.acquire()];
    await Promise.race([
      atBarrier,
      Bun.sleep(2_000).then(() => { throw new Error("contenders did not reach the stale-owner barrier"); }),
    ]);
    openGate();
    const results = await Promise.allSettled(attempts);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "job_runtime_conflict" });
    const winner = first.held ? first : second;
    const loser = first.held ? second : first;
    expect(winner.held).toBe(true);
    expect(loser.held).toBe(false);
    expect(await ownerTokens(f.jobsDir)).toEqual([winner.token]);

    const third = new RuntimeJobLock(f.dataDir);
    await expect(third.acquire()).rejects.toMatchObject({ code: "job_runtime_conflict" });
    await winner.release();
    expect(await runtimePaths(f.jobsDir)).toEqual([]);
  });

  it("fences a delayed stale contender that renames the newly published owner", async () => {
    const f = await fixture();
    await writeFile(f.lockPath, `${JSON.stringify(owner(2_000_000_000))}\n`, { mode: 0o600 });

    let firstRead!: () => void;
    let secondRead!: () => void;
    let allowFirst!: () => void;
    let allowSecond!: () => void;
    const firstAtBarrier = new Promise<void>((resolve) => { firstRead = resolve; });
    const secondAtBarrier = new Promise<void>((resolve) => { secondRead = resolve; });
    const firstGate = new Promise<void>((resolve) => { allowFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { allowSecond = resolve; });
    const first = new RuntimeJobLock(f.dataDir, {
      afterStaleOwnerRead: async () => { firstRead(); await firstGate; },
    });
    const second = new RuntimeJobLock(f.dataDir, {
      afterStaleOwnerRead: async () => { secondRead(); await secondGate; },
    });

    const firstAttempt = first.acquire();
    await firstAtBarrier;
    const secondAttempt = second.acquire();
    await secondAtBarrier;
    allowFirst();
    await firstAttempt;
    expect(first.held).toBe(true);

    // The second contender still holds the old snapshot here. Its rename moves
    // the first contender's new canonical directory, not the stale owner.
    allowSecond();
    await expect(secondAttempt).rejects.toMatchObject({ code: "job_runtime_conflict" });
    expect(second.held).toBe(false);
    expect(await ownerTokens(f.jobsDir)).toEqual([first.token]);
    expect((await runtimePaths(f.jobsDir))[0]).toStartWith(".runtime-owner.json.tombstone.");

    const third = new RuntimeJobLock(f.dataDir);
    await expect(third.acquire()).rejects.toMatchObject({ code: "job_runtime_conflict" });
    await first.release();
    expect(await runtimePaths(f.jobsDir)).toEqual([]);
  });

  it("serializes release then acquire on one instance without returning an ownerless success", async () => {
    const f = await fixture();
    let atRetire!: () => void;
    let continueRetire!: () => void;
    let blockOnce = true;
    const retireStarted = new Promise<void>((resolve) => { atRetire = resolve; });
    const retireGate = new Promise<void>((resolve) => { continueRetire = resolve; });
    const lock = new RuntimeJobLock(f.dataDir, {
      async beforeOwnedLocationRetire() {
        if (!blockOnce) return;
        blockOnce = false;
        atRetire();
        await retireGate;
      },
    });
    await lock.acquire();

    const releasing = lock.release();
    await retireStarted;
    expect(lock.held).toBe(false);
    let reacquired = false;
    const acquiring = lock.acquire().then(() => { reacquired = true; });
    await Bun.sleep(10);
    expect(reacquired).toBe(false);

    continueRetire();
    await releasing;
    await acquiring;
    expect(lock.held).toBe(true);
    expect(await ownerTokens(f.jobsDir)).toEqual([lock.token]);
    expect(await garbagePaths(f.jobsDir)).toEqual([]);

    await lock.release();
    expect(await runtimePaths(f.jobsDir)).toEqual([]);
  });

  it("serializes acquire then release on one instance without leaving a lock", async () => {
    const f = await fixture();
    let atPublish!: () => void;
    let continuePublish!: () => void;
    let blockOnce = true;
    const published = new Promise<void>((resolve) => { atPublish = resolve; });
    const publishGate = new Promise<void>((resolve) => { continuePublish = resolve; });
    const lock = new RuntimeJobLock(f.dataDir, {
      async afterOwnerPublished() {
        if (!blockOnce) return;
        blockOnce = false;
        atPublish();
        await publishGate;
      },
    });

    let acquireSettled = false;
    let releaseSettled = false;
    const acquiring = lock.acquire().then(() => { acquireSettled = true; });
    await published;
    const releasing = lock.release().then(() => { releaseSettled = true; });
    await Bun.sleep(10);
    expect(acquireSettled).toBe(false);
    expect(releaseSettled).toBe(false);

    continuePublish();
    await acquiring;
    await releasing;
    expect(lock.held).toBe(false);
    expect(await runtimePaths(f.jobsDir)).toEqual([]);
    expect(await garbagePaths(f.jobsDir)).toEqual([]);
  });

  it("preserves an active legacy owner without creating a tombstone", async () => {
    const f = await fixture();
    const active = owner(process.pid);
    const raw = `${JSON.stringify(active)}\n`;
    await writeFile(f.lockPath, raw, { mode: 0o600 });
    const abandonedGarbage = join(f.jobsDir, `.runtime-owner.json.garbage.${randomUUID()}`);
    await mkdir(abandonedGarbage);

    await expect(new RuntimeJobLock(f.dataDir).acquire()).rejects.toMatchObject({
      code: "job_runtime_conflict",
      details: { ownerPid: process.pid },
    });
    expect(await readFile(f.lockPath, "utf8")).toBe(raw);
    expect(await runtimePaths(f.jobsDir)).toEqual([".runtime-owner.json"]);
    expect(await garbagePaths(f.jobsDir)).toEqual([]);
  });

  it("fails closed on a damaged canonical lock without moving or deleting it", async () => {
    const f = await fixture();
    await writeFile(f.lockPath, "not-json\n", { mode: 0o600 });

    await expect(new RuntimeJobLock(f.dataDir).acquire()).rejects.toMatchObject({ code: "job_runtime_lock_corrupt" });
    expect(await readFile(f.lockPath, "utf8")).toBe("not-json\n");
    expect(await runtimePaths(f.jobsDir)).toEqual([".runtime-owner.json"]);
  });

  it("does not replace a damaged empty canonical directory while publishing", async () => {
    const f = await fixture();
    await mkdir(f.lockPath);

    await expect(new RuntimeJobLock(f.dataDir).acquire()).rejects.toMatchObject({ code: "job_runtime_lock_corrupt" });
    expect((await lstat(f.lockPath)).isDirectory()).toBe(true);
    expect(await readdir(f.lockPath)).toEqual([]);
    expect(await runtimePaths(f.jobsDir)).toEqual([".runtime-owner.json"]);
  });

  it("cleans its unique stale claim when recovery fails normally", async () => {
    const f = await fixture();
    await writeFile(f.lockPath, `${JSON.stringify(owner(2_000_000_000))}\n`, { mode: 0o600 });
    const injected = new Error("injected recovery failure");
    const failed = new RuntimeJobLock(f.dataDir, {
      afterStaleOwnerClaimed: () => { throw injected; },
    });

    await expect(failed.acquire()).rejects.toBe(injected);
    expect(failed.held).toBe(false);
    expect(await runtimePaths(f.jobsDir)).toEqual([]);

    const replacement = new RuntimeJobLock(f.dataDir);
    await replacement.acquire();
    expect(replacement.held).toBe(true);
    await replacement.release();
  });

  it("reaps a stale crash tombstone before publishing a new owner", async () => {
    const f = await fixture();
    const tombstonePath = join(f.jobsDir, `.runtime-owner.json.tombstone.${randomUUID()}`);
    await writeOwnerDirectory(tombstonePath, owner(2_000_000_000));

    const lock = new RuntimeJobLock(f.dataDir);
    await lock.acquire();
    expect(lock.held).toBe(true);
    expect(await runtimePaths(f.jobsDir)).toEqual([".runtime-owner.json"]);
    expect(await ownerTokens(f.jobsDir)).toEqual([lock.token]);
    await lock.release();
  });

  it("moves a tombstone out of the lock namespace before interruptible recursive cleanup", async () => {
    const f = await fixture();
    await writeOwnerDirectory(f.lockPath, owner(2_000_000_000));
    const injected = new Error("crash after tombstone retirement");
    let retiredGarbage = "";
    const interrupted = new RuntimeJobLock(f.dataDir, {
      afterTombstoneRetired(garbagePath) {
        retiredGarbage = garbagePath;
        throw injected;
      },
    });

    await expect(interrupted.acquire()).rejects.toBe(injected);
    expect(interrupted.held).toBe(false);
    expect(await runtimePaths(f.jobsDir)).toEqual([]);
    expect(await garbagePaths(f.jobsDir)).toHaveLength(1);

    // Model rm having deleted owner.json before the process died. The empty
    // garbage directory is not a lock and must be cleaned by the next acquire.
    await rm(join(retiredGarbage, "owner.json"));
    expect(await readdir(retiredGarbage)).toEqual([]);
    const replacement = new RuntimeJobLock(f.dataDir);
    await replacement.acquire();
    expect(await garbagePaths(f.jobsDir)).toEqual([]);
    expect(await ownerTokens(f.jobsDir)).toEqual([replacement.token]);
    await replacement.release();
  });

  it("releases itself safely after its canonical directory was displaced to a tombstone", async () => {
    const f = await fixture();
    const lock = new RuntimeJobLock(f.dataDir);
    await lock.acquire();
    const displaced = join(f.jobsDir, `.runtime-owner.json.tombstone.${randomUUID()}`);
    await rename(f.lockPath, displaced);

    const contender = new RuntimeJobLock(f.dataDir);
    await expect(contender.acquire()).rejects.toMatchObject({ code: "job_runtime_conflict" });
    await lock.release();
    expect(await runtimePaths(f.jobsDir)).toEqual([]);

    await contender.acquire();
    await contender.release();
  });
});
