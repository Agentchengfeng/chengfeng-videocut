import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { JobStoreError, syncDirectory } from "./store";

interface RuntimeLockOwner {
  version: 1;
  pid: number;
  token: string;
  hostname: string;
  acquiredAt: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(raw: string, path: string): RuntimeLockOwner {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock is not valid JSON", { path });
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    !Number.isInteger((value as Record<string, unknown>).pid) ||
    Number((value as Record<string, unknown>).pid) <= 0 ||
    typeof (value as Record<string, unknown>).token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(String((value as Record<string, unknown>).token)) ||
    typeof (value as Record<string, unknown>).hostname !== "string" ||
    typeof (value as Record<string, unknown>).acquiredAt !== "string"
  ) {
    throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock owner is invalid", { path });
  }
  return value as RuntimeLockOwner;
}

/**
 * Cross-process singleton for the durable-job registry.
 *
 * JobStore's transaction queue is deliberately in-process. This lock is taken
 * before recovery so a second Runtime can never mistake the first Runtime's
 * live worker for an orphan and terminate it.
 */
export class RuntimeJobLock {
  readonly jobsDirectory: string;
  readonly path: string;
  readonly token = randomUUID();
  #held = false;

  constructor(dataDir: string) {
    this.jobsDirectory = resolve(dataDir, "jobs");
    this.path = join(this.jobsDirectory, ".runtime-owner.json");
  }

  get held(): boolean { return this.#held; }

  async acquire(): Promise<void> {
    if (this.#held) return;
    await mkdir(this.jobsDirectory, { recursive: true });
    const owner: RuntimeLockOwner = {
      version: 1,
      pid: process.pid,
      token: this.token,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const handle = await open(this.path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(this.jobsDirectory);
        this.#held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let info;
      try { info = await lstat(this.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock is not a private regular file", {
          path: this.path,
        });
      }
      const raw = await readFile(this.path, "utf8");
      const existing = parseOwner(raw, this.path);
      if (existing.hostname !== hostname() || processExists(existing.pid)) {
        throw new JobStoreError("job_runtime_conflict", "Another Runtime owns the durable job registry", {
          ownerPid: existing.pid,
          acquiredAt: existing.acquiredAt,
        });
      }

      // Re-read immediately before unlinking. A mismatched owner means another
      // contender changed the path, so this process must not reap it.
      const latest = parseOwner(await readFile(this.path, "utf8"), this.path);
      if (latest.token !== existing.token || latest.pid !== existing.pid) {
        throw new JobStoreError("job_runtime_conflict", "Durable job Runtime lock changed during recovery", {
          ownerPid: latest.pid,
        });
      }
      await unlink(this.path);
      await syncDirectory(this.jobsDirectory);
    }
    throw new JobStoreError("job_runtime_conflict", "Could not acquire durable job Runtime ownership");
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    let owner: RuntimeLockOwner;
    try { owner = parseOwner(await readFile(this.path, "utf8"), this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#held = false;
        return;
      }
      throw error;
    }
    if (owner.token !== this.token || owner.pid !== process.pid) {
      throw new JobStoreError("job_runtime_lock_lost", "Durable job Runtime lock ownership changed", {
        ownerPid: owner.pid,
      });
    }
    await unlink(this.path);
    await syncDirectory(this.jobsDirectory);
    this.#held = false;
  }
}
