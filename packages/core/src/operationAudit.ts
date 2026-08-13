import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VideocutError } from "./errors";

export const OPERATION_AUDIT_SCHEMA_VERSION = 1 as const;
export const OPERATION_ADMISSION_VERSION = 1 as const;
export const OPERATION_IDEMPOTENCY_VERSION = 1 as const;

export type OperationAuditKind =
  | "project.ingest"
  | "cuts.set"
  | "job.start.export";

export type OperationAuditTerminalStatus = "succeeded" | "failed" | "rejected" | "committed_partial";

export type OperationAuditFields = Record<string, string | number | boolean | null>;

export interface OperationAuditRecord {
  schemaVersion: typeof OPERATION_AUDIT_SCHEMA_VERSION;
  operationId: string;
  kind: OperationAuditKind;
  target: OperationAuditFields;
  inputHash: string;
  baseRevisions: OperationAuditFields;
  actor: string;
  entrypoint: string;
  startedAt: string;
  finishedAt: string | null;
  accepted: boolean;
  rejected: boolean;
  succeeded: boolean;
  failed: boolean;
  committedPartial: boolean;
  errorCode: string | null;
  result: OperationAuditFields | null;
}

export interface OperationAdmissionInput {
  operationId?: string;
  kind: OperationAuditKind;
  target: OperationAuditFields;
  inputHash: string;
  baseRevisions?: OperationAuditFields;
  actor: string;
  entrypoint: string;
}

export interface OperationAdmission {
  operationId: string;
  replay: {
    status: OperationAuditTerminalStatus;
    errorCode: string | null;
    result: OperationAuditFields | null;
  } | null;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FIELD_KEYS = 32;
const MAX_FIELD_STRING_BYTES = 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|secret|token|credential|api[_-]?key|authorization|auth|cookie|session|env)/i;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function operationInputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function generatedOperationId(): string {
  return `op_${randomUUID()}`;
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new VideocutError(
      "invalid_operation_id",
      "operationId must be 1-128 characters of letters, digits, _, ., :, or -",
      { operationIdLength: operationId.length },
    );
  }
}

function assertSafeFields(name: string, fields: OperationAuditFields): void {
  const entries = Object.entries(fields);
  if (entries.length > MAX_FIELD_KEYS) {
    throw new VideocutError("operation_audit_record_too_large", `${name} has too many fields`);
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) {
      throw new VideocutError("operation_audit_invalid_field", `${name} contains an invalid field name`);
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new VideocutError("operation_audit_invalid_field", `${name} contains a sensitive field name`);
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new VideocutError("operation_audit_invalid_field", `${name}.${key} is not a bounded scalar`);
    }
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_FIELD_STRING_BYTES) {
      throw new VideocutError("operation_audit_record_too_large", `${name}.${key} is too large`);
    }
    if (typeof value === "string" && looksLikeAbsolutePath(value)) {
      throw new VideocutError("operation_audit_invalid_field", `${name}.${key} must not store an absolute path`);
    }
  }
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function assertSafeMetadataLabel(
  name: "actor" | "entrypoint",
  value: string,
  code: "operation_audit_invalid_field" | "operation_audit_corrupt",
): void {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(value) || looksLikeAbsolutePath(value)) {
    throw new VideocutError(code, `Operation audit ${name} must be a bounded stable label`);
  }
}

function assertRecord(record: OperationAuditRecord): void {
  assertOperationId(record.operationId);
  if (!["project.ingest", "cuts.set", "job.start.export"].includes(record.kind)) {
    throw new VideocutError("operation_audit_corrupt", "Operation audit record has an unknown kind");
  }
  if (!SHA256_PATTERN.test(record.inputHash)) {
    throw new VideocutError("operation_audit_corrupt", "Operation audit record has an invalid input hash");
  }
  assertSafeFields("target", record.target);
  assertSafeFields("baseRevisions", record.baseRevisions);
  if (record.result !== null) assertSafeFields("result", record.result);
  assertSafeMetadataLabel("actor", record.actor, "operation_audit_corrupt");
  assertSafeMetadataLabel("entrypoint", record.entrypoint, "operation_audit_corrupt");
  if (typeof record.committedPartial !== "boolean") {
    throw new VideocutError("operation_audit_corrupt", "Operation audit record has invalid partial state");
  }
  const terminalFlags =
    Number(record.rejected) +
    Number(record.succeeded) +
    Number(record.failed) +
    Number(record.committedPartial);
  if (terminalFlags > 1) {
    throw new VideocutError("operation_audit_corrupt", "Operation audit record has multiple terminal states");
  }
  if (record.rejected && record.accepted) {
    throw new VideocutError("operation_audit_corrupt", "Rejected operation cannot be accepted");
  }
  if ((record.succeeded || record.failed || record.committedPartial) && !record.accepted) {
    throw new VideocutError("operation_audit_corrupt", "Terminal execution requires accepted admission");
  }
  if ((record.failed || record.rejected || record.committedPartial) && !record.errorCode) {
    throw new VideocutError("operation_audit_corrupt", "Failed operation audit record has no error code");
  }
  if (record.committedPartial && record.result === null) {
    throw new VideocutError("operation_audit_corrupt", "Partial operation audit record has no committed result");
  }
  const bytes = Buffer.byteLength(JSON.stringify(record, null, 2) + "\n", "utf8");
  if (bytes > MAX_RECORD_BYTES) {
    throw new VideocutError("operation_audit_record_too_large", "Operation audit record exceeds 16 KiB");
  }
}

