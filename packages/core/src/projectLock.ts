import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { VideocutError } from "./errors";

export const PROJECT_OPERATION_LOCK_NAME = ".chengfeng-videocut.write.lock";

const LOCK_OWNER_NAME = "owner";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export interface ProjectOperationLockOptions {
  /** Maximum time to wait for another process to finish its mutation. */
  timeoutMs?: number;
  /** A lock without a heartbeat for this long may be recovered. */
  staleMs?: number;
  /** Base delay between acquisition attempts. A small random jitter is added. */
  pollIntervalMs?: number;
  /** Primarily useful for deterministic tests; normally derived from staleMs. */
  heartbeatIntervalMs?: number;
}

interface ProjectLockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

interface HeldProjectLock {
  path: string;
  owner: ProjectLockOwner;
  heartbeat: ReturnType<typeof setInterval>;
}

const projectQueues = new Map<string, Promise<void>>();
const heldProjectDirectories = new AsyncLocalStorage<ReadonlySet<string>>();

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new VideocutError("invalid_argument", `${name} must be a positive number`, {
      [name]: value,
    });
  }
  return normalized;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readOwner(lockPath: string): Promise<ProjectLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockPath, LOCK_OWNER_NAME), "utf8")) as Partial<ProjectLockOwner>;
    if (
      parsed.version !== 1 ||
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as ProjectLockOwner;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function localProcessIsAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    return null;
  }
}

async function recoverStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }

  const ageMs = Date.now() - lockStat.mtimeMs;
  const owner = await readOwner(lockPath);
  let recoverable = ageMs >= staleMs;
  if (owner?.hostname === hostname()) {
    const alive = localProcessIsAlive(owner.pid);
    if (alive === true) return false;
    // A confirmed-dead local owner can be recovered after a short grace
    // period, while an indeterminate owner still needs the full stale timeout.
    if (alive === false) recoverable = ageMs >= Math.min(staleMs, 1_000);
  }
  if (!recoverable) return false;

  const tombstone = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    // Another contender may already have recovered or replaced the lock.
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") return false;
    throw error;
  }
  await rm(tombstone, { force: true, recursive: true });
  return true;
}

async function acquireProjectLock(
  projectDirectory: string,
  options: ProjectOperationLockOptions,
): Promise<HeldProjectLock> {
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const staleMs = positiveNumber(options.staleMs, DEFAULT_STALE_MS, "staleMs");
  const pollIntervalMs = positiveNumber(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const heartbeatIntervalMs = positiveNumber(
    options.heartbeatIntervalMs,
    Math.max(10, Math.min(5_000, Math.floor(staleMs / 3))),
    "heartbeatIntervalMs",
  );
  const lockPath = projectOperationLockPath(projectDirectory);
  const startedAt = Date.now();

  while (true) {
    const owner: ProjectLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    };
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, LOCK_OWNER_NAME), JSON.stringify(owner), {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }

      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => undefined);
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
      return { path: lockPath, owner, heartbeat };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    if (await recoverStaleLock(lockPath, staleMs)) continue;
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      throw new VideocutError(
        "io_error",
        "Timed out waiting for the project write lock",
        {
          reason: "project_lock_timeout",
          projectDirectory,
          lockPath,
          timeoutMs,
        },
      );
    }
    const jitterMs = Math.floor(Math.random() * Math.max(2, pollIntervalMs / 2));
    await delay(Math.min(pollIntervalMs + jitterMs, timeoutMs - waitedMs));
  }
}

async function releaseProjectLock(lock: HeldProjectLock): Promise<void> {
  clearInterval(lock.heartbeat);
  const owner = await readOwner(lock.path);
  if (owner?.token === lock.owner.token) {
    await rm(lock.path, { force: true, recursive: true });
    return;
  }
  if (!(await pathExists(lock.path))) return;
  throw new VideocutError("io_error", "Project write lock ownership was lost", {
    reason: "project_lock_ownership_lost",
    lockPath: lock.path,
    expectedToken: lock.owner.token,
    currentToken: owner?.token ?? null,
  });
}

async function withProjectFileLock<T>(
  projectDirectory: string,
  operation: () => Promise<T>,
  options: ProjectOperationLockOptions,
): Promise<T> {
  const lock = await acquireProjectLock(projectDirectory, options);
  const inherited = heldProjectDirectories.getStore() ?? new Set<string>();
  const held = new Set(inherited);
  held.add(projectDirectory);
  try {
    return await heldProjectDirectories.run(held, operation);
  } finally {
    await releaseProjectLock(lock);
  }
}

function enqueueProjectOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  projectQueues.set(key, tail);
  void tail.then(() => {
    if (projectQueues.get(key) === tail) projectQueues.delete(key);
  });
  return result;
}

export function projectOperationLockPath(projectDirectory: string): string {
  return join(resolve(projectDirectory), PROJECT_OPERATION_LOCK_NAME);
}

/**
 * Serializes a project's mutations both inside this process and across
 * independent CLI/Studio processes. Revision checks must stay inside
 * `operation`, so every contender re-reads the document after acquiring the
 * lock and stale expected revisions deterministically conflict.
 */
export async function serializeProjectOperation<T>(
  projectDirectory: string,
  operation: () => Promise<T>,
  options: ProjectOperationLockOptions = {},
): Promise<T> {
  const canonicalDirectory = await realpath(resolve(projectDirectory));
  if (heldProjectDirectories.getStore()?.has(canonicalDirectory)) {
    return operation();
  }
  return enqueueProjectOperation(canonicalDirectory, () =>
    withProjectFileLock(canonicalDirectory, operation, options));
}
