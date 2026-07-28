import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const CACHE_SCHEMA = "chengfeng-videocut-preview-proxy-v1";
const MAX_WIDTH = 960;
const MAX_HEIGHT = 720;
const MIN_FRAME_RATE = 4;
const MAX_FRAME_RATE = 30;
const MAX_KEYFRAME_INTERVAL_SECONDS = 0.25;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;

export interface PreviewProxyConfig {
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  maxKeyframeIntervalSeconds: number;
  videoBitrateKbps: number;
  videoMaxrateKbps: number;
  videoBufferKbps: number;
  audioBitrateKbps: number;
  audioSampleRate: number;
  audioChannels: number;
}

export const DEFAULT_PREVIEW_PROXY_CONFIG: Readonly<PreviewProxyConfig> = Object.freeze({
  maxWidth: 960,
  maxHeight: 720,
  frameRate: 30,
  maxKeyframeIntervalSeconds: 0.2,
  videoBitrateKbps: 1_300,
  videoMaxrateKbps: 8_000,
  videoBufferKbps: 16_000,
  audioBitrateKbps: 96,
  audioSampleRate: 48_000,
  audioChannels: 2,
});

export interface PreviewProxyMediaProbe {
  duration: number;
  startTime: number;
  videoStartTime: number | null;
  audioStartTime: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string | null;
  audioCodec: string | null;
  maxKeyframeIntervalSeconds: number | null;
}

export interface PreviewProxyTranscodeInput {
  sourcePath: string;
  temporaryPath: string;
  sourceProbe: PreviewProxyMediaProbe;
  config: PreviewProxyConfig;
  ffmpegPath: string;
}

export interface PreviewProxyDependencies {
  hashFile?: (path: string) => Promise<string>;
  probeMedia?: (
    path: string,
    options: { includeKeyframes: boolean; ffprobePath: string },
  ) => Promise<PreviewProxyMediaProbe>;
  transcode?: (input: PreviewProxyTranscodeInput) => Promise<void>;
}

export type PreviewProxyFailureReason =
  | "invalid-config"
  | "invalid-source"
  | "source-probe-failed"
  | "source-without-video"
  | "source-without-audio"
  | "ffmpeg-unavailable"
  | "ffprobe-unavailable"
  | "transcode-failed"
  | "proxy-probe-failed"
  | "invalid-proxy"
  | "source-changed"
  | "filesystem-error";

export interface PreviewProxyResult {
  status: "ready" | "unsupported" | "failed";
  reason: PreviewProxyFailureReason | null;
  message: string | null;
  cacheHit: boolean;
  sourcePath: string;
  sourceSha256: string | null;
  cacheKey: string | null;
  proxyPath: string | null;
  preservedExistingProxy: boolean;
  config: PreviewProxyConfig;
  sourceProbe: PreviewProxyMediaProbe | null;
  proxyProbe: PreviewProxyMediaProbe | null;
}

export interface EnsurePreviewProxyOptions {
  sourcePath: string;
  cacheDirectory: string;
  config?: Partial<PreviewProxyConfig>;
  ffmpegPath?: string;
  ffprobePath?: string;
  dependencies?: PreviewProxyDependencies;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface SourceIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

class PreviewProxyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewProxyValidationError";
  }
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(finite(value, fallback))));
}

function boundedEven(value: unknown, fallback: number, maximum: number): number {
  const bounded = boundedInteger(value, fallback, 2, maximum);
  return Math.max(2, bounded - bounded % 2);
}

