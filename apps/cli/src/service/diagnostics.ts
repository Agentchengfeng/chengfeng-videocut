import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

// Fixed namespace, conservative rotation threshold and capped structured rows.
// Legacy stdout/stderr are deliberately not renamed: launchd retains open FDs.
export const DIAGNOSTIC_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_FILE_BYTES = 1024 * 1024;
export const DIAGNOSTIC_FILE_COUNT = 96;
const rotateAt = DIAGNOSTIC_FILE_BYTES - 64 * 1024;
const marker = '"diagnosticSchema":1';
const keys = new Set(["pid", "initialParentPid", "parentPid", "previousParentPid", "observedParentPid", "code", "port", "index", "idleTimeoutMs", "timeoutSeconds", "activeRequests", "clients", "jobs"]);
const enums: Record<string, readonly string[]> = {
  runtimeMode: ["foreground", "launchd", "windows-task"],
  signal: ["SIGINT", "SIGTERM", "SIGHUP"],
  errorName: ["Error", "TypeError", "RangeError", "UnknownError", "JobStoreError", "StudioServiceError"],
  origin: ["uncaughtException", "unhandledRejection"],
  reason: ["idle_timeout", "explicit_stop", "signal"],
  code: ["EADDRINUSE", "EACCES", "EPERM", "ENOENT", "ENOSPC", "job_runtime_conflict", "service_port_conflict"],
};
const phases = new Set(["starting", "startup_failed", "listening", "stopping", "stopped", "stop_failed", "signal", "parent_changed", "parent_unavailable", "process_exit", "uncaught_exception", "idle_timeout", "idle_stop_failed", "busy_check_failed", "test"]);
export function diagnosticDirectory(dataDir: string) { return join(dataDir, "logs", "diagnostics-v1"); }
function directory(dataDir: string, create: boolean) {
  for (const path of [dataDir, join(dataDir, "logs"), diagnosticDirectory(dataDir)]) {
    try {
      const s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe diagnostics directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw e;
      try { mkdirSync(path, { mode: 0o700 }); } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
        const s = lstatSync(path);
        if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe diagnostics directory");
      }
    }
  }
  return diagnosticDirectory(dataDir);
}
function slotPath(root: string, slot: number) { return join(root, `events-${String(slot).padStart(2, "0")}.jsonl`); }
function owned(path: string, staleBefore?: number) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Unsafe diagnostics file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (current.ino !== s.ino || current.dev !== s.dev) throw new Error("Diagnostics file changed");
    if (current.size > DIAGNOSTIC_FILE_BYTES) throw new Error("Oversize diagnostics file");
    const header = Buffer.alloc(1024);
    const n = readSync(fd, header, 0, header.length, 0);
    if (n && !header.subarray(0, n).toString().includes(marker)) throw new Error("Unknown diagnostics file");
    let firstTimestamp = current.mtimeMs;
    try {
      const parsed = JSON.parse(header.subarray(0, n).toString().split("\n")[0]!);
      const timestamp = Date.parse(parsed.timestamp);
      if (Number.isFinite(timestamp)) firstTimestamp = Math.min(firstTimestamp, timestamp);
    } catch { /* Interrupted last write; still only touch our marked namespace. */ }
    let latestTimestamp = firstTimestamp;
    // A day-sized slot can contain both expired and retained events. Only scan
    // candidates for age cleanup; never infer the whole slot's age from its head.
    if (staleBefore !== undefined && firstTimestamp < staleBefore) {
      const buffer = Buffer.alloc(current.size);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      if (count !== buffer.length) throw new Error("Incomplete diagnostics read");
      let latest = -Infinity;
      for (const row of buffer.toString("utf8").split("\n")) {
        const timestamp = eventTimestamp(row);
        if (timestamp !== undefined) latest = Math.max(latest, timestamp);
      }
      latestTimestamp = Number.isFinite(latest) ? latest : current.mtimeMs;
    }
    return Object.assign(current, { firstTimestamp, latestTimestamp });
  } finally { closeSync(fd); }
}

function eventTimestamp(row: string): number | undefined {
  try {
    const value = JSON.parse(row);
    const timestamp = Date.parse(value.timestamp);
    if (value.diagnosticSchema === 1 && Number.isFinite(timestamp)) return timestamp;
  } catch { /* Ignore interrupted rows, not failures to inspect their source. */ }
  return undefined;
}

