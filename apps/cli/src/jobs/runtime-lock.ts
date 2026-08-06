import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { JobStoreError, syncDirectory } from "./store";

interface RuntimeLockOwner {
  version: 1;
  pid: number;
  token: string;
  hostname: string;
  acquiredAt: string;
}

interface RuntimeLockRecord {
  owner: RuntimeLockOwner;
  layout: "directory" | "legacy-file";
  path: string;
}

export interface RuntimeJobLockHooks {
  afterStaleOwnerRead?: (owner: Readonly<RuntimeLockOwner>) => void | Promise<void>;
  afterStaleOwnerClaimed?: (owner: Readonly<RuntimeLockOwner>, tombstonePath: string) => void | Promise<void>;
  afterOwnerPublished?: (owner: Readonly<RuntimeLockOwner>) => void | Promise<void>;
  beforeOwnedLocationRetire?: (owner: Readonly<RuntimeLockOwner>, tombstonePath: string) => void | Promise<void>;
  afterTombstoneRetired?: (garbagePath: string) => void | Promise<void>;
}

const OWNER_NAME = "owner.json";
const LOCK_NAME = ".runtime-owner.json";
const CANDIDATE_PREFIX = `${LOCK_NAME}.candidate.`;
const TOMBSTONE_PREFIX = `${LOCK_NAME}.tombstone.`;
const GARBAGE_PREFIX = `${LOCK_NAME}.garbage.`;
const MAX_ACQUIRE_ATTEMPTS = 16;

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

function sameOwner(left: RuntimeLockOwner, right: RuntimeLockOwner): boolean {
  return left.token === right.token && left.pid === right.pid && left.hostname === right.hostname;
}

function conflict(owner: RuntimeLockOwner, path: string): JobStoreError {
  return new JobStoreError("job_runtime_conflict", "Another Runtime owns the durable job registry", {
    ownerPid: owner.pid,
    acquiredAt: owner.acquiredAt,
    path,
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readLockRecord(path: string): Promise<RuntimeLockRecord> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock cannot be a symbolic link", { path });
  }
  if (info.isFile()) {
    if (info.nlink !== 1) {
      throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock is not a private regular file", {
        path,
      });
    }
    return { owner: parseOwner(await readFile(path, "utf8"), path), layout: "legacy-file", path };
  }
  if (!info.isDirectory()) {
    throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock is not a private directory", { path });
  }

  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== OWNER_NAME || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime lock directory is invalid", { path });
  }
  const ownerPath = join(path, OWNER_NAME);
  const ownerInfo = await lstat(ownerPath);
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1) {
    throw new JobStoreError("job_runtime_lock_corrupt", "Durable job Runtime owner is not a private regular file", {
      path: ownerPath,
    });
  }
  return {
    owner: parseOwner(await readFile(ownerPath, "utf8"), ownerPath),
    layout: "directory",
    path,
  };
}

/**
 * Cross-process singleton for the durable-job registry.
 *
 * JobStore's transaction queue is deliberately in-process. This lock is taken
 * before recovery so a second Runtime can never mistake the first Runtime's
 * live worker for an orphan and terminate it.
 *
 * A complete owner directory is built under a unique candidate name and then
 * atomically renamed into the canonical path. A stale canonical lock is first
 * renamed to a unique tombstone. Tombstones are also ownership fences: a
 * contender checks them both before and after publishing, so a delayed stale
 * contender cannot move a newly-published live lock and let a second Runtime
 * declare itself the owner.
 */
export class RuntimeJobLock {
  readonly jobsDirectory: string;
  readonly path: string;
  readonly token = randomUUID();
  readonly #hooks: RuntimeJobLockHooks;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #held = false;

  constructor(dataDir: string, hooks: RuntimeJobLockHooks = {}) {
    this.jobsDirectory = resolve(dataDir, "jobs");
    this.path = join(this.jobsDirectory, LOCK_NAME);
    this.#hooks = hooks;
  }

