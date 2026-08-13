import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  realpath,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VideocutError, ffmpegFileArg } from "@video-workbench/core";
import { serializeProjectOperation } from "@video-workbench/core/node";
import { probeMedia, type MediaProbe } from "./mediaCut";

const VOLCENGINE_SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const VOLCENGINE_QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const DEFAULT_RESOURCE_ID = "volc.seedasr.auc";
const DEFAULT_MODEL_NAME = "bigmodel";
const DEFAULT_LANGUAGE = "zh-CN";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 1_200;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION = 1;
const TRANSCRIPTION_CHECKPOINT_KIND = "volcengine-transcription-execution";
const TRANSCRIPTION_CHECKPOINT_DIRECTORY = ".chengfeng-videocut/transcription-checkpoints";

type JsonRecord = Record<string, unknown>;
type TranscriptionCheckpointPhase =
  | "submitting"
  | "submitting_uncertain"
  | "polling"
  | "completed"
  | "terminal_provider_failure"
  | "cancelled"
  | "recovery_blocked";

interface TranscriptionCheckpointIdentity {
  provider: "volcengine";
  source: string;
  output: string;
  mediaSha256: string;
  mediaDuration: number;
  audioFormat: string;
  language: string;
  modelName: string;
  resourceId: string;
}

interface TranscriptionCheckpointError {
  kind: string;
  stage?: "submit" | "query";
  httpStatus?: number;
  providerStatus?: string;
  causeType?: string;
  timeoutMs?: number;
  recoverable?: boolean;
}

interface TranscriptionCheckpoint {
  schemaVersion: typeof TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION;
  kind: typeof TRANSCRIPTION_CHECKPOINT_KIND;
  provider: "volcengine";
  requestId: string;
  identity: TranscriptionCheckpointIdentity;
  phase: TranscriptionCheckpointPhase;
  queryAttempts: number;
  createdAt: string;
  updatedAt: string;
  logid?: string;
  lastHttpStatus?: number;
  lastProviderStatus?: string;
  error: TranscriptionCheckpointError | null;
}

interface TranscriptionCheckpointEvent {
  event:
    | "after-initial-checkpoint"
    | "after-submit-accepted-before-logid-checkpoint"
    | "after-logid-checkpoint"
    | "after-query-pending-checkpoint"
    | "after-provider-completed-before-output"
    | "after-completed-checkpoint";
  path: string;
  checkpoint: TranscriptionCheckpoint;
}

interface TranscriptionCheckpointHandle {
  path: string;
  record: TranscriptionCheckpoint;
  created: boolean;
}

type ProviderRequestFailureKind = "request_timeout" | "external_cancel" | "network_error";

export interface VolcengineTimedWord {
  text: string;
  start: number;
  end: number;
  /**
   * The punctuation that follows this word, when transcription supplied any.
   *
   * Kept out of `text` on purpose. The dictionary matches whole words, and
   * `transcript correct` compares word-for-word — a 「站」 that had silently
   * become 「站。」 would stop matching either. This is a separate answer to a
   * separate question: not what was said, but where the sentence ended.
   */
  punctuation?: string;
}

/**
 * Which media this transcript was produced from.
 *
 * Word timings are only meaningful against one specific file. Without this the
 * product happily accepted a transcript belonging to a different video — or the
 * post-cut transcript re-attached to the original source — and every later
 * deletion then cut at the wrong timecode with nothing reporting an error.
 * The video already gets a sha gate at project level; the transcript had none.
 */
export interface TranscriptMediaBinding {
  /** Path as given at transcribe time, kept for humans; never trusted alone. */
  source: string;
  /** SHA-256 of the media bytes. This is what the gate compares. */
  sha256: string;
  /** Probed duration in seconds; catches a transcript shorter than its media. */
  duration: number;
}

export interface VolcengineTranscriptDocument {
  schemaVersion: 1;
  provider: "volcengine";
  language: string;
  /** Absent on transcripts written before this field existed. */
  media?: TranscriptMediaBinding;
  cues: Array<{
    id: string;
    words: Array<{
      id: string;
      text: string;
      start: number;
      end: number;
      isGap?: boolean;
      /** Punctuation following this word. Absent on transcripts written before this existed. */
      punctuation?: string;
    }>;
  }>;
}

export interface TranscribeKouboVideoOptions {
  video: string;
  output: string;
  language?: string;
  apiKey?: string;
  resourceId?: string;
  modelName?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  dependencies?: Partial<TranscriptionDependencies>;
}

export interface TranscribeKouboVideoResult {
  provider: "volcengine";
  source: string;
  output: string;
  cueCount: number;
  wordCount: number;
  duration: number;
}

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

interface TranscriptionDependencies {
  // 返回实际用上的 ASR 格式（mp3/wav）；注入的 mock 返回 void 时按 mp3 处理。
  extractAudio: (input: string, output: string) => Promise<string | void>;
  fetch: (input: string, init: RequestInit) => Promise<FetchLikeResponse>;
  probe: (input: string) => Promise<MediaProbe>;
  sleep: (milliseconds: number) => Promise<void>;
  uuid: () => string;
  checkpointEvent: (event: TranscriptionCheckpointEvent) => Promise<void> | void;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertInside(root: string, candidate: string, label: string): void {
  const value = relative(root, candidate);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new VideocutError(
      "invalid_argument",
      `${label} must stay inside the task directory`,
      { root, candidate },
    );
  }
}

function taskRelativePath(root: string, value: string, label: string): string {
  if (!value.trim() || isAbsolute(value)) {
    throw new VideocutError(
      "invalid_argument",
      `${label} must be a non-empty task-relative path`,
      { value },
    );
  }
  const candidate = resolve(root, value);
  assertInside(root, candidate, label);
  return candidate;
}

