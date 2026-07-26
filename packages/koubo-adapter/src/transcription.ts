import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VideocutError } from "@video-workbench/core";
import { probeMedia, type MediaProbe } from "./mediaCut";

const VOLCENGINE_SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const VOLCENGINE_QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const DEFAULT_RESOURCE_ID = "volc.seedasr.auc";
const DEFAULT_MODEL_NAME = "bigmodel";
const DEFAULT_LANGUAGE = "zh-CN";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 1_200;

type JsonRecord = Record<string, unknown>;

export interface VolcengineTimedWord {
  text: string;
  start: number;
  end: number;
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
  extractAudio: (input: string, output: string) => Promise<void>;
  fetch: (input: string, init: RequestInit) => Promise<FetchLikeResponse>;
  probe: (input: string) => Promise<MediaProbe>;
  sleep: (milliseconds: number) => Promise<void>;
  uuid: () => string;
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

function runFfmpeg(input: string, output: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-v", "error", "-i", `file:${input}`, "-vn", "-acodec", "libmp3lame", `file:${output}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg audio extraction failed (${code ?? "signal"}): ${stderr.trim().slice(-1000)}`));
    });
  });
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
  };
}

function providerError(message: string, details: Record<string, unknown> = {}): VideocutError {
  return new VideocutError("cloud_transcription_failed", message, details);
}

function responseStatus(response: FetchLikeResponse): string | null {
  return response.headers.get("x-api-status-code") ?? response.headers.get("X-Api-Status-Code");
}

async function parseProviderResponse(
  response: FetchLikeResponse,
  stage: "submit" | "query",
): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw providerError(`Volcengine ${stage} returned invalid JSON`, { stage, httpStatus: response.status });
  }
  if (!response.ok) {
    throw providerError(`Volcengine ${stage} failed with HTTP ${response.status}`, {
      stage,
      httpStatus: response.status,
      providerStatus: responseStatus(response),
    });
  }
  return payload;
}

async function requestProvider(
  dependencies: TranscriptionDependencies,
  stage: "submit" | "query",
  url: string,
  init: RequestInit,
): Promise<FetchLikeResponse> {
  try {
    return await dependencies.fetch(url, init);
  } catch (error) {
    throw providerError(`Volcengine ${stage} request failed`, {
      stage,
      causeType: error instanceof Error ? error.name : typeof error,
    });
  }
}

function timedWords(payload: unknown): VolcengineTimedWord[] {
  const root = isRecord(payload) ? payload : {};
  const result = isRecord(root.result) ? root.result : root;
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const words: VolcengineTimedWord[] = [];
  for (const utterance of utterances) {
    if (!isRecord(utterance) || !Array.isArray(utterance.words)) continue;
    for (const item of utterance.words) {
      if (!isRecord(item)) continue;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const start = Number(item.start_time);
      const end = Number(item.end_time);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        continue;
      }
      words.push({ text, start: start / 1_000, end: end / 1_000 });
    }
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
  apiKey: string;
  resourceId: string;
  modelName: string;
  language: string;
  pollIntervalMs: number;
  maxPollAttempts: number;
  dependencies: TranscriptionDependencies;
}): Promise<unknown> {
  const audioData = await readFile(input.audio);
  const requestId = input.dependencies.uuid();
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Key": input.apiKey,
    "X-Api-Resource-Id": input.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  };
  const submit = await requestProvider(input.dependencies, "submit", VOLCENGINE_SUBMIT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user: { uid: "chengfeng-videocut" },
      audio: {
        data: audioData.toString("base64"),
        format: "mp3",
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
    signal: AbortSignal.timeout(60_000),
  });
  await parseProviderResponse(submit, "submit");
  const submitStatus = responseStatus(submit);
  if (submitStatus && submitStatus !== "20000000") {
    throw providerError("Volcengine rejected the transcription request", {
      stage: "submit",
      providerStatus: submitStatus,
    });
  }

  for (let attempt = 1; attempt <= input.maxPollAttempts; attempt += 1) {
    await input.dependencies.sleep(input.pollIntervalMs);
    const query = await requestProvider(input.dependencies, "query", VOLCENGINE_QUERY_URL, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await parseProviderResponse(query, "query");
    const words = timedWords(payload);
    if (words.length > 0) return payload;
    const status = responseStatus(query);
    if (status && status !== "20000000" && status !== "20000001" && status !== "20000002") {
      throw providerError("Volcengine query failed", {
        stage: "query",
        providerStatus: status,
        attempt,
      });
    }
    if (status === "20000000") {
      throw providerError("Volcengine completed without timed words", {
        stage: "query",
        providerStatus: status,
      });
    }
  }
  throw providerError("Volcengine transcription timed out", {
    maxPollAttempts: input.maxPollAttempts,
  });
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "chengfeng-videocut-transcribe-"));
  const audio = join(temporaryDirectory, "audio.mp3");
  try {
    await dependencies.extractAudio(source, audio);
    const result = await submitAndPoll({
      audio,
      apiKey,
      resourceId: (options.resourceId ?? process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_RESOURCE_ID).trim(),
      modelName: (options.modelName ?? process.env.VOLCENGINE_ASR_MODEL_NAME ?? DEFAULT_MODEL_NAME).trim(),
      language: (options.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxPollAttempts: options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS,
      dependencies,
    });
    const document = buildVolcengineTranscript({
      result,
      language: (options.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE,
      duration: media.duration,
      media: {
        source: options.video,
        sha256: await sha256File(source),
        duration: media.duration,
      },
    });
    await writeTranscriptAtomically(root, output, document);
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