async function assertSecureJsonFile(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new VideocutError("operation_audit_corrupt", "Cannot inspect operation audit record");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new VideocutError("operation_audit_corrupt", "Operation audit record is not a single-link regular file");
  }
  if (metadata.size > MAX_RECORD_BYTES) {
    throw new VideocutError("operation_audit_record_too_large", "Operation audit record exceeds 16 KiB");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new VideocutError("operation_audit_corrupt", "Operation audit record permissions are too broad");
  }
}

async function ensureAuditDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new VideocutError("operation_audit_corrupt", "Cannot inspect operation audit directory");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new VideocutError("operation_audit_corrupt", "Operation audit directory must be symlink-free");
  }
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = resolve(path, "..");
  await ensureAuditDirectory(directory);
  try {
    await assertSecureJsonFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  let completed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await rm(temporaryPath, { force: true });
  }
  try {
    await rename(temporaryPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assertSecureJsonFile(path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const directory = resolve(path, "..");
  await ensureAuditDirectory(directory);
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  let completed = false;
  let linked = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await rm(temporaryPath, { force: true });
  }
  try {
    await link(temporaryPath, path);
    linked = true;
    await rm(temporaryPath, { force: true });
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assertSecureJsonFile(path);
    await syncDirectory(directory);
  } catch (error) {
    throw error;
  } finally {
    if (!linked) await rm(temporaryPath, { force: true });
  }
}

function recordName(operationId: string): string {
  return `${createHash("sha256").update(operationId).digest("hex")}.json`;
}

function isSameIdentity(left: OperationAuditRecord, right: OperationAdmissionInput): boolean {
  return left.kind === right.kind &&
    left.actor === right.actor &&
    left.entrypoint === right.entrypoint &&
    left.inputHash === right.inputHash &&
    canonicalJson(left.target) === canonicalJson(right.target);
}

function terminalStatus(record: OperationAuditRecord): OperationAuditTerminalStatus | null {
  if (record.succeeded) return "succeeded";
  if (record.failed) return "failed";
  if (record.rejected) return "rejected";
  if (record.committedPartial) return "committed_partial";
  return null;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "operation_failed";
}

export class OperationAuditStore {
  readonly auditDir: string;
  readonly recordsDir: string;
  readonly rejectionsDir: string;

  constructor(readonly dataDir: string) {
    this.auditDir = resolve(dataDir, "operation-audit");
    this.recordsDir = join(this.auditDir, "records");
    this.rejectionsDir = join(this.auditDir, "rejections");
  }

  private async ensureLayout(): Promise<void> {
    await ensureAuditDirectory(this.auditDir);
    await ensureAuditDirectory(this.recordsDir);
    await ensureAuditDirectory(this.rejectionsDir);
  }

  recordPath(operationId: string): string {
    assertOperationId(operationId);
    return join(this.recordsDir, recordName(operationId));
  }

  async read(operationId: string): Promise<OperationAuditRecord | null> {
    await this.ensureLayout();
    const path = this.recordPath(operationId);
    let raw: string;
    try {
      await assertSecureJsonFile(path);
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: OperationAuditRecord;
    try {
      value = JSON.parse(raw) as OperationAuditRecord;
    } catch {
      throw new VideocutError("operation_audit_corrupt", "Operation audit record is not valid JSON");
    }
    assertRecord(value);
    if (value.operationId !== operationId) {
      throw new VideocutError("operation_audit_corrupt", "Operation audit id does not match its index");
    }
    return value;
  }

  async admit(input: OperationAdmissionInput): Promise<OperationAdmission> {
    await this.ensureLayout();
    const operationId = input.operationId ?? generatedOperationId();
    assertOperationId(operationId);
    if (!SHA256_PATTERN.test(input.inputHash)) {
      throw new VideocutError("invalid_argument", "Operation inputHash must be a SHA-256 digest");
    }
    assertSafeFields("target", input.target);
    assertSafeFields("baseRevisions", input.baseRevisions ?? {});
    assertSafeMetadataLabel("actor", input.actor, "operation_audit_invalid_field");
    assertSafeMetadataLabel("entrypoint", input.entrypoint, "operation_audit_invalid_field");
    const now = new Date().toISOString();
    const record: OperationAuditRecord = {
      schemaVersion: OPERATION_AUDIT_SCHEMA_VERSION,
      operationId,
      kind: input.kind,
      target: input.target,
      inputHash: input.inputHash,
      baseRevisions: input.baseRevisions ?? {},
      actor: input.actor,
      entrypoint: input.entrypoint,
      startedAt: now,
      finishedAt: null,
      accepted: true,
      rejected: false,
      succeeded: false,
      failed: false,
      committedPartial: false,
      errorCode: null,
      result: null,
    };
    assertRecord(record);
    try {
      await writeJsonExclusive(this.recordPath(operationId), record);
      return { operationId, replay: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await this.read(operationId);
    if (!existing) {
      throw new VideocutError("operation_audit_corrupt", "Operation audit record disappeared");
    }
    if (!isSameIdentity(existing, input)) {
      await this.writeRejectedAttempt(input, operationId, "operation_id_conflict");
      throw new VideocutError(
        "operation_id_conflict",
        "operationId was already used for a different operation input",
        { operationId, kind: input.kind },
      );
    }
    const status = terminalStatus(existing);
    if (!status) {
      await this.writeRejectedAttempt(input, operationId, "operation_in_progress");
      throw new VideocutError(
        "operation_in_progress",
        "operationId is already admitted and has not reached a terminal result",
        { operationId, kind: input.kind },
      );
    }
    return {
      operationId,
      replay: {
        status,
        errorCode: existing.errorCode,
        result: existing.result,
      },
    };
  }

  async finishSucceeded(
    operationId: string,
    options: { result?: OperationAuditFields; baseRevisions?: OperationAuditFields } = {},
  ): Promise<OperationAuditRecord> {
    return this.finish(operationId, {
      succeeded: true,
      failed: false,
      errorCode: null,
      result: options.result ?? null,
      baseRevisions: options.baseRevisions,
    });
  }

  async finishFailed(
    operationId: string,
    error: unknown,
    options: { baseRevisions?: OperationAuditFields } = {},
  ): Promise<OperationAuditRecord> {
    return this.finish(operationId, {
      succeeded: false,
      failed: true,
      errorCode: errorCode(error),
      result: null,
      baseRevisions: options.baseRevisions,
    });
  }

  async finishCommittedPartial(
    operationId: string,
    error: unknown,
    options: { result: OperationAuditFields; baseRevisions?: OperationAuditFields },
  ): Promise<OperationAuditRecord> {
    return this.finish(operationId, {
      succeeded: false,
      failed: false,
      committedPartial: true,
      errorCode: errorCode(error),
      result: options.result,
      baseRevisions: options.baseRevisions,
    });
  }

  async recordRejected(input: OperationAdmissionInput, error: string): Promise<void> {
    await this.ensureLayout();
    await this.writeRejectedAttempt(input, input.operationId ?? generatedOperationId(), error);
  }

  private async finish(
    operationId: string,
    update: {
      succeeded: boolean;
      failed: boolean;
      committedPartial?: boolean;
      errorCode: string | null;
      result: OperationAuditFields | null;
      baseRevisions?: OperationAuditFields;
    },
  ): Promise<OperationAuditRecord> {
    const current = await this.read(operationId);
    if (!current) {
      throw new VideocutError("operation_audit_corrupt", "Cannot finish a missing operation audit record");
    }
    if (terminalStatus(current)) return current;
    if (update.result !== null) assertSafeFields("result", update.result);
    if (update.baseRevisions) assertSafeFields("baseRevisions", update.baseRevisions);
    const next: OperationAuditRecord = {
      ...current,
      baseRevisions: update.baseRevisions ?? current.baseRevisions,
      finishedAt: new Date().toISOString(),
      succeeded: update.succeeded,
      failed: update.failed,
      committedPartial: update.committedPartial ?? false,
      errorCode: update.errorCode,
      result: update.result,
    };
    assertRecord(next);
    await writeJsonAtomic(this.recordPath(operationId), next);
    return next;
  }

  private async writeRejectedAttempt(
    input: OperationAdmissionInput,
    operationId: string,
    error: string,
  ): Promise<void> {
    const rejected: OperationAuditRecord = {
      schemaVersion: OPERATION_AUDIT_SCHEMA_VERSION,
      operationId,
      kind: input.kind,
      target: input.target,
      inputHash: input.inputHash,
      baseRevisions: input.baseRevisions ?? {},
      actor: input.actor,
      entrypoint: input.entrypoint,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      accepted: false,
      rejected: true,
      succeeded: false,
      failed: false,
      committedPartial: false,
      errorCode: error,
      result: null,
    };
    assertRecord(rejected);
    const path = join(this.rejectionsDir, `${Date.now()}-${randomUUID()}.json`);
    await writeJsonExclusive(path, rejected);
  }
}