async function existingTaskFile(root: string, value: string, label: string): Promise<string> {
  const candidate = taskRelativePath(root, value, label);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw new VideocutError(
      "invalid_argument",
      `${label} must reference an existing regular file`,
      { value, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  assertInside(root, resolved, label);
  return resolved;
}

async function assertNewTaskOutput(root: string, value: string): Promise<string> {
  const output = taskRelativePath(root, value, "--output");
  try {
    await lstat(output);
    throw new VideocutError(
      "invalid_argument",
      "transcribe refuses to overwrite an existing --output file",
      { output },
    );
  } catch (error) {
    if (error instanceof VideocutError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return output;
}

/**
 * 送去云端 ASR 的音频档位。**永远显式写 `-f`**：ffmpeg 从文件名推断输出格式
 * 的行为跨版本/跨构建并不一致（2026-08-04 一位 Windows 用户实测：路径合法、
 * 扩展名也在，仍报 "Unable to choose an output format"），显式指定就没有
 * 推断这一步。编码器按可用性回退——libmp3lame 是外部库，精简构建里可能没有；
 * wav/pcm_s16le 内置于任何 ffmpeg，只是文件大。档位只能挑火山 ASR 收的格式
 * （mp3 / wav / ogg / raw），format 字段会原样写进 ASR 请求。
 */
export interface AudioProfile {
  /** 原样写进 ASR 请求 audio.format 的值，必须是火山收的格式。 */
  format: string;
  codec: string;
  extraArgs: readonly string[];
}

const AUDIO_PROFILES: readonly AudioProfile[] = [
  { format: "mp3", codec: "libmp3lame", extraArgs: [] },
  // wav 档重采样到 16k/单声道，与 ASR 请求里声明的 rate/bits/channel 保持一致。
  { format: "wav", codec: "pcm_s16le", extraArgs: ["-ar", "16000", "-ac", "1"] },
];

function runFfmpegOnce(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stderr }));
  });
}

/** 该错误说明这台机器的 ffmpeg 缺这个档位的容器或编码器，换下一档还有救。 */
function looksLikeUnsupportedProfile(stderr: string): boolean {
  return /Unknown encoder|Unable to choose an output format|Requested output format .* is not|Unknown output format|Encoder .* not found/i
    .test(stderr);
}

async function runFfmpeg(input: string, output: string): Promise<string> {
  const failures: string[] = [];
  for (const profile of AUDIO_PROFILES) {
    const result = await runFfmpegOnce([
      "-y", "-v", "error", "-i", ffmpegFileArg(input),
      "-vn", "-acodec", profile.codec, ...profile.extraArgs,
      "-f", profile.format, ffmpegFileArg(output),
    ]);
    if (result.code === 0) return profile.format;
    failures.push(`${profile.format}/${profile.codec}: ${result.stderr.trim().slice(-400)}`);
    if (!looksLikeUnsupportedProfile(result.stderr)) break;
  }
  throw new Error(
    `ffmpeg audio extraction failed. 这台机器的 ffmpeg 没有可用的音频档位；` +
    `请确认 ffmpeg 完整安装（Windows: winget install Gyan.FFmpeg；macOS: brew install ffmpeg），` +
    `或用 ffmpeg -muxers / -encoders 检查。逐档报错：\n${failures.join("\n")}`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function defaultDependencies(): TranscriptionDependencies {
  return {
    extractAudio: runFfmpeg,
    fetch: (input, init) => fetch(input, init),
    probe: probeMedia,
    sleep: delay,
    uuid: randomUUID,
    checkpointEvent: () => undefined,
  };
}

function providerError(message: string, details: Record<string, unknown> = {}): VideocutError {
  return new VideocutError("cloud_transcription_failed", message, details);
}

function responseStatus(response: FetchLikeResponse): string | null {
  return response.headers.get("x-api-status-code") ?? response.headers.get("X-Api-Status-Code");
}

function responseLogid(response: FetchLikeResponse): string | null {
  return response.headers.get("x-tt-logid") ?? response.headers.get("X-Tt-Logid");
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeToken(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 256 || /[\0\r\n]/.test(text)) {
    throw new VideocutError("cloud_transcription_checkpoint_corrupt", "Transcription checkpoint contains an unsafe token", {
      reason: "unsafe_token",
      label,
    });
  }
  return text;
}

function relativeTaskPath(root: string, path: string): string {
  assertInside(root, path, "checkpoint path");
  return relative(root, path).split(sep).join("/");
}

function assertTaskRelativeIdentityPath(value: unknown, path: string, label: string): string {
  const text = typeof value === "string" ? value : "";
  if (
    !text ||
    isAbsolute(text) ||
    text === "." ||
    text === ".." ||
    text.startsWith("../") ||
    text.includes("/../") ||
    text.includes("\0")
  ) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint identity path is unsafe",
      { path, label },
    );
  }
  return text;
}

function assertPositiveNumber(value: unknown, path: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint identity number is invalid",
      { path, label },
    );
  }
  return number;
}

function assertCheckpointIdentity(value: unknown, path: string): TranscriptionCheckpointIdentity {
  if (!isRecord(value) || value.provider !== "volcengine") {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint identity is invalid",
      { path },
    );
  }
  const mediaSha256 = typeof value.mediaSha256 === "string" ? value.mediaSha256 : "";
  if (!/^[a-f0-9]{64}$/.test(mediaSha256)) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint media identity is invalid",
      { path },
    );
  }
  return {
    provider: "volcengine",
    source: assertTaskRelativeIdentityPath(value.source, path, "source"),
    output: assertTaskRelativeIdentityPath(value.output, path, "output"),
    mediaSha256,
    mediaDuration: assertPositiveNumber(value.mediaDuration, path, "mediaDuration"),
    audioFormat: safeToken(value.audioFormat, "audioFormat"),
    language: safeToken(value.language, "language"),
    modelName: safeToken(value.modelName, "modelName"),
    resourceId: safeToken(value.resourceId, "resourceId"),
  };
}