/** Safe fields only: never accepts arbitrary message, stack, URL or transcript. */
export function createDiagnosticLog(dataDir: string, instanceId: string, options: { now?: () => number; onError?: () => void } = {}) {
  const now = options.now ?? Date.now;
  let path = slotPath(diagnosticDirectory(dataDir), 0);
  let failed = false;
  const record = (phase: string, details: Record<string, string | number> = {}): boolean => {
    try {
      const root = directory(dataDir, true);
      const fields: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(details)) {
        if (keys.has(key) && typeof value === "number" && Number.isFinite(value)) fields[key] = value;
        else if (typeof value === "string" && enums[key]?.includes(value)) fields[key] = value;
      }
      const time = now();
      const row = Buffer.from(JSON.stringify({ diagnosticSchema: 1, timestamp: new Date(time).toISOString(),
        instanceId: /^[a-f0-9-]{36}$/.test(instanceId) ? instanceId : "unknown", phase: phases.has(phase) ? phase : "unknown", ...fields }) + "\n");
      if (row.length > 1024) throw new Error("Oversize diagnostic event");
      const files: { path: string; size: number; mtimeMs: number; firstTimestamp: number }[] = [];
      let empty: string | undefined;
      for (let i = 0; i < DIAGNOSTIC_FILE_COUNT; i++) {
        const candidate = slotPath(root, i);
        try {
          const s = owned(candidate, time - DIAGNOSTIC_RETENTION_MS);
          if (s.latestTimestamp < time - DIAGNOSTIC_RETENTION_MS) {
            unlinkSync(candidate);
            empty ??= candidate;
          } else files.push({ path: candidate, size: s.size, mtimeMs: s.mtimeMs, firstTimestamp: s.firstTimestamp });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          empty ??= candidate;
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const active = files.find(f => f.size + row.length <= rotateAt && f.firstTimestamp >= time - 24 * 60 * 60 * 1000);
      path = active?.path ?? empty ?? files.at(-1)!.path;
      if (!active && !empty) unlinkSync(path);
      const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.size + row.length > DIAGNOSTIC_FILE_BYTES) throw new Error("Diagnostics capacity changed");
        if (s.size) {
          const header = Buffer.alloc(64);
          const n = readSync(fd, header, 0, header.length, 0);
          if (!header.subarray(0, n).toString().includes(marker)) throw new Error("Unknown diagnostics file");
        }
        fchmodSync(fd, 0o600);
        // One append syscall per small row; no positional overwrite by another
        // startup attempt. Rotation reserves 64 KiB for concurrent appends.
        if (writeSync(fd, row) !== row.length) throw new Error("Incomplete diagnostics write");
      } finally { closeSync(fd); }
      failed = false;
      return true;
    } catch {
      if (!failed) {
        try { (options.onError ?? (() => console.error("[chengfeng-videocut] diagnostics unavailable; event not persisted")))(); }
        catch { /* Diagnostics must not change service fatal/exit semantics. */ }
      }
      failed = true;
      return false;
    }
  };
  return { record, get path() { return path; }, get available() { return !failed; } };
}

/** Offline, bounded, read-only. Never creates directories or starts a runtime. */
export function readDiagnosticLogs(dataDir: string, lines = 200, now = Date.now()): string {
  let root: string;
  try { root = directory(dataDir, false); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
  const files: { path: string; slot: number }[] = [];
  for (let i = 0; i < DIAGNOSTIC_FILE_COUNT; i++) {
    const path = slotPath(root, i);
    try { owned(path); files.push({ path, slot: i }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const limit = Math.min(1000, Math.max(1, Math.floor(lines) || 200));
  type Row = { text: string; timestamp: number; slot: number; index: number };
  let rows: Row[] = [];
  const compare = (a: Row, b: Row) => a.timestamp - b.timestamp || a.slot - b.slot || a.index - b.index;
  for (const file of files) {
    const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.size > DIAGNOSTIC_FILE_BYTES) throw new Error("Unsafe diagnostics file");
      const buffer = Buffer.alloc(s.size);
      const n = readSync(fd, buffer, 0, buffer.length, 0);
      if (n !== buffer.length) throw new Error("Incomplete diagnostics read");
      content = buffer.subarray(0, n).toString("utf8");
      if (n && !content.slice(0, 64).includes(marker)) throw new Error("Unknown diagnostics file");
    } finally { closeSync(fd); }
    for (const [index, text] of content.trim().split("\n").entries()) {
      const timestamp = eventTimestamp(text);
      if (timestamp !== undefined && timestamp >= now - DIAGNOSTIC_RETENTION_MS) {
        rows.push({ text, timestamp, slot: file.slot, index });
      }
    }
    // Keep only a bounded candidate tail between files. mtime is not event order:
    // the writer may have backfilled free space in an older slot.
    rows.sort(compare);
    rows = rows.slice(-limit);
  }
  return rows.map(row => row.text).join("\n");
}
