import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VideocutError } from "./errors";
import { serializeProjectOperation } from "./projectLock";

export const TRANSACTION_MARKER = ".videocut-transaction.json";
export const TRANSACTION_FILES = ["project.json", "transcript.json", "cut-selection.json", "edit-list.json", "subtitles.json", "visuals.json", "workbench.json", "index.html", "inserts.json"] as const;
/** Added after v1 journals existed: absent means null, and null is left out of the revision so older revisions stay valid. */
const OPTIONAL_TRANSACTION_FILES: ReadonlySet<string> = new Set(["inserts.json"]);
export type ProjectFiles = Record<(typeof TRANSACTION_FILES)[number], string | null>;
const JOURNAL_LIMIT = 64 * 1024 * 1024;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (message: string): never => { throw new VideocutError("operation_in_progress", message); };

export async function assertProjectReadable(directory: string): Promise<void> {
  try { await lstat(join(directory, TRANSACTION_MARKER)); }
  catch (e: any) { if (e.code === "ENOENT") return; throw e; }
  fail("Project has an incomplete multi-file transaction; query its operation and explicitly recover before use");
}

async function raw(path: string, limit = 8 * 1024 * 1024): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail("Transaction file is not a bounded regular file");
    return await readFile(path, "utf8");
  } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}

export async function snapshotProjectFiles(directory: string): Promise<ProjectFiles> {
  const values = await Promise.all(TRANSACTION_FILES.map(async name => [name, await raw(join(directory, name))]));
  const files = Object.fromEntries(values) as ProjectFiles;
  if (Buffer.byteLength(JSON.stringify(files)) > 24 * 1024 * 1024) fail("Project documents exceed transaction limit");
  return files;
}
export const projectFilesRevision = (files: ProjectFiles) => digest(JSON.stringify(TRANSACTION_FILES
  .filter(n => !OPTIONAL_TRANSACTION_FILES.has(n) || (files[n] ?? null) !== null).map(n => [n, files[n]])));

async function atomic(path: string, content: string) {
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
async function historyDirectory(directory: string, operationId: string, create = true) {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(operationId)) throw new VideocutError("invalid_operation_id", "Invalid transaction operationId");
  let path = directory;
  for (const part of [".chengfeng-videocut", "transactions", operationId]) {
    path = join(path, part);
    if (create) await mkdir(path).catch((e: any) => { if (e.code !== "EEXIST") throw e; });
    const s = await lstat(path).catch((e: any) => { if (e.code === "ENOENT" && !create) return null; throw e; });
    if (s && (!s.isDirectory() || s.isSymbolicLink())) fail("Unsafe transaction directory");
  }
  return path;
}
export interface ProjectTransaction { schemaVersion: 1; operationId: string; inputKey: string; before: ProjectFiles; after: ProjectFiles; }
function validateRecord(record: ProjectTransaction, operationId: string) {
  for (const files of [record?.before, record?.after]) if (files) for (const n of OPTIONAL_TRANSACTION_FILES) (files as Record<string, string | null>)[n] ??= null;
  if (!record || record.schemaVersion !== 1 || record.operationId !== operationId || typeof record.inputKey !== "string" || !record.before || !record.after ||
    TRANSACTION_FILES.some(n => (record.before[n] !== null && typeof record.before[n] !== "string") || (record.after[n] !== null && typeof record.after[n] !== "string"))) fail("Invalid transaction journal");
  for (const files of [record.before, record.after]) {
    if (TRANSACTION_FILES.some(n => files[n] !== null && Buffer.byteLength(files[n]!) > 8 * 1024 * 1024) || Buffer.byteLength(JSON.stringify(files)) > 24 * 1024 * 1024) fail("Project documents exceed transaction limit");
  }
}
export async function readProjectTransaction(directory: string, operationId: string): Promise<ProjectTransaction | null> {
  const dir = await historyDirectory(directory, operationId, false);
  const text = await raw(join(dir, "record.json"), JOURNAL_LIMIT);
  if (text === null) return null;
  const record = JSON.parse(text) as ProjectTransaction;
  validateRecord(record, operationId);
  return record;
}

export type ProjectTransactionState = "prepared" | "interrupted" | "committed" | "rolled_back" | "diverged";
export interface ProjectTransactionStatus {
  operationId: string;
  state: ProjectTransactionState;
  beforeRevision: string;
  afterRevision: string;
  currentRevision: string;
  reason?: string;
}

/** Observational only: never creates a lock/directory or replays a journal.
 * A concurrent writer can invalidate this observation; mutations recheck under the project lock. */