function assertCheckpointError(value: unknown, path: string): TranscriptionCheckpointError | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint error is invalid",
      { path },
    );
  }
  return {
    kind: safeToken(value.kind, "error.kind"),
    ...(value.stage === "submit" || value.stage === "query" ? { stage: value.stage } : {}),
    ...(typeof value.httpStatus === "number" ? { httpStatus: value.httpStatus } : {}),
    ...(typeof value.providerStatus === "string" ? { providerStatus: safeToken(value.providerStatus, "error.providerStatus") } : {}),
    ...(typeof value.causeType === "string" ? { causeType: safeToken(value.causeType, "error.causeType") } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
    ...(typeof value.recoverable === "boolean" ? { recoverable: value.recoverable } : {}),
  };
}

function assertTranscriptionCheckpoint(value: unknown, path: string): TranscriptionCheckpoint {
  if (
    !isRecord(value) ||
    value.schemaVersion !== TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION ||
    value.kind !== TRANSCRIPTION_CHECKPOINT_KIND ||
    value.provider !== "volcengine"
  ) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint has an unsupported schema",
      { path },
    );
  }
  const phase = String(value.phase);
  if (![
    "submitting",
    "submitting_uncertain",
    "polling",
    "completed",
    "terminal_provider_failure",
    "cancelled",
    "recovery_blocked",
  ].includes(phase)) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint phase is invalid",
      { path },
    );
  }
  const queryAttempts = Number(value.queryAttempts);
  if (
    !Number.isInteger(queryAttempts) ||
    queryAttempts < 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint counters are invalid",
      { path },
    );
  }
  return {
    schemaVersion: TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION,
    kind: TRANSCRIPTION_CHECKPOINT_KIND,
    provider: "volcengine",
    requestId: safeToken(value.requestId, "requestId"),
    identity: assertCheckpointIdentity(value.identity, path),
    phase: phase as TranscriptionCheckpointPhase,
    queryAttempts,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.logid === "string" ? { logid: safeToken(value.logid, "logid") } : {}),
    ...(typeof value.lastHttpStatus === "number" ? { lastHttpStatus: value.lastHttpStatus } : {}),
    ...(typeof value.lastProviderStatus === "string" ? { lastProviderStatus: safeToken(value.lastProviderStatus, "lastProviderStatus") } : {}),
    error: assertCheckpointError(value.error, path),
  };
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await openFile(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function ensurePrivateDirectoryInside(root: string, directory: string): Promise<void> {
  assertInside(root, directory, "checkpoint directory");
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new VideocutError(
        "cloud_transcription_checkpoint_corrupt",
        "Transcription checkpoint path is not a real directory",
        { path: current },
      );
    }
    if (process.platform !== "win32") {
      await chmod(current, 0o700);
    }
  }
}

async function ensureCheckpointFileSafe(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint is not a private regular file",
      { path },
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint permissions are too broad",
      { path },
    );
  }
}