export function normalizePreviewProxyConfig(
  input: Partial<PreviewProxyConfig> = {},
): PreviewProxyConfig {
  const frameRate = boundedInteger(
    input.frameRate,
    DEFAULT_PREVIEW_PROXY_CONFIG.frameRate,
    MIN_FRAME_RATE,
    MAX_FRAME_RATE,
  );
  const requestedKeyframeInterval = finite(
    input.maxKeyframeIntervalSeconds,
    DEFAULT_PREVIEW_PROXY_CONFIG.maxKeyframeIntervalSeconds,
  );
  if (!(requestedKeyframeInterval > 0)) {
    throw new PreviewProxyValidationError("maxKeyframeIntervalSeconds must be positive");
  }
  const minimumKeyframeInterval = 1 / frameRate;
  const maxKeyframeIntervalSeconds = Math.max(
    minimumKeyframeInterval,
    Math.min(MAX_KEYFRAME_INTERVAL_SECONDS, requestedKeyframeInterval),
  );
  const videoBitrateKbps = boundedInteger(
    input.videoBitrateKbps,
    DEFAULT_PREVIEW_PROXY_CONFIG.videoBitrateKbps,
    100,
    20_000,
  );
  const videoMaxrateKbps = boundedInteger(
    input.videoMaxrateKbps,
    DEFAULT_PREVIEW_PROXY_CONFIG.videoMaxrateKbps,
    videoBitrateKbps,
    30_000,
  );
  const videoBufferKbps = boundedInteger(
    input.videoBufferKbps,
    DEFAULT_PREVIEW_PROXY_CONFIG.videoBufferKbps,
    videoMaxrateKbps,
    60_000,
  );
  return {
    maxWidth: boundedEven(input.maxWidth, DEFAULT_PREVIEW_PROXY_CONFIG.maxWidth, MAX_WIDTH),
    maxHeight: boundedEven(input.maxHeight, DEFAULT_PREVIEW_PROXY_CONFIG.maxHeight, MAX_HEIGHT),
    frameRate,
    maxKeyframeIntervalSeconds,
    videoBitrateKbps,
    videoMaxrateKbps,
    videoBufferKbps,
    audioBitrateKbps: boundedInteger(
      input.audioBitrateKbps,
      DEFAULT_PREVIEW_PROXY_CONFIG.audioBitrateKbps,
      32,
      320,
    ),
    audioSampleRate: boundedInteger(
      input.audioSampleRate,
      DEFAULT_PREVIEW_PROXY_CONFIG.audioSampleRate,
      8_000,
      96_000,
    ),
    audioChannels: boundedInteger(
      input.audioChannels,
      DEFAULT_PREVIEW_PROXY_CONFIG.audioChannels,
      1,
      2,
    ),
  };
}

function configFingerprint(config: PreviewProxyConfig): string {
  return JSON.stringify({
    schema: CACHE_SCHEMA,
    maxWidth: config.maxWidth,
    maxHeight: config.maxHeight,
    frameRate: config.frameRate,
    maxKeyframeIntervalSeconds: config.maxKeyframeIntervalSeconds,
    videoCodec: "libx264",
    videoPreset: "superfast",
    videoTune: "fastdecode",
    videoBitrateKbps: config.videoBitrateKbps,
    videoMaxrateKbps: config.videoMaxrateKbps,
    videoBufferKbps: config.videoBufferKbps,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrateKbps: config.audioBitrateKbps,
    audioSampleRate: config.audioSampleRate,
    audioChannels: config.audioChannels,
  });
}

export function previewProxyCacheKey(
  sourceSha256: string,
  configInput: Partial<PreviewProxyConfig> = {},
): string {
  if (!REVISION_PATTERN.test(sourceSha256)) {
    throw new PreviewProxyValidationError("sourceSha256 must be a lowercase SHA-256 digest");
  }
  const config = normalizePreviewProxyConfig(configInput);
  return createHash("sha256")
    .update(`${sourceSha256}\n${configFingerprint(config)}`)
    .digest("hex");
}