export async function getProjectTransactionStatus(directory: string, operationId: string): Promise<ProjectTransactionStatus | null> {
  const dir = await historyDirectory(directory, operationId, false);
  const body = await raw(join(dir, "record.json"), JOURNAL_LIMIT);
  if (body === null) return null;
  const record = JSON.parse(body) as ProjectTransaction;
  validateRecord(record, operationId);
  const markerRaw = await raw(join(directory, TRANSACTION_MARKER));
  const stateRaw = await raw(join(dir, "state.json"));
  const current = await snapshotProjectFiles(directory);
  const result: ProjectTransactionStatus = { operationId, state: "diverged", beforeRevision: projectFilesRevision(record.before), afterRevision: projectFilesRevision(record.after), currentRevision: projectFilesRevision(current) };
  const diverged = (reason: string) => ({ ...result, state: "diverged" as const, reason });
  if (markerRaw !== await raw(join(directory, TRANSACTION_MARKER)) || stateRaw !== await raw(join(dir, "state.json")) || body !== await raw(join(dir, "record.json"), JOURNAL_LIMIT) || result.currentRevision !== projectFilesRevision(await snapshotProjectFiles(directory))) return diverged("Transaction changed during status read; retry");
  if (markerRaw !== null) {
    let marker;
    try { marker = JSON.parse(markerRaw); } catch { return diverged("Invalid transaction marker"); }
    if (marker?.operationId !== operationId || marker?.sha256 !== digest(body)) return diverged("Marker does not match journal");
    for (const n of TRANSACTION_FILES) if (current[n] !== record.before[n] && current[n] !== record.after[n]) return diverged(`Unexpected file changed during transaction: ${n}`);
    return { ...result, state: "interrupted" };
  }
  if (stateRaw === null) return result.currentRevision === result.beforeRevision ? { ...result, state: "prepared" } : diverged("Unmarked transaction differs from its prepared input");
  let state;
  try { state = JSON.parse(stateRaw); } catch { return diverged("Invalid transaction state"); }
  const expected = state?.state === "committed" ? result.afterRevision : state?.state === "rolled_back" ? result.beforeRevision : null;
  if (expected === null || state.revision !== expected || (state.sha256 !== undefined && state.sha256 !== digest(body))) return diverged("Transaction state does not match journal");
  return result.currentRevision === expected ? { ...result, state: state.state } : diverged("Project changed after transaction");
}

async function publishFiles(directory: string, files: ProjectFiles, afterWrite?: (name: string) => Promise<void>) {
  for (const name of TRANSACTION_FILES) {
    const value = files[name], path = join(directory, name);
    // Rewriting an unchanged file is not a no-op for everyone watching the
    // project: each rename announces a change and makes open pages reload.
    if (value === null) await unlink(path).catch((e: any) => { if (e.code !== "ENOENT") throw e; });
    else if (await raw(path) !== value) await atomic(path, value);
    await afterWrite?.(name);
  }
  if (projectFilesRevision(await snapshotProjectFiles(directory)) !== projectFilesRevision(files)) fail("Transaction readback mismatch; marker retained");
}

/** Caller freezes/validates assets before this; all JSON consumers must refuse the marker. */
export async function commitProjectTransaction(directory: string, record: ProjectTransaction, afterWrite?: (name: string) => Promise<void>) {
  return serializeProjectOperation(directory, async () => {
    validateRecord(record, record.operationId);
    await assertProjectReadable(directory);
    const current = await snapshotProjectFiles(directory);
    const dir = await historyDirectory(directory, record.operationId);
    const old = await raw(join(dir, "record.json"), JOURNAL_LIMIT);
    if (old !== null) {
      const prior = JSON.parse(old) as ProjectTransaction;
      if (prior.inputKey !== record.inputKey) throw new VideocutError("operation_id_conflict", "operationId belongs to another input");
      const status = await getProjectTransactionStatus(directory, record.operationId);
      if (status?.state !== "committed") throw new VideocutError("operation_replay_stale", `Operation is ${status?.state}; explicitly recover instead of replaying`);
      return { changed: false, revision: projectFilesRevision(current), operationId: record.operationId };
    }
    if (projectFilesRevision(current) !== projectFilesRevision(record.before)) throw new VideocutError("revision_conflict", "Project changed after plan");
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > JOURNAL_LIMIT) fail("Transaction journal exceeds limit");
    // Publish a complete immutable journal before exposing the marker. A crash
    // in this gap is prepared, never evidence that the operation committed.
    await atomic(join(dir, "record.json"), body);
    await atomic(join(directory, TRANSACTION_MARKER), JSON.stringify({ operationId: record.operationId, sha256: digest(body) }));
    // Any interruption leaves the marker and immutable before/after versions.
    // Never blindly replay: recovery verifies each current file first.
    await publishFiles(directory, record.after, afterWrite);
    await atomic(join(dir, "state.json"), JSON.stringify({ state: "committed", revision: projectFilesRevision(record.after), sha256: digest(body) }));
    await unlink(join(directory, TRANSACTION_MARKER));
    return { changed: true, revision: projectFilesRevision(record.after), operationId: record.operationId };
  });
}

export async function recoverProjectTransaction(directory: string, operationId: string, action: "finish" | "rollback") {
  return serializeProjectOperation(directory, async () => {
    const record = await readProjectTransaction(directory, operationId);
    if (!record) throw new VideocutError("project_not_found", "Transaction not found");
    if (action !== "finish" && action !== "rollback") throw new VideocutError("invalid_argument", "Invalid recovery action");
    const dir = await historyDirectory(directory, operationId, false);
    const status = await getProjectTransactionStatus(directory, operationId);
    if (!status || status.state === "diverged") throw new VideocutError("revision_conflict", status?.reason ?? "Transaction disappeared");
    const targetState = action === "finish" ? "committed" : "rolled_back";
    if (status.state === targetState) return { operationId, state: targetState, revision: status.currentRevision };
    if (status.state === "rolled_back") throw new VideocutError("operation_replay_stale", "Rolled back operation cannot be replayed; use a new operationId");
    const body = (await raw(join(dir, "record.json"), JOURNAL_LIMIT))!;
    await atomic(join(directory, TRANSACTION_MARKER), JSON.stringify({ operationId, sha256: digest(body) }));
    const files = action === "finish" ? record.after : record.before;
    await publishFiles(directory, files);
    await atomic(join(dir, "state.json"), JSON.stringify({ state: targetState, revision: projectFilesRevision(files), sha256: digest(body) }));
    await unlink(join(directory, TRANSACTION_MARKER));
    return { operationId, state: action === "finish" ? "committed" : "rolled_back", revision: projectFilesRevision(files) };
  });
}