async function readTranscriptionCheckpoint(path: string): Promise<TranscriptionCheckpoint | null> {
  try {
    await ensureCheckpointFileSafe(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new VideocutError(
      "cloud_transcription_checkpoint_corrupt",
      "Transcription checkpoint is not valid JSON",
      { path },
    );
  }
  return assertTranscriptionCheckpoint(parsed, path);
}

async function writeTranscriptionCheckpoint(path: string, checkpoint: TranscriptionCheckpoint): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await openFile(temporary, "wx", 0o600);
  try {
    await handle.writeFile(jsonContent(checkpoint), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
    await syncDirectory(directory);
    await ensureCheckpointFileSafe(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function checkpointPathForOutput(root: string, output: string): string {
  const outputKey = relativeTaskPath(root, output);
  const digest = sha256String(JSON.stringify({ provider: "volcengine", output: outputKey })).slice(0, 32);
  return join(root, TRANSCRIPTION_CHECKPOINT_DIRECTORY, `volcengine-${digest}.json`);
}

function identityMismatch(
  expected: TranscriptionCheckpointIdentity,
  actual: TranscriptionCheckpointIdentity,
): string | null {
  const keys = [
    "provider",
    "source",
    "output",
    "mediaSha256",
    "mediaDuration",
    "audioFormat",
    "language",
    "modelName",
    "resourceId",
  ] as const;
  for (const key of keys) {
    if (expected[key] !== actual[key]) return key;
  }
  return null;
}

function assertReusableCheckpoint(
  checkpoint: TranscriptionCheckpoint,
  identity: TranscriptionCheckpointIdentity,
  path: string,
): void {
  const mismatch = identityMismatch(identity, checkpoint.identity);
  if (mismatch) {
    throw new VideocutError(
      "cloud_transcription_checkpoint_mismatch",
      "Transcription checkpoint belongs to different media or ASR configuration",
      {
        path,
        reason: "checkpoint_identity_mismatch",
        field: mismatch,
        checkpointPhase: checkpoint.phase,
      },
    );
  }
}

function terminalCheckpointError(checkpoint: TranscriptionCheckpoint, path: string): VideocutError | null {
  if (checkpoint.phase === "terminal_provider_failure") {
    return providerError("Volcengine transcription checkpoint already contains a terminal provider failure", {
      checkpointPhase: checkpoint.phase,
      path,
      ...(checkpoint.error ? { checkpointError: checkpoint.error } : {}),
    });
  }
  if (checkpoint.phase === "cancelled") {
    return new VideocutError(
      "cloud_transcription_cancelled",
      "Volcengine transcription checkpoint is cancelled",
      { checkpointPhase: checkpoint.phase, path },
    );
  }
  if (checkpoint.phase === "recovery_blocked") {
    return providerError("Volcengine transcription checkpoint requires manual recovery", {
      checkpointPhase: checkpoint.phase,
      path,
      ...(checkpoint.error ? { checkpointError: checkpoint.error } : {}),
    });
  }
  return null;
}

async function prepareTranscriptionCheckpoint(
  root: string,
  identity: TranscriptionCheckpointIdentity,
  dependencies: TranscriptionDependencies,
): Promise<TranscriptionCheckpointHandle> {
  const directory = join(root, TRANSCRIPTION_CHECKPOINT_DIRECTORY);
  await ensurePrivateDirectoryInside(root, directory);
  const path = checkpointPathForOutput(root, resolve(root, identity.output));
  return serializeProjectOperation(directory, async () => {
    const existing = await readTranscriptionCheckpoint(path);
    if (existing) {
      assertReusableCheckpoint(existing, identity, path);
      return { path, record: existing, created: false };
    }
    const now = new Date().toISOString();
    const checkpoint: TranscriptionCheckpoint = {
      schemaVersion: TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION,
      kind: TRANSCRIPTION_CHECKPOINT_KIND,
      provider: "volcengine",
      requestId: dependencies.uuid(),
      identity,
      phase: "submitting",
      queryAttempts: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    await writeTranscriptionCheckpoint(path, checkpoint);
    await dependencies.checkpointEvent({ event: "after-initial-checkpoint", path, checkpoint });
    return { path, record: checkpoint, created: true };
  });
}

async function updateTranscriptionCheckpoint(
  handle: TranscriptionCheckpointHandle,
  dependencies: TranscriptionDependencies,
  patch: Partial<Pick<TranscriptionCheckpoint,
    "phase" | "queryAttempts" | "logid" | "lastHttpStatus" | "lastProviderStatus" | "error">>,
  event?: TranscriptionCheckpointEvent["event"],
): Promise<TranscriptionCheckpoint> {
  const directory = dirname(handle.path);
  const next = await serializeProjectOperation(directory, async () => {
    const current = await readTranscriptionCheckpoint(handle.path);
    if (!current || current.requestId !== handle.record.requestId) {
      throw new VideocutError(
        "cloud_transcription_checkpoint_corrupt",
        "Transcription checkpoint identity changed during execution",
        { path: handle.path },
      );
    }
    const now = new Date().toISOString();
    const checkpoint: TranscriptionCheckpoint = {
      ...current,
      ...patch,
      identity: current.identity,
      requestId: current.requestId,
      createdAt: current.createdAt,
      updatedAt: now,
      logid: patch.logid ?? current.logid,
      error: patch.error !== undefined ? patch.error : current.error,
    };
    await writeTranscriptionCheckpoint(handle.path, checkpoint);
    if (event) await dependencies.checkpointEvent({ event, path: handle.path, checkpoint });
    return checkpoint;
  });
  handle.record = next;
  return next;
}

function checkpointDetails(handle: TranscriptionCheckpointHandle | undefined): Record<string, unknown> {
  if (!handle) return {};
  return {
    requestId: handle.record.requestId,
    checkpointPhase: handle.record.phase,
    ...(handle.record.logid ? { logid: handle.record.logid } : {}),
  };
}

class ProviderRequestFailure extends Error {
  constructor(
    readonly kind: ProviderRequestFailureKind,
    readonly stage: "submit" | "query",
    readonly details: TranscriptionCheckpointError,
  ) {
    super(`Volcengine ${stage} request ${kind}`);
    this.name = "ProviderRequestFailure";
  }
}

function causeType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function timeoutSignal(milliseconds: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(milliseconds);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  }, milliseconds);
  timer.unref?.();
  return controller.signal;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const active = signals.filter(Boolean);
  if (active.length === 1) return active[0] as AbortSignal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    }, { once: true });
  }
  return controller.signal;
}

function classifyProviderRequestFailure(
  error: unknown,
  stage: "submit" | "query",
  timeout: AbortSignal,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): ProviderRequestFailure {
  if (timeout.aborted && error === timeout.reason) {
    return new ProviderRequestFailure("request_timeout", stage, {
      kind: "request_timeout",
      stage,
      causeType: causeType(error),
      timeoutMs,
      recoverable: true,
    });
  }
  if (externalSignal?.aborted && error === externalSignal.reason) {
    return new ProviderRequestFailure("external_cancel", stage, {
      kind: "external_cancel",
      stage,
      causeType: causeType(error),
      recoverable: false,
    });
  }
  return new ProviderRequestFailure("network_error", stage, {
    kind: "network_error",
    stage,
    causeType: causeType(error),
    recoverable: stage === "query",
  });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new VideocutError("invalid_argument", `${name} must be a positive integer`, { [name]: value });
  }
  return normalized;
}

function nonNegativeFinite(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new VideocutError("invalid_argument", `${name} must be a non-negative number`, { [name]: value });
  }
  return normalized;
}

async function sleepWithCancellation(
  dependencies: TranscriptionDependencies,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) return;
  if (!signal) {
    await dependencies.sleep(milliseconds);
    return;
  }
  if (signal.aborted) throw new ProviderRequestFailure("external_cancel", "query", {
    kind: "external_cancel",
    stage: "query",
    causeType: causeType(signal.reason),
    recoverable: false,
  });
  await Promise.race([
    dependencies.sleep(milliseconds),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new ProviderRequestFailure("external_cancel", "query", {
          kind: "external_cancel",
          stage: "query",
          causeType: causeType(signal.reason),
          recoverable: false,
        }));
      }, { once: true });
    }),
  ]);
}