  get held(): boolean { return this.#held; }

  acquire(): Promise<void> {
    return this.#withLifecycle(() => this.#acquire());
  }

  release(): Promise<void> {
    return this.#withLifecycle(() => this.#release());
  }

  async #acquire(): Promise<void> {
    if (this.#held) return;
    await mkdir(this.jobsDirectory, { recursive: true });
    const owner: RuntimeLockOwner = {
      version: 1,
      pid: process.pid,
      token: this.token,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      await this.#clearGarbage();
      await this.#clearStaleTombstones();
      if (await this.#publishOwner(owner)) {
        try {
          // A contender that read the old owner before this publish can still
          // move this directory afterward. Its live tombstone must fence this
          // acquisition before #held becomes observable.
          await this.#clearStaleTombstones();
          if (!await this.#hasOwnerLocation(owner)) {
            throw new JobStoreError("job_runtime_lock_lost", "Durable job Runtime ownership disappeared during acquisition");
          }
        } catch (error) {
          await this.#removeOwnedLocations(owner);
          throw error;
        }
        this.#held = true;
        return;
      }

      let existing: RuntimeLockRecord;
      try { existing = await readLockRecord(this.path); }
      catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (existing.owner.hostname !== hostname() || processExists(existing.owner.pid)) {
        throw conflict(existing.owner, this.path);
      }

      await this.#hooks.afterStaleOwnerRead?.(Object.freeze({ ...existing.owner }));
      const tombstonePath = join(this.jobsDirectory, `${TOMBSTONE_PREFIX}${randomUUID()}`);
      try {
        await rename(this.path, tombstonePath);
        await syncDirectory(this.jobsDirectory);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }

      let claimed: RuntimeLockRecord;
      try { claimed = await readLockRecord(tombstonePath); }
      catch (error) {
        // Another contender may have already proved and removed this stale,
        // uniquely named tombstone. Any other failure is fail-closed.
        if (isMissing(error)) continue;
        throw error;
      }
      if (!sameOwner(claimed.owner, existing.owner)) {
        // This contender's snapshot lost the race and the rename moved a newer
        // owner. Never delete it. Its unique tombstone remains a live fencing
        // record until that owner releases or becomes stale.
        continue;
      }
      if (claimed.owner.hostname !== hostname() || processExists(claimed.owner.pid)) {
        throw conflict(claimed.owner, tombstonePath);
      }

      try {
        await this.#hooks.afterStaleOwnerClaimed?.(Object.freeze({ ...claimed.owner }), tombstonePath);
      } catch (error) {
        // The unique name cannot be reused, so normal failure cleanup cannot
        // remove another contender's lock.
        await this.#retireTombstone(claimed).catch((cleanupError) => {
          if (!isMissing(cleanupError)) throw cleanupError;
        });
        throw error;
      }
      await this.#retireTombstone(claimed).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
    throw new JobStoreError("job_runtime_conflict", "Could not acquire durable job Runtime ownership");
  }

  async #release(): Promise<void> {
    if (!this.#held) return;
    // Calls on this instance are serialized, so clearing the in-memory state
    // now cannot race a same-instance acquire. If filesystem retirement later
    // fails, the next acquire must inspect disk instead of returning success
    // from stale in-memory state.
    this.#held = false;
    const owner: RuntimeLockOwner = {
      version: 1,
      pid: process.pid,
      token: this.token,
      hostname: hostname(),
      acquiredAt: "",
    };
    const removed = await this.#removeOwnedLocations(owner);
    if (removed) return;

    let current: RuntimeLockRecord | null = null;
    try { current = await readLockRecord(this.path); }
    catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (current) {
      throw new JobStoreError("job_runtime_lock_lost", "Durable job Runtime lock ownership changed", {
        ownerPid: current.owner.pid,
      });
    }
  }

  async #publishOwner(owner: RuntimeLockOwner): Promise<boolean> {
    const candidatePath = join(this.jobsDirectory, `${CANDIDATE_PREFIX}${this.token}.${randomUUID()}`);
    await mkdir(candidatePath, { mode: 0o700 });
    const ownerPath = join(candidatePath, OWNER_NAME);
    const handle = await open(ownerPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(candidatePath);
    try {
      await lstat(this.path);
      await rm(candidatePath, { recursive: true, force: true });
      return false;
    } catch (error) {
      if (!isMissing(error)) {
        await rm(candidatePath, { recursive: true, force: true });
        throw error;
      }
    }
    let published = false;
    try {
      await rename(candidatePath, this.path);
      published = true;
      await syncDirectory(this.jobsDirectory);
      await this.#hooks.afterOwnerPublished?.(Object.freeze({ ...owner }));
      return true;
    } catch (error) {
      if (published) {
        await this.#removeOwnedLocations(owner);
        throw error;
      }
      let canonicalExists = false;
      try {
        await lstat(this.path);
        canonicalExists = true;
      } catch (statError) {
        if (!isMissing(statError)) throw statError;
      }
      await rm(candidatePath, { recursive: true, force: true });
      if (canonicalExists) return false;
      throw error;
    }
  }