function capOutput(previous: string, chunk: string, maximum = 8 * 1024 * 1024): string {
  const next = previous + chunk;
  return next.length <= maximum ? next : next.slice(-maximum);
}

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = capOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk: string) => { stderr = capOutput(stderr, chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(
        `${command} failed (${code ?? signal ?? "unknown"})` +
          `${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

function rational(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const [left, right] = text.split("/").map(Number);
  if (Number.isFinite(left) && Number.isFinite(right) && right !== 0) return left / right;
  return finite(text, 0);
}

export async function probePreviewProxyMedia(
  path: string,
  options: { includeKeyframes?: boolean; ffprobePath?: string } = {},
): Promise<PreviewProxyMediaProbe> {
  const ffprobePath = options.ffprobePath?.trim() || "ffprobe";
  const { stdout } = await runCommand(ffprobePath, [
    "-v", "error",
    "-show_entries",
    "format=duration,start_time:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,start_time",
    "-of", "json",
    `file:${path}`,
  ]);
  const payload = JSON.parse(stdout) as {
    format?: { duration?: string | number; start_time?: string | number };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Math.max(0, finite(payload.format?.duration, 0));
  let maxKeyframeIntervalSeconds: number | null = null;
  if (options.includeKeyframes && video) {
    const keyframeResult = await runCommand(ffprobePath, [
      "-v", "error",
      "-select_streams", "v:0",
      "-skip_frame", "nokey",
      "-show_entries", "frame=best_effort_timestamp_time",
      "-of", "json",
      `file:${path}`,
    ]);
    const keyframePayload = JSON.parse(keyframeResult.stdout) as {
      frames?: Array<{ best_effort_timestamp_time?: string | number }>;
    };
    const times = (Array.isArray(keyframePayload.frames) ? keyframePayload.frames : [])
      .map((frame) => finite(frame.best_effort_timestamp_time, Number.NaN))
      .filter((time) => Number.isFinite(time))
      .sort((left, right) => left - right);
    if (times.length > 0) {
      const intervals = [Math.max(0, times[0])];
      for (let index = 1; index < times.length; index += 1) {
        intervals.push(Math.max(0, times[index] - times[index - 1]));
      }
      intervals.push(Math.max(0, duration - times[times.length - 1]));
      maxKeyframeIntervalSeconds = Math.max(...intervals);
    }
  }
  const averageFrameRate = rational(video?.avg_frame_rate);
  const formatStartTime = finite(payload.format?.start_time, 0);
  const videoStartTime = video ? finite(video.start_time, 0) : null;
  const audioStartTime = audio ? finite(audio.start_time, 0) : null;
  const startTime = [formatStartTime, videoStartTime, audioStartTime]
    .filter((value): value is number => value !== null)
    .reduce((largest, value) => (
      Math.abs(value) > Math.abs(largest) ? value : largest
    ), 0);
  return {
    duration,
    startTime,
    videoStartTime,
    audioStartTime,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Math.max(0, finite(video?.width, 0)),
    height: Math.max(0, finite(video?.height, 0)),
    frameRate: Math.max(0, averageFrameRate || rational(video?.r_frame_rate)),
    videoCodec: video ? String(video.codec_name ?? "") : null,
    audioCodec: audio ? String(audio.codec_name ?? "") : null,
    maxKeyframeIntervalSeconds,
  };
}

export function buildPreviewProxyFfmpegArgs(input: PreviewProxyTranscodeInput): string[] {
  const { config, sourceProbe } = input;
  const gopFrames = Math.max(
    1,
    Math.floor(config.frameRate * config.maxKeyframeIntervalSeconds + 1e-9),
  );
  const keyframeInterval = (gopFrames / config.frameRate).toFixed(6);
  const videoFilter = [
    `scale=w='min(iw,${config.maxWidth})':h='min(ih,${config.maxHeight})'` +
      ":force_original_aspect_ratio=decrease:force_divisible_by=2",
    `fps=${config.frameRate}`,
    "setpts=PTS-STARTPTS",
  ].join(",");
  return [
    "-nostdin", "-y", "-v", "error",
    "-i", `file:${input.sourcePath}`,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-sn", "-dn",
    "-vf", videoFilter,
    "-af", `aresample=${config.audioSampleRate}:async=1:first_pts=0,` +
      "apad,asetpts=PTS-STARTPTS",
    "-c:v", "libx264",
    // Quality-targeted, not bitrate-targeted. This GOP is one keyframe every
    // 0.2s for snappy scrubbing — an I-frame-heavy stream starved to a fixed
    // 1.3Mbps turned a page of text into mush, visibly softer than the
    // original (用户对照剪映一眼看穿：剪映预览的是原片). CRF lets the size
    // float to whatever the text needs; the maxrate cap is a safety, not a
    // target. superfast/fastdecode were paying quality for speed nobody
    // needed at this resolution.
    "-preset", "faster",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-crf", "16",
    "-maxrate", `${config.videoMaxrateKbps}k`,
    "-bufsize", `${config.videoBufferKbps}k`,
    "-g", String(gopFrames),
    "-keyint_min", String(gopFrames),
    "-sc_threshold", "0",
    "-force_key_frames", `expr:gte(t,n_forced*${keyframeInterval})`,
    "-c:a", "aac",
    "-b:a", `${config.audioBitrateKbps}k`,
    "-ar", String(config.audioSampleRate),
    "-ac", String(config.audioChannels),
    "-fps_mode", "cfr",
    "-r", String(config.frameRate),
    "-t", sourceProbe.duration.toFixed(6),
    "-movflags", "+faststart",
    "-tag:v", "avc1",
    `file:${input.temporaryPath}`,
  ];
}

async function defaultTranscode(input: PreviewProxyTranscodeInput): Promise<void> {
  await runCommand(input.ffmpegPath, buildPreviewProxyFfmpegArgs(input));
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

function sourceIdentity(value: Stats): SourceIdentity {
  return {
    dev: Number(value.dev),
    ino: Number(value.ino),
    size: Number(value.size),
    mtimeMs: Number(value.mtimeMs),
  };
}

function sameSourceIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : message.slice(-2_000);
}

async function existingRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function validateSourceProbe(probe: PreviewProxyMediaProbe): PreviewProxyFailureReason | null {
  if (!probe.hasVideo || !(probe.duration > 0) || !(probe.width > 0) || !(probe.height > 0)) {
    return "source-without-video";
  }
  if (!probe.hasAudio) return "source-without-audio";
  return null;
}

function validateProxyProbe(
  source: PreviewProxyMediaProbe,
  proxy: PreviewProxyMediaProbe,
  config: PreviewProxyConfig,
): void {
  if (!proxy.hasVideo || !proxy.hasAudio) {
    throw new PreviewProxyValidationError("Preview proxy must contain video and audio");
  }
  if (proxy.videoCodec !== "h264" || proxy.audioCodec !== "aac") {
    throw new PreviewProxyValidationError(
      `Preview proxy codecs must be h264/aac, got ${proxy.videoCodec ?? "none"}/` +
        `${proxy.audioCodec ?? "none"}`,
    );
  }
  if (
    !(proxy.width > 0) ||
    !(proxy.height > 0) ||
    proxy.width > config.maxWidth ||
    proxy.height > config.maxHeight ||
    proxy.width > source.width ||
    proxy.height > source.height
  ) {
    throw new PreviewProxyValidationError(
      `Preview proxy dimensions ${proxy.width}x${proxy.height} violate the configured bounds`,
    );
  }
  const sourceAspect = source.width / source.height;
  const proxyAspect = proxy.width / proxy.height;
  if (Math.abs(sourceAspect - proxyAspect) > 0.02) {
    throw new PreviewProxyValidationError("Preview proxy changed the source aspect ratio");
  }
  if (Math.abs(proxy.frameRate - config.frameRate) > 0.05) {
    throw new PreviewProxyValidationError(
      `Preview proxy frame rate ${proxy.frameRate} does not match ${config.frameRate}`,
    );
  }
  if (Math.abs(proxy.startTime) > 0.05) {
    throw new PreviewProxyValidationError(
      `Preview proxy must start at zero, got ${proxy.startTime}`,
    );
  }
  const startTolerance = Math.max(0.01, 1 / config.frameRate + 0.002);
  if (
    proxy.videoStartTime === null ||
    proxy.audioStartTime === null ||
    Math.abs(proxy.videoStartTime) > startTolerance ||
    Math.abs(proxy.audioStartTime) > startTolerance
  ) {
    throw new PreviewProxyValidationError(
      `Preview proxy streams must start at zero, got video=` +
        `${proxy.videoStartTime ?? "missing"}, audio=${proxy.audioStartTime ?? "missing"}`,
    );
  }
  const durationTolerance = Math.max(0.12, 2 / config.frameRate);
  if (Math.abs(proxy.duration - source.duration) > durationTolerance) {
    throw new PreviewProxyValidationError(
      `Preview proxy duration ${proxy.duration} differs from source ${source.duration}`,
    );
  }
  if (
    proxy.maxKeyframeIntervalSeconds === null ||
    proxy.maxKeyframeIntervalSeconds > config.maxKeyframeIntervalSeconds + 0.01
  ) {
    throw new PreviewProxyValidationError(
      `Preview proxy keyframe interval ${proxy.maxKeyframeIntervalSeconds ?? "unknown"} exceeds ` +
        `${config.maxKeyframeIntervalSeconds}`,
    );
  }
}

function baseResult(input: {
  status: PreviewProxyResult["status"];
  reason?: PreviewProxyFailureReason | null;
  message?: string | null;
  cacheHit?: boolean;
  sourcePath: string;
  sourceSha256?: string | null;
  cacheKey?: string | null;
  proxyPath?: string | null;
  preservedExistingProxy?: boolean;
  config: PreviewProxyConfig;
  sourceProbe?: PreviewProxyMediaProbe | null;
  proxyProbe?: PreviewProxyMediaProbe | null;
}): PreviewProxyResult {
  return {
    status: input.status,
    reason: input.reason ?? null,
    message: input.message ?? null,
    cacheHit: input.cacheHit ?? false,
    sourcePath: input.sourcePath,
    sourceSha256: input.sourceSha256 ?? null,
    cacheKey: input.cacheKey ?? null,
    proxyPath: input.proxyPath ?? null,
    preservedExistingProxy: input.preservedExistingProxy ?? false,
    config: input.config,
    sourceProbe: input.sourceProbe ?? null,
    proxyProbe: input.proxyProbe ?? null,
  };
}

/**
 * Creates one immutable-source, same-timeline proxy and publishes it only after
 * probing every playback contract. A failed candidate is deleted; an existing
 * cache entry is never removed or truncated before the atomic rename succeeds.
 */
export async function ensurePreviewProxy(
  options: EnsurePreviewProxyOptions,
): Promise<PreviewProxyResult> {
  const sourceInput = resolve(options.sourcePath);
  let config: PreviewProxyConfig;
  try {
    config = normalizePreviewProxyConfig(options.config);
  } catch (error) {
    return baseResult({
      status: "failed",
      reason: "invalid-config",
      message: errorMessage(error),
      sourcePath: sourceInput,
      config: { ...DEFAULT_PREVIEW_PROXY_CONFIG },
    });
  }
  const ffmpegPath = options.ffmpegPath?.trim() || "ffmpeg";
  const ffprobePath = options.ffprobePath?.trim() || "ffprobe";
  const hashFile = options.dependencies?.hashFile ?? sha256File;
  const probeMedia = options.dependencies?.probeMedia ?? (
    (path, probeOptions) => probePreviewProxyMedia(path, {
      includeKeyframes: probeOptions.includeKeyframes,
      ffprobePath: probeOptions.ffprobePath,
    })
  );
  const transcode = options.dependencies?.transcode ?? defaultTranscode;
  let sourcePath = sourceInput;
  let initialIdentity: SourceIdentity;
  try {
    sourcePath = await realpath(sourceInput);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      throw new Error("sourcePath must be a non-empty regular file");
    }
    initialIdentity = sourceIdentity(sourceStat);
  } catch (error) {
    return baseResult({
      status: "failed",
      reason: "invalid-source",
      message: errorMessage(error),
      sourcePath,
      config,
    });
  }

  let sourceSha256: string;
  let cacheKey: string;
  let proxyPath: string;
  try {
    sourceSha256 = await hashFile(sourcePath);
    if (!REVISION_PATTERN.test(sourceSha256)) {
      throw new Error("hashFile did not return a lowercase SHA-256 digest");
    }
    cacheKey = previewProxyCacheKey(sourceSha256, config);
    proxyPath = join(resolve(options.cacheDirectory), `${cacheKey}.mp4`);
  } catch (error) {
    return baseResult({
      status: "failed",
      reason: "filesystem-error",
      message: errorMessage(error),
      sourcePath,
      config,
    });
  }

  let sourceProbe: PreviewProxyMediaProbe;
  try {
    sourceProbe = await probeMedia(sourcePath, { includeKeyframes: false, ffprobePath });
  } catch (error) {
    const unavailable = errorCode(error) === "ENOENT";
    return baseResult({
      status: unavailable ? "unsupported" : "failed",
      reason: unavailable ? "ffprobe-unavailable" : "source-probe-failed",
      message: errorMessage(error),
      sourcePath,
      sourceSha256,
      cacheKey,
      config,
    });
  }
  const unsupportedSource = validateSourceProbe(sourceProbe);
  if (unsupportedSource) {
    return baseResult({
      status: "unsupported",
      reason: unsupportedSource,
      message: unsupportedSource === "source-without-audio"
        ? "Preview proxy requires a source audio stream"
        : "Preview proxy requires a readable source video stream",
      sourcePath,
      sourceSha256,
      cacheKey,
      config,
      sourceProbe,
    });
  }

  let preservedExistingProxy = false;
  try {
    preservedExistingProxy = await existingRegularFile(proxyPath);
  } catch (error) {
    return baseResult({
      status: "failed",
      reason: "filesystem-error",
      message: errorMessage(error),
      sourcePath,
      sourceSha256,
      cacheKey,
      config,
      sourceProbe,
    });
  }
  if (preservedExistingProxy) {
    try {
      const cachedProbe = await probeMedia(proxyPath, { includeKeyframes: true, ffprobePath });
      validateProxyProbe(sourceProbe, cachedProbe, config);
      const currentIdentity = sourceIdentity(await stat(sourcePath));
      if (!sameSourceIdentity(initialIdentity, currentIdentity)) {
        return baseResult({
          status: "failed",
          reason: "source-changed",
          message: "Source changed while its preview-proxy cache key was being resolved",
          sourcePath,
          sourceSha256,
          cacheKey,
          config,
          sourceProbe,
          preservedExistingProxy: true,
        });
      }
      return baseResult({
        status: "ready",
        cacheHit: true,
        sourcePath,
        sourceSha256,
        cacheKey,
        proxyPath,
        config,
        sourceProbe,
        proxyProbe: cachedProbe,
        preservedExistingProxy: true,
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return baseResult({
          status: "unsupported",
          reason: "ffprobe-unavailable",
          message: errorMessage(error),
          sourcePath,
          sourceSha256,
          cacheKey,
          config,
          sourceProbe,
          preservedExistingProxy: true,
        });
      }
      // A corrupt or obsolete cache entry is retained until a fully validated
      // replacement is ready. Generation failure below therefore cannot make
      // the last file state worse.
    }
  }

  const temporaryPath = `${proxyPath}.tmp-${process.pid}-${Date.now()}-` +
    `${Math.random().toString(36).slice(2)}.mp4`;
  let candidateProbe: PreviewProxyMediaProbe | null = null;
  let stage: "transcode" | "probe" | "validate" | "publish" = "transcode";
  try {
    await mkdir(dirname(proxyPath), { recursive: true });
    await transcode({ sourcePath, temporaryPath, sourceProbe, config, ffmpegPath });
    stage = "probe";
    candidateProbe = await probeMedia(temporaryPath, { includeKeyframes: true, ffprobePath });
    stage = "validate";
    validateProxyProbe(sourceProbe, candidateProbe, config);
    const currentIdentity = sourceIdentity(await stat(sourcePath));
    if (!sameSourceIdentity(initialIdentity, currentIdentity)) {
      return baseResult({
        status: "failed",
        reason: "source-changed",
        message: "Source changed while its preview proxy was being generated",
        sourcePath,
        sourceSha256,
        cacheKey,
        config,
        sourceProbe,
        proxyProbe: candidateProbe,
        preservedExistingProxy,
      });
    }
    stage = "publish";
    await rename(temporaryPath, proxyPath);
    return baseResult({
      status: "ready",
      cacheHit: false,
      sourcePath,
      sourceSha256,
      cacheKey,
      proxyPath,
      config,
      sourceProbe,
      proxyProbe: candidateProbe,
      preservedExistingProxy,
    });
  } catch (error) {
    const unavailable = errorCode(error) === "ENOENT";
    const validation = error instanceof PreviewProxyValidationError;
    const missingRuntime = unavailable && (stage === "transcode" || stage === "probe");
    return baseResult({
      status: missingRuntime ? "unsupported" : "failed",
      reason: missingRuntime
        ? (stage === "transcode" ? "ffmpeg-unavailable" : "ffprobe-unavailable")
        : validation
          ? "invalid-proxy"
          : stage === "probe"
            ? "proxy-probe-failed"
          : unavailable || stage === "publish"
            ? "filesystem-error"
            : "transcode-failed",
      message: errorMessage(error),
      sourcePath,
      sourceSha256,
      cacheKey,
      config,
      sourceProbe,
      proxyProbe: candidateProbe,
      preservedExistingProxy,
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