async function parseProviderResponse(
  response: FetchLikeResponse,
  stage: "submit" | "query",
): Promise<unknown> {
  if (!response.ok) {
    throw providerError(`Volcengine ${stage} failed with HTTP ${response.status}`, {
      stage,
      httpStatus: response.status,
      providerStatus: responseStatus(response),
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw providerError(`Volcengine ${stage} returned invalid JSON`, { stage, httpStatus: response.status });
  }
  return payload;
}

async function requestProvider(
  dependencies: TranscriptionDependencies,
  stage: "submit" | "query",
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<FetchLikeResponse> {
  const timeout = timeoutSignal(timeoutMs);
  const signal = combineSignals(externalSignal ? [timeout, externalSignal] : [timeout]);
  try {
    return await dependencies.fetch(url, { ...init, signal });
  } catch (error) {
    throw classifyProviderRequestFailure(error, stage, timeout, externalSignal, timeoutMs);
  }
}

/** Marks that end or divide a sentence in Chinese and in English. */
const PUNCTUATION = /[。！？，、；：,.!?;:]/u;

/**
 * Attach each utterance's punctuation to the word it follows.
 *
 * Transcription returns the same utterance twice over: `words[]` carries the
 * timings and nothing else, `text` carries the punctuation and no timings. The
 * product only ever read the first, so every comma and full stop the provider
 * supplied was discarded at the moment it arrived — and then subtitle screens
 * had to be split by pause and evenness alone, which breaks lines inside words
 * because nothing else is left to go on.
 *
 * The two views are walked together. Where they stop agreeing — inverse text
 * normalisation rewrites numbers in `text` but not always in `words[]` — this
 * gives up on that utterance rather than sliding the punctuation onto whatever
 * word happens to line up. A missing full stop costs a worse line break; a
 * misplaced one would put a sentence end in the middle of a sentence.
 */
function attachPunctuation(text: string, words: VolcengineTimedWord[]): number {
  let cursor = 0;
  let attached = 0;
  for (const word of words) {
    while (cursor < text.length && /\s/u.test(text[cursor] as string)) cursor += 1;
    if (!text.startsWith(word.text, cursor)) return attached;
    cursor += word.text.length;
    let marks = "";
    while (cursor < text.length) {
      const character = text[cursor] as string;
      if (/\s/u.test(character)) { cursor += 1; continue; }
      if (!PUNCTUATION.test(character)) break;
      marks += character;
      cursor += 1;
    }
    if (marks) {
      word.punctuation = marks;
      attached += 1;
    }
  }
  return attached;
}

function timedWords(payload: unknown): VolcengineTimedWord[] {
  const root = isRecord(payload) ? payload : {};
  const result = isRecord(root.result) ? root.result : root;
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const words: VolcengineTimedWord[] = [];
  for (const utterance of utterances) {
    if (!isRecord(utterance) || !Array.isArray(utterance.words)) continue;
    const mine: VolcengineTimedWord[] = [];
    for (const item of utterance.words) {
      if (!isRecord(item)) continue;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const start = Number(item.start_time);
      const end = Number(item.end_time);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        continue;
      }
      mine.push({ text, start: start / 1_000, end: end / 1_000 });
    }
    // `enable_punc` is requested, so this is normally present; a provider that
    // stops sending it degrades to what this function did before.
    if (typeof utterance.text === "string" && utterance.text.trim()) {
      attachPunctuation(utterance.text, mine);
    }
    words.push(...mine);
  }
  return words;
}

function stableWordId(kind: "word" | "gap", position: number, text: string, start: number, end: number): string {
  const digest = createHash("sha256")
    .update(`${kind}\u0000${position}\u0000${text}\u0000${start.toFixed(3)}\u0000${end.toFixed(3)}`)
    .digest("hex")
    .slice(0, 20);
  return `${kind}-${digest}`;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export function buildVolcengineTranscript(input: {
  result: unknown;
  language: string;
  duration: number;
  media?: TranscriptMediaBinding;
}): VolcengineTranscriptDocument {
  const sourceWords = timedWords(input.result);
  if (sourceWords.length === 0) {
    throw providerError("Volcengine completed without timed words", { reason: "missing_timed_words" });
  }
  const words: VolcengineTranscriptDocument["cues"][number]["words"] = [];
  let lastEnd = 0;
  let sequence = 0;
  const addGap = (start: number, end: number): void => {
    if (end - start <= 0.1) return;
    let cursor = start;
    while (cursor < end - 0.0005) {
      const next = Math.min(cursor + 1, end);
      const gapStart = rounded(cursor);
      const gapEnd = rounded(next);
      if (gapEnd > gapStart) {
        words.push({
          id: stableWordId("gap", sequence, "", gapStart, gapEnd),
          text: "",
          start: gapStart,
          end: gapEnd,
          isGap: true,
        });
        sequence += 1;
      }
      cursor = next;
    }
  };
  for (const word of sourceWords) {
    addGap(lastEnd, word.start);
    const start = rounded(word.start);
    const end = rounded(word.end);
    if (end <= start) continue;
    words.push({
      id: stableWordId("word", sequence, word.text, start, end),
      text: word.text,
      start,
      end,
      ...(word.punctuation ? { punctuation: word.punctuation } : {}),
    });
    sequence += 1;
    lastEnd = Math.max(lastEnd, word.end);
  }
  addGap(lastEnd, input.duration);
  if (!words.some((word) => !word.isGap)) {
    throw providerError("Volcengine completed without usable words", { reason: "missing_usable_words" });
  }
  return {
    schemaVersion: 1,
    provider: "volcengine",
    language: input.language,
    ...(input.media ? { media: input.media } : {}),
    cues: [{ id: "volcengine-source", words }],
  };
}

async function submitAndPoll(input: {
  audio: string;
  audioFormat?: string;
  apiKey: string;
  resourceId: string;
  modelName: string;
  language: string;
  pollIntervalMs: number;
  maxPollAttempts: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  dependencies: TranscriptionDependencies;
  checkpoint?: TranscriptionCheckpointHandle;
}): Promise<unknown> {
  const audioData = await readFile(input.audio);
  const requestId = input.checkpoint?.record.requestId ?? input.dependencies.uuid();
  const providerHeaders = (logid?: string) => ({
    "Content-Type": "application/json",
    "X-Api-Key": input.apiKey,
    "X-Api-Resource-Id": input.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
    ...(logid ? { "X-Tt-Logid": logid } : {}),
  });

  const checkpoint = input.checkpoint;
  if (checkpoint) {
    const terminal = terminalCheckpointError(checkpoint.record, checkpoint.path);
    if (terminal) throw terminal;
  }

  let logid = checkpoint?.record.logid;
  if (!checkpoint || checkpoint.created) {
    let submit: FetchLikeResponse;
    try {
      submit = await requestProvider(input.dependencies, "submit", VOLCENGINE_SUBMIT_URL, {
        method: "POST",
        headers: providerHeaders(logid),
        body: JSON.stringify({
          user: { uid: "chengfeng-videocut" },
          audio: {
            data: audioData.toString("base64"),
            format: input.audioFormat ?? "mp3",
            codec: "raw",
            rate: 16_000,
            bits: 16,
            channel: 1,
            language: input.language,
          },
          request: {
            model_name: input.modelName,
            enable_itn: true,
            enable_punc: true,
            show_utterances: true,
          },
        }),
      }, input.requestTimeoutMs, input.signal);
    } catch (error) {
      if (error instanceof ProviderRequestFailure) {
        if (checkpoint) {
          if (error.kind === "request_timeout") {
            await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
              phase: "submitting_uncertain",
              error: error.details,
            });
          } else if (error.kind === "external_cancel") {
            await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
              phase: "cancelled",
              error: error.details,
            });
          } else {
            await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
              phase: "recovery_blocked",
              error: error.details,
            });
          }
        }
        if (error.kind === "external_cancel") {
          throw new VideocutError("cloud_transcription_cancelled", "Volcengine transcription was cancelled", {
            ...error.details,
            ...checkpointDetails(checkpoint),
          });
        }
        throw providerError(
          error.kind === "request_timeout"
            ? "Volcengine submit result is uncertain after request timeout"
            : "Volcengine submit request failed",
          { ...error.details, ...checkpointDetails(checkpoint) },
        );
      }
      throw error;
    }

    const submitStatus = responseStatus(submit);
    const submitLogid = responseLogid(submit) ?? undefined;
    if (!submit.ok || submitStatus !== "20000000") {
      const details = {
        kind: !submit.ok ? "http_error" : "provider_rejected",
        stage: "submit" as const,
        httpStatus: submit.status,
        ...(submitStatus ? { providerStatus: submitStatus } : {}),
        recoverable: false,
      };
      if (checkpoint) {
        await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
          phase: "terminal_provider_failure",
          lastHttpStatus: submit.status,
          ...(submitStatus ? { lastProviderStatus: submitStatus } : {}),
          error: details,
        });
      }
      throw providerError(
        !submit.ok
          ? `Volcengine submit failed with HTTP ${submit.status}`
          : "Volcengine rejected the transcription request",
        { ...details, ...checkpointDetails(checkpoint) },
      );
    }

    if (checkpoint) {
      await input.dependencies.checkpointEvent({
        event: "after-submit-accepted-before-logid-checkpoint",
        path: checkpoint.path,
        checkpoint: checkpoint.record,
      });
      const updated = await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
        phase: "polling",
        ...(submitLogid ? { logid: submitLogid } : {}),
        lastHttpStatus: submit.status,
        lastProviderStatus: submitStatus,
        error: null,
      }, "after-logid-checkpoint");
      logid = updated.logid;
    } else {
      logid = submitLogid;
    }
  } else if (checkpoint.record.phase !== "polling") {
    const updated = await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
      phase: "polling",
      error: null,
    });
    logid = updated.logid;
  }

  for (let attempt = 1; attempt <= input.maxPollAttempts; attempt += 1) {
    try {
      await sleepWithCancellation(input.dependencies, input.pollIntervalMs, input.signal);
    } catch (error) {
      if (error instanceof ProviderRequestFailure && checkpoint) {
        await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
          phase: "cancelled",
          error: error.details,
        });
      }
      if (error instanceof ProviderRequestFailure) {
        throw new VideocutError("cloud_transcription_cancelled", "Volcengine transcription was cancelled", {
          ...error.details,
          ...checkpointDetails(checkpoint),
        });
      }
      throw error;
    }

    let query: FetchLikeResponse;
    try {
      query = await requestProvider(input.dependencies, "query", VOLCENGINE_QUERY_URL, {
        method: "POST",
        headers: providerHeaders(logid),
        body: "{}",
      }, input.requestTimeoutMs, input.signal);
    } catch (error) {
      if (error instanceof ProviderRequestFailure) {
        if (checkpoint) {
          await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
            phase: error.kind === "external_cancel" ? "cancelled" : "polling",
            queryAttempts: attempt,
            error: error.details,
          });
        }
        if (error.kind === "external_cancel") {
          throw new VideocutError("cloud_transcription_cancelled", "Volcengine transcription was cancelled", {
            ...error.details,
            ...checkpointDetails(checkpoint),
          });
        }
        throw providerError("Volcengine query request failed", {
          ...error.details,
          attempt,
          ...checkpointDetails(checkpoint),
        });
      }
      throw error;
    }

    const status = responseStatus(query);
    logid = responseLogid(query) ?? logid;
    if (!query.ok || !status || (status !== "20000000" && status !== "20000001" && status !== "20000002")) {
      const details = {
        kind: !query.ok ? "http_error" : !status ? "missing_provider_status" : "terminal_provider_status",
        stage: "query" as const,
        httpStatus: query.status,
        ...(status ? { providerStatus: status } : {}),
        recoverable: false,
      };
      if (checkpoint) {
        await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
          phase: "terminal_provider_failure",
          queryAttempts: attempt,
          ...(logid ? { logid } : {}),
          lastHttpStatus: query.status,
          ...(status ? { lastProviderStatus: status } : {}),
          error: details,
        });
      }
      throw providerError("Volcengine query failed", {
        attempt,
        ...details,
        ...checkpointDetails(checkpoint),
      });
    }

    if (status === "20000001" || status === "20000002") {
      if (checkpoint) {
        await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
          phase: "polling",
          queryAttempts: attempt,
          ...(logid ? { logid } : {}),
          lastHttpStatus: query.status,
          lastProviderStatus: status,
          error: null,
        }, "after-query-pending-checkpoint");
      }
      continue;
    }

    let payload: unknown;
    try {
      payload = await parseProviderResponse(query, "query");
    } catch (error) {
      const details = {
        kind: "invalid_json",
        stage: "query" as const,
        httpStatus: query.status,
        providerStatus: status,
        recoverable: false,
      };
      if (checkpoint) {
        await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
          phase: "terminal_provider_failure",
          queryAttempts: attempt,
          ...(logid ? { logid } : {}),
          lastHttpStatus: query.status,
          lastProviderStatus: status,
          error: details,
        });
      }
      if (error instanceof VideocutError) {
        throw providerError(error.message, { ...details, ...checkpointDetails(checkpoint) });
      }
      throw error;
    }
    const words = timedWords(payload);
    if (words.length > 0) {
      if (checkpoint) {
        await input.dependencies.checkpointEvent({
          event: "after-provider-completed-before-output",
          path: checkpoint.path,
          checkpoint: checkpoint.record,
        });
      }
      return payload;
    }
    const details = {
      kind: "missing_timed_words",
      stage: "query" as const,
      httpStatus: query.status,
      providerStatus: status,
      recoverable: false,
    };
    if (checkpoint) {
      await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
        phase: "terminal_provider_failure",
        queryAttempts: attempt,
        ...(logid ? { logid } : {}),
        lastHttpStatus: query.status,
        lastProviderStatus: status,
        error: details,
      });
    }
    throw providerError("Volcengine completed without timed words", {
      stage: "query",
      providerStatus: status,
      ...checkpointDetails(checkpoint),
    });
  }

  const details = {
    kind: "poll_budget_exhausted",
    stage: "query" as const,
    recoverable: false,
  };
  if (checkpoint) {
    await updateTranscriptionCheckpoint(checkpoint, input.dependencies, {
      phase: "recovery_blocked",
      error: details,
    });
  }
  throw providerError("Volcengine transcription timed out", {
    maxPollAttempts: input.maxPollAttempts,
    ...details,
    ...checkpointDetails(checkpoint),
  });
}