  async #clearStaleTombstones(): Promise<void> {
    const entries = await readdir(this.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
      const path = join(this.jobsDirectory, entry.name);
      let record: RuntimeLockRecord;
      try { record = await readLockRecord(path); }
      catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (record.owner.hostname !== hostname() || processExists(record.owner.pid)) {
        throw conflict(record.owner, path);
      }
      // Tombstone names are never reused, so deleting this exact stale path is
      // immune to the canonical compare-delete race.
      await this.#retireTombstone(record).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
  }

  async #clearGarbage(): Promise<void> {
    let removed = false;
    for (const entry of await readdir(this.jobsDirectory, { withFileTypes: true })) {
      if (!entry.name.startsWith(GARBAGE_PREFIX)) continue;
      try {
        await rm(join(this.jobsDirectory, entry.name), { recursive: true, force: true });
        removed = true;
      } catch {
        // Garbage has already been atomically removed from the ownership
        // namespace. Cleanup is best-effort and can never block a new owner.
      }
    }
    if (removed) await syncDirectory(this.jobsDirectory).catch(() => undefined);
  }

  async #retireTombstone(record: RuntimeLockRecord): Promise<void> {
    const name = basename(record.path);
    if (join(this.jobsDirectory, name) !== record.path || !name.startsWith(TOMBSTONE_PREFIX)) {
      throw new JobStoreError("job_runtime_lock_corrupt", "Refusing to retire a path outside the Runtime tombstone namespace", {
        path: record.path,
      });
    }
    const garbagePath = join(this.jobsDirectory, `${GARBAGE_PREFIX}${randomUUID()}`);
    try {
      await rename(record.path, garbagePath);
      await syncDirectory(this.jobsDirectory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await this.#hooks.afterTombstoneRetired?.(garbagePath);
    await rm(garbagePath, { recursive: record.layout === "directory", force: true });
    await syncDirectory(this.jobsDirectory);
  }

  async #hasOwnerLocation(owner: RuntimeLockOwner): Promise<boolean> {
    try {
      const canonical = await readLockRecord(this.path);
      if (sameOwner(canonical.owner, owner)) return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const entry of await readdir(this.jobsDirectory, { withFileTypes: true })) {
      if (!entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
      try {
        const record = await readLockRecord(join(this.jobsDirectory, entry.name));
        if (sameOwner(record.owner, owner)) return true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return false;
  }

  async #removeOwnedLocations(owner: RuntimeLockOwner): Promise<boolean> {
    let removed = false;
    const cleanupPath = join(this.jobsDirectory, `${TOMBSTONE_PREFIX}${randomUUID()}`);
    try {
      await rename(this.path, cleanupPath);
      await syncDirectory(this.jobsDirectory);
      const claimed = await readLockRecord(cleanupPath);
      if (sameOwner(claimed.owner, owner)) {
        await this.#hooks.beforeOwnedLocationRetire?.(Object.freeze({ ...claimed.owner }), cleanupPath);
        await this.#retireTombstone(claimed);
        removed = true;
      }
      // A mismatched owner remains fenced under its unique tombstone.
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    for (const entry of await readdir(this.jobsDirectory, { withFileTypes: true })) {
      if (!entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
      const path = join(this.jobsDirectory, entry.name);
      let record: RuntimeLockRecord;
      try { record = await readLockRecord(path); }
      catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!sameOwner(record.owner, owner)) continue;
      await this.#hooks.beforeOwnedLocationRetire?.(Object.freeze({ ...record.owner }), path);
      await this.#retireTombstone(record).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      removed = true;
    }
    if (removed) await syncDirectory(this.jobsDirectory);
    return removed;
  }

  async #withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    let release!: () => void;
    this.#lifecycleTail = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