async function completeTranscriptionCheckpoint(
  checkpoint: TranscriptionCheckpointHandle,
  dependencies: TranscriptionDependencies,
): Promise<void> {
  await updateTranscriptionCheckpoint(checkpoint, dependencies, {
    phase: "completed",
    error: null,
  }, "after-completed-checkpoint");
}

async function writeTranscriptAtomically(
  root: string,
  output: string,
  document: VolcengineTranscriptDocument,
): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  assertInside(root, parent, "--output");
  const temporaryDirectory = await mkdtemp(join(parent, ".videocut-transcript-"));
  const temporaryOutput = join(temporaryDirectory, basename(output));
  try {
    await writeFile(temporaryOutput, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    try {
      await link(temporaryOutput, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new VideocutError(
          "invalid_argument",
          "transcribe refuses to overwrite an existing --output file",
          { output },
        );
      }
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Concatenate just the kept ranges' audio into one continuous track.
 *
 * Everything downstream — subtitles above all — needs word times on the *cut*
 * timeline, and the only honest way to get them is to transcribe what a person
 * actually hears. Doing that used to mean exporting the film first, which put the
 * whole of subtitling behind a render nobody needed yet.
 *
 * One ffmpeg call rather than a file per range: the ranges are already known and
 * the filter graph keeps the result gapless by construction, so there is no seam
 * arithmetic here to get wrong.
 */
export function buildCutAudioArgs(
  source: string,
  ranges: readonly { start: number; end: number }[],
  output: string,
  profile: AudioProfile = AUDIO_PROFILES[0],
): string[] {
  const parts = ranges.map((range, index) =>
    `[0:a]atrim=start=${range.start.toFixed(6)}:end=${range.end.toFixed(6)},`
    + `asetpts=PTS-STARTPTS[a${index}]`);
  const inputs = ranges.map((_, index) => `[a${index}]`).join("");
  const filter = `${parts.join(";")};${inputs}concat=n=${ranges.length}:v=0:a=1[out]`;
  return [
    "-y", "-v", "error", "-i", ffmpegFileArg(source),
    "-filter_complex", filter, "-map", "[out]",
    // 与 runFfmpeg 同理：显式 -f，不让 ffmpeg 从文件名推断。
    "-acodec", profile.codec, ...profile.extraArgs,
    "-f", profile.format, ffmpegFileArg(output),
  ];
}

async function runCutAudioWithFallback(
  source: string,
  ranges: readonly { start: number; end: number }[],
  output: string,
): Promise<string> {
  const failures: string[] = [];
  for (const profile of AUDIO_PROFILES) {
    const result = await runFfmpegOnce(buildCutAudioArgs(source, ranges, output, profile));
    if (result.code === 0) return profile.format;
    failures.push(`${profile.format}/${profile.codec}: ${result.stderr.trim().slice(-400)}`);
    if (!looksLikeUnsupportedProfile(result.stderr)) break;
  }
  throw new Error(`ffmpeg cut audio failed. 逐档报错：\n${failures.join("\n")}`);
}

export interface TranscribeProjectCutOptions {
  /** Absolute path of the source video the ledger refers to. */
  source: string;
  /** Kept ranges in source seconds, in playback order. */
  ranges: readonly { start: number; end: number }[];
  /** Absolute path to write the transcript to. */
  output: string;
  language?: string;
  apiKey?: string;
  resourceId?: string;
  modelName?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  dependencies?: Partial<TranscriptionDependencies> & {
    extractCutAudio?: (source: string, ranges: readonly { start: number; end: number }[], output: string) => Promise<string | void>;
  };
}

/**
 * Transcribe the cut itself, without exporting it first.
 *
 * The times that come back are already on the cut timeline, because the audio that
 * went in *is* the cut. Nothing here maps between timelines — that mapping is
 * exactly the thing that keeps being got wrong.
 */
export async function transcribeProjectCut(
  options: TranscribeProjectCutOptions,
): Promise<TranscribeKouboVideoResult> {
  const ranges = options.ranges.filter((range) => range.end > range.start);
  if (ranges.length === 0) {
    throw new VideocutError("invalid_argument", "The edit list keeps nothing to transcribe");
  }
  const apiKey = (options.apiKey ?? process.env.VOLCENGINE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new VideocutError(
      "missing_cloud_transcription_adapter",
      "Volcengine transcription requires VOLCENGINE_API_KEY",
    );
  }
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const extractCutAudio = options.dependencies?.extractCutAudio
    ?? runCutAudioWithFallback;
  const media = await dependencies.probe(options.source);
  if (!media.hasAudio) {
    throw new VideocutError("media_has_no_audio", "Source video has no audio stream", { source: options.source });
  }
  const duration = ranges.reduce((total, range) => total + (range.end - range.start), 0);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "chengfeng-videocut-cut-audio-"));
  const audio = join(temporaryDirectory, "audio.mp3");
  try {
    const audioFormat = (await extractCutAudio(options.source, ranges, audio)) ?? "mp3";
    const result = await submitAndPoll({
      audio,
      audioFormat,
      apiKey,
      resourceId: (options.resourceId ?? process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_RESOURCE_ID).trim() || DEFAULT_RESOURCE_ID,
      modelName: (options.modelName ?? process.env.VOLCENGINE_ASR_MODEL_NAME ?? DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME,
      language: (options.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE,
      pollIntervalMs: nonNegativeFinite(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs"),
      maxPollAttempts: positiveInteger(options.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS, "maxPollAttempts"),
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
      signal: options.signal,
      dependencies,
    });
    const document = buildVolcengineTranscript({
      result,
      language: (options.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE,
      duration,
    });
    await mkdir(dirname(options.output), { recursive: true });
    const temporary = `${options.output}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, options.output);
    return {
      provider: "volcengine",
      source: options.source,
      output: options.output,
      cueCount: document.cues.length,
      wordCount: document.cues.flatMap((cue) => cue.words).length,
      duration,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function transcribeKouboVideo(
  jobDir: string,
  options: TranscribeKouboVideoOptions,
): Promise<TranscribeKouboVideoResult> {
  const root = await realpath(resolve(jobDir));
  const source = await existingTaskFile(root, options.video, "--video");
  const output = await assertNewTaskOutput(root, options.output);
  const apiKey = (options.apiKey ?? process.env.VOLCENGINE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new VideocutError(
      "missing_cloud_transcription_adapter",
      "Volcengine transcription requires VOLCENGINE_API_KEY",
    );
  }
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const media = await dependencies.probe(source);
  if (!media.hasAudio) {
    throw new VideocutError("media_has_no_audio", "Source video has no audio stream", { source });
  }
  if (!(media.duration > 0)) {
    throw new VideocutError("invalid_argument", "Source video must have a positive duration", { source });
  }
  const language = (options.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;
  const resourceId = (options.resourceId ?? process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_RESOURCE_ID).trim() || DEFAULT_RESOURCE_ID;
  const modelName = (options.modelName ?? process.env.VOLCENGINE_ASR_MODEL_NAME ?? DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME;
  const pollIntervalMs = nonNegativeFinite(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
  const maxPollAttempts = positiveInteger(options.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS, "maxPollAttempts");
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
  const mediaSha256 = await sha256File(source);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "chengfeng-videocut-transcribe-"));
  const audio = join(temporaryDirectory, "audio.mp3");
  try {
    const audioFormat = (await dependencies.extractAudio(source, audio)) ?? "mp3";
    const checkpoint = await prepareTranscriptionCheckpoint(root, {
      provider: "volcengine",
      source: relativeTaskPath(root, source),
      output: relativeTaskPath(root, output),
      mediaSha256,
      mediaDuration: rounded(media.duration),
      audioFormat,
      language,
      modelName,
      resourceId,
    }, dependencies);
    const result = await submitAndPoll({
      audio,
      audioFormat,
      apiKey,
      resourceId,
      modelName,
      language,
      pollIntervalMs,
      maxPollAttempts,
      requestTimeoutMs,
      signal: options.signal,
      dependencies,
      checkpoint,
    });
    const document = buildVolcengineTranscript({
      result,
      language,
      duration: media.duration,
      media: {
        source: options.video,
        sha256: mediaSha256,
        duration: media.duration,
      },
    });
    await writeTranscriptAtomically(root, output, document);
    await completeTranscriptionCheckpoint(checkpoint, dependencies);
    const wordCount = document.cues.flatMap((cue) => cue.words).length;
    return {
      provider: "volcengine",
      source,
      output,
      cueCount: document.cues.length,
      wordCount,
      duration: media.duration,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
