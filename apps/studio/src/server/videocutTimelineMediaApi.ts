/// <reference types="node" />

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  realpath,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { ffmpegFileArg } from "@video-workbench/core";

const API_SCHEMA_VERSION = 1 as const;
const FRAME_CACHE_VERSION = 1 as const;
const WAVEFORM_CACHE_VERSION = 1 as const;
const FRAME_ROUTE = /^\/api\/v1\/projects\/([^/]+)\/media\/frame$/;
const WAVEFORM_ROUTE = /^\/api\/v1\/projects\/([^/]+)\/media\/waveform$/;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const WAVEFORM_WIDTH = 2_048;
const WAVEFORM_HEIGHT = 64;
const DEFAULT_FFMPEG_CONCURRENCY = 2;
const DEFAULT_MAX_CACHE_ENTRIES = 1_024;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;

export const TIMELINE_FRAME_MIN_WIDTH = 48;
export const TIMELINE_FRAME_MAX_WIDTH = 640;
export const TIMELINE_FRAME_MAX_TIME_SECONDS = 24 * 60 * 60;

export interface TimelineFrameExtraction {
  sourcePath: string;
  targetPath: string;
  time: number;
  width: number;
}

export interface VideocutTimelineMediaHandlerOptions {
  projectsDir: string;
  /** Disposable Product cache. It must not be inside a registered project. */
  cacheDir: string;
  ffmpegPath?: string;
  ffmpegConcurrency?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  extractFrame?: (input: TimelineFrameExtraction) => Promise<void>;
  extractWaveform?: (sourcePath: string) => Promise<readonly number[]>;
}

export type VideocutTimelineMediaHandler = (
  request: Request,
) => Promise<Response | null>;

interface FrameRoute {
  kind: "frame";
  projectId: string;
  source: string;
  time: number;
  width: number;
}

interface WaveformRoute {
  kind: "waveform";
  projectId: string;
  source: string;
}

type TimelineMediaRoute = FrameRoute | WaveformRoute;

interface ResolvedSource {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number | bigint;
}

interface FrameArtifact {
  body: Uint8Array;
  etag: string;
}

interface WaveformArtifact {
  peaks: readonly number[];
  etag: string;
}

class TimelineFrameError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class AsyncLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      const start = () => {
        this.active += 1;
        void operation().then(resolvePromise, reject).finally(() => {
          this.active -= 1;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.concurrency) start();
      else this.queue.push(start);
    });
  }
}

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

async function cacheEntries(directory: string): Promise<CacheEntry[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const results = await Promise.all(entries.filter((entry) =>
      entry.isFile() && (entry.name.endsWith(".jpg") || entry.name.endsWith(".json"))
    ).map(async (entry): Promise<CacheEntry | null> => {
      const path = resolve(directory, entry.name);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
      } catch {
        return null;
      }
    }));
    return results.filter((entry): entry is CacheEntry => entry !== null);
  } catch {
    return [];
  }
}

async function pruneCache(
  directories: readonly string[],
  maxEntries: number,
  maxBytes: number,
): Promise<void> {
  const entries = (await Promise.all(directories.map(cacheEntries)))
    .flat()
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let remainingEntries = entries.length;
  for (const entry of entries) {
    if (remainingEntries <= maxEntries && totalBytes <= maxBytes) break;
    try {
      await rm(entry.path, { force: true });
      remainingEntries -= 1;
      totalBytes -= entry.size;
    } catch {
      // Cache reclamation is best-effort and must never block Timeline editing.
    }
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    {
      schemaVersion: API_SCHEMA_VERSION,
      ok: false,
      error: { code, message },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalPotentialPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function validProjectId(value: string): boolean {
  return Boolean(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0");
}

function validProjectRelativePath(value: string): boolean {
  return Boolean(value) &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((segment) => segment === "." || segment === "..");
}

function strictNumber(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRoute(url: URL): TimelineMediaRoute | null {
  const frameMatch = FRAME_ROUTE.exec(url.pathname);
  const waveformMatch = WAVEFORM_ROUTE.exec(url.pathname);
  const match = frameMatch ?? waveformMatch;
  if (!match) return null;

  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]);
  } catch {
    throw new TimelineFrameError(400, "invalid_project_id", "项目 ID 编码无效");
  }
  if (!validProjectId(projectId)) {
    throw new TimelineFrameError(400, "invalid_project_id", "项目 ID 无效");
  }

  const source = url.searchParams.get("source") ?? "";
  if (!validProjectRelativePath(source)) {
    throw new TimelineFrameError(400, "invalid_source", "source 必须是安全的项目相对路径");
  }
  if (!VIDEO_EXTENSIONS.has(extname(source).toLowerCase())) {
    throw new TimelineFrameError(
      415,
      "unsupported_media_type",
      "只支持 mp4、mov、m4v 和 webm 视频源",
    );
  }

  if (waveformMatch) {
    return { kind: "waveform", projectId, source };
  }

  const time = strictNumber(url.searchParams.get("time"));
  if (time === null || time > TIMELINE_FRAME_MAX_TIME_SECONDS) {
    throw new TimelineFrameError(
      400,
      "invalid_time",
      `time 必须在 0 到 ${TIMELINE_FRAME_MAX_TIME_SECONDS} 秒之间`,
    );
  }
  const width = strictNumber(url.searchParams.get("width"));
  if (
    width === null ||
    !Number.isInteger(width) ||
    width < TIMELINE_FRAME_MIN_WIDTH ||
    width > TIMELINE_FRAME_MAX_WIDTH
  ) {
    throw new TimelineFrameError(
      400,
      "invalid_width",
      `width 必须是 ${TIMELINE_FRAME_MIN_WIDTH} 到 ${TIMELINE_FRAME_MAX_WIDTH} 的整数`,
    );
  }

  // Millisecond buckets prevent tiny floating-point differences from creating
  // unbounded FFmpeg work while preserving the source PTS required by Timeline.
  return {
    kind: "frame",
    projectId,
    source,
    time: Math.round(time * 1000) / 1000,
    width,
  };
}

export function isVideocutTimelineMediaRequest(pathname: string): boolean {
  return FRAME_ROUTE.test(pathname) || WAVEFORM_ROUTE.test(pathname);
}

async function registeredProjectRoot(
  projectsDir: string,
  projectId: string,
): Promise<string> {
  try {
    const registration = resolve(projectsDir, projectId);
    if (!isWithin(projectsDir, registration)) throw new Error("registration escaped registry");
    const root = await realpath(registration);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("registration is not a directory");
    return root;
  } catch {
    throw new TimelineFrameError(404, "project_not_found", "项目不存在");
  }
}

async function resolveSource(root: string, source: string): Promise<ResolvedSource> {
  try {
    const candidate = resolve(root, source);
    if (!isWithin(root, candidate)) throw new Error("source escaped project");
    // Follow every symlink, then check the canonical path again. A media
    // symlink must never turn this read-only endpoint into an arbitrary reader.
    const path = await realpath(candidate);
    if (!isWithin(root, path)) throw new Error("canonical source escaped project");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("source is not a file");
    return {
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: info.ino,
    };
  } catch {
    throw new TimelineFrameError(404, "media_not_found", "项目内找不到该视频源");
  }
}

function sourceRevision(source: ResolvedSource): Record<string, string | number> {
  return {
    path: source.path,
    size: source.size,
    mtimeMs: source.mtimeMs,
    ctimeMs: source.ctimeMs,
    ino: String(source.ino),
  };
}

function frameCacheKey(route: FrameRoute, source: ResolvedSource): string {
  return createHash("sha256").update(JSON.stringify({
    version: FRAME_CACHE_VERSION,
    source: sourceRevision(source),
    time: route.time.toFixed(3),
    width: route.width,
  })).digest("hex");
}

function waveformCacheKey(source: ResolvedSource): string {
  return createHash("sha256").update(JSON.stringify({
    version: WAVEFORM_CACHE_VERSION,
    source: sourceRevision(source),
    width: WAVEFORM_WIDTH,
    height: WAVEFORM_HEIGHT,
  })).digest("hex");
}

function isJpeg(body: Uint8Array): boolean {
  return body.byteLength >= 4 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[body.byteLength - 2] === 0xff &&
    body[body.byteLength - 1] === 0xd9;
}

async function readValidJpeg(path: string): Promise<Uint8Array | null> {
  try {
    const body = await readFile(path);
    if (isJpeg(body)) {
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return body;
    }
  } catch {
    return null;
  }
  await rm(path, { force: true }).catch(() => undefined);
  return null;
}

function runFfmpeg(
  ffmpegPath: string,
  input: TimelineFrameExtraction,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-y",
      "-ss", input.time.toFixed(3),
      "-i", ffmpegFileArg(input.sourcePath),
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", `scale=${input.width}:-2:flags=lanczos`,
      "-an",
      "-sn",
      "-dn",
      "-c:v", "mjpeg",
      "-q:v", "3",
      "-f", "image2",
      ffmpegFileArg(input.targetPath),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise();
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(
        `ffmpeg frame extraction failed (${code ?? signal ?? "unknown"})${
          stderr.trim() ? `: ${stderr.trim().slice(-3000)}` : ""
        }`,
      ));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("ffmpeg frame extraction timed out"));
    }, 20_000);
  });
}

function waveformPeaksFromGrayFrame(body: Uint8Array): readonly number[] {
  if (body.byteLength !== WAVEFORM_WIDTH * WAVEFORM_HEIGHT) {
    throw new TimelineFrameError(
      422,
      "waveform_not_available",
      "音频波形数据不完整",
    );
  }
  const center = (WAVEFORM_HEIGHT - 1) / 2;
  return Array.from({ length: WAVEFORM_WIDTH }, (_, x) => {
    let distance = 0;
    for (let y = 0; y < WAVEFORM_HEIGHT; y += 1) {
      if (body[y * WAVEFORM_WIDTH + x] > 8) {
        distance = Math.max(distance, Math.abs(y - center));
      }
    }
    return Math.max(0, Math.min(1, distance / center));
  });
}

function runWaveformFfmpeg(
  ffmpegPath: string,
  sourcePath: string,
): Promise<readonly number[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-i", ffmpegFileArg(sourcePath),
      "-filter_complex",
      `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${WAVEFORM_WIDTH}x${WAVEFORM_HEIGHT}:colors=white:scale=lin[waveform]`,
      "-map", "[waveform]",
      "-frames:v", "1",
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, peaks?: readonly number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(peaks ?? []);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength <= WAVEFORM_WIDTH * WAVEFORM_HEIGHT + 4_096) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (code === 0) {
        try {
          finish(undefined, waveformPeaksFromGrayFrame(Buffer.concat(chunks, byteLength)));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const detail = stderr.trim().slice(-3_000);
      if (/matches no streams|cannot find a matching stream|stream specifier.*no streams/i.test(detail)) {
        finish(new TimelineFrameError(422, "no_audio", "该视频没有原声音轨"));
        return;
      }
      finish(new Error(
        `ffmpeg waveform extraction failed (${code ?? signal ?? "unknown"})${
          detail ? `: ${detail}` : ""
        }`,
      ));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new TimelineFrameError(504, "waveform_timeout", "音频波形生成超时，可稍后重试"));
    }, 60_000);
  });
}

function validWaveformPeaks(value: unknown): value is readonly number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= WAVEFORM_WIDTH &&
    value.every((peak) =>
      typeof peak === "number" && Number.isFinite(peak) && peak >= 0 && peak <= 1
    );
}

async function readValidWaveform(path: string): Promise<readonly number[] | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { peaks?: unknown };
    if (validWaveformPeaks(parsed.peaks)) {
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return parsed.peaks;
    }
  } catch {
    return null;
  }
  await rm(path, { force: true }).catch(() => undefined);
  return null;
}

function acceptsEtag(request: Request, etag: string): boolean {
  const value = request.headers.get("if-none-match");
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

function frameResponse(request: Request, artifact: FrameArtifact): Response {
  const headers = {
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Content-Length": String(artifact.body.byteLength),
    "Content-Type": "image/jpeg",
    ETag: artifact.etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (acceptsEtag(request, artifact.etag)) {
    return new Response(null, { status: 304, headers });
  }
  let body: ArrayBuffer | null = null;
  if (request.method !== "HEAD") {
    body = new ArrayBuffer(artifact.body.byteLength);
    new Uint8Array(body).set(artifact.body);
  }
  return new Response(body, { headers });
}

function waveformResponse(
  request: Request,
  route: WaveformRoute,
  artifact: WaveformArtifact,
): Response {
  const source = JSON.stringify({
    schemaVersion: API_SCHEMA_VERSION,
    projectId: route.projectId,
    source: route.source,
    peakCount: artifact.peaks.length,
    peaks: artifact.peaks,
  });
  const headers = {
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Content-Length": String(Buffer.byteLength(source)),
    "Content-Type": "application/json; charset=utf-8",
    ETag: artifact.etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (acceptsEtag(request, artifact.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : source, { headers });
}

export function createVideocutTimelineMediaHandler(
  options: VideocutTimelineMediaHandlerOptions,
): VideocutTimelineMediaHandler {
  const projectsDir = resolve(options.projectsDir);
  const cacheDir = resolve(options.cacheDir);
  const canonicalCacheDir = canonicalPotentialPath(cacheDir);
  const canonicalFrameCacheDir = canonicalPotentialPath(resolve(cacheDir, "frames"));
  const canonicalWaveformCacheDir = canonicalPotentialPath(resolve(cacheDir, "waveforms"));
  const extractFrame = options.extractFrame ?? ((input: TimelineFrameExtraction) =>
    runFfmpeg(options.ffmpegPath?.trim() || "ffmpeg", input));
  const extractWaveform = options.extractWaveform ?? ((sourcePath: string) =>
    runWaveformFfmpeg(options.ffmpegPath?.trim() || "ffmpeg", sourcePath));
  const ffmpegConcurrency = Number.isInteger(options.ffmpegConcurrency)
    ? Math.max(1, Math.min(DEFAULT_FFMPEG_CONCURRENCY, Number(options.ffmpegConcurrency)))
    : DEFAULT_FFMPEG_CONCURRENCY;
  const maxCacheEntries = Number.isInteger(options.maxCacheEntries)
    ? Math.max(1, Number(options.maxCacheEntries))
    : DEFAULT_MAX_CACHE_ENTRIES;
  const maxCacheBytes = Number.isFinite(options.maxCacheBytes)
    ? Math.max(1, Number(options.maxCacheBytes))
    : DEFAULT_MAX_CACHE_BYTES;
  const extractionLimiter = new AsyncLimiter(ffmpegConcurrency);
  const frameInflight = new Map<string, Promise<FrameArtifact>>();
  const waveformInflight = new Map<string, Promise<WaveformArtifact>>();
  let pruneTail: Promise<void> = Promise.resolve();
  const reclaimCache = async (): Promise<void> => {
    const directories = await Promise.all([canonicalFrameCacheDir, canonicalWaveformCacheDir]);
    const next = pruneTail.catch(() => undefined).then(() =>
      pruneCache(directories, maxCacheEntries, maxCacheBytes)
    );
    pruneTail = next;
    await next;
  };

  return async (request: Request): Promise<Response | null> => {
    let route: TimelineMediaRoute | null;
    try {
      route = parseRoute(new URL(request.url));
    } catch (error) {
      if (error instanceof TimelineFrameError) {
        return jsonError(error.status, error.code, error.message);
      }
      return jsonError(400, "invalid_request", "时间线媒体请求无效");
    }
    if (!route) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      });
    }

    try {
      const root = await registeredProjectRoot(projectsDir, route.projectId);
      const resolvedCacheDir = await canonicalCacheDir;
      if (isWithin(root, resolvedCacheDir)) {
        throw new TimelineFrameError(
          500,
          "invalid_cache_location",
          "时间线媒体缓存目录不能位于项目目录内",
        );
      }
      const source = await resolveSource(root, route.source);
      if (route.kind === "frame") {
        const frameRoute = route;
        const key = frameCacheKey(frameRoute, source);
        const etag = `"frame-${key}"`;
        if (acceptsEtag(request, etag)) {
          return new Response(null, {
            status: 304,
            headers: {
              "Cache-Control": "private, max-age=0, must-revalidate",
              "Content-Type": "image/jpeg",
              ETag: etag,
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        let pending = frameInflight.get(key);
        if (!pending) {
          pending = (async (): Promise<FrameArtifact> => {
            const configuredFrameCacheDir = await canonicalFrameCacheDir;
            if (isWithin(root, configuredFrameCacheDir)) {
              throw new TimelineFrameError(
                500,
                "invalid_cache_location",
                "视频帧缓存目录不能位于项目目录内",
              );
            }
            await mkdir(configuredFrameCacheDir, { recursive: true });
            const frameCacheDir = await realpath(configuredFrameCacheDir);
            if (isWithin(root, frameCacheDir)) {
              throw new TimelineFrameError(
                500,
                "invalid_cache_location",
                "视频帧缓存真实目录不能位于项目目录内",
              );
            }
            const targetPath = resolve(frameCacheDir, `${key}.jpg`);
            const cached = await readValidJpeg(targetPath);
            if (cached) return { body: cached, etag };

            const temporaryPath = resolve(
              frameCacheDir,
              `.${key}.${randomUUID()}.tmp.jpg`,
            );
            try {
              await extractionLimiter.run(() => extractFrame({
                sourcePath: source.path,
                targetPath: temporaryPath,
                time: frameRoute.time,
                width: frameRoute.width,
              }));
              const generated = await readValidJpeg(temporaryPath);
              if (!generated) {
                throw new TimelineFrameError(
                  422,
                  "frame_not_available",
                  "该时间点没有可用视频画面",
                );
              }
              await rename(temporaryPath, targetPath);
              await reclaimCache().catch(() => undefined);
              return { body: generated, etag };
            } finally {
              await rm(temporaryPath, { force: true }).catch(() => undefined);
            }
          })().finally(() => {
            frameInflight.delete(key);
          });
          frameInflight.set(key, pending);
        }

        return frameResponse(request, await pending);
      }

      const waveformRoute = route;
      const key = waveformCacheKey(source);
      const etag = `"waveform-${key}"`;
      if (acceptsEtag(request, etag)) {
        return new Response(null, {
          status: 304,
          headers: {
            "Cache-Control": "private, max-age=0, must-revalidate",
            "Content-Type": "application/json; charset=utf-8",
            ETag: etag,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      let waveformPending = waveformInflight.get(key);
      if (!waveformPending) {
        waveformPending = (async (): Promise<WaveformArtifact> => {
          const configuredWaveformCacheDir = await canonicalWaveformCacheDir;
          if (isWithin(root, configuredWaveformCacheDir)) {
            throw new TimelineFrameError(
              500,
              "invalid_cache_location",
              "音频波形缓存目录不能位于项目目录内",
            );
          }
          await mkdir(configuredWaveformCacheDir, { recursive: true });
          const waveformCacheDir = await realpath(configuredWaveformCacheDir);
          if (isWithin(root, waveformCacheDir)) {
            throw new TimelineFrameError(
              500,
              "invalid_cache_location",
              "音频波形缓存真实目录不能位于项目目录内",
            );
          }
          const targetPath = resolve(waveformCacheDir, `${key}.json`);
          const cached = await readValidWaveform(targetPath);
          if (cached) return { peaks: cached, etag };

          const temporaryPath = resolve(
            waveformCacheDir,
            `.${key}.${randomUUID()}.tmp.json`,
          );
          try {
            const peaks = await extractionLimiter.run(() => extractWaveform(source.path));
            if (!validWaveformPeaks(peaks)) {
              throw new TimelineFrameError(
                422,
                "waveform_not_available",
                "音频波形数据无效",
              );
            }
            await writeFile(temporaryPath, JSON.stringify({
              schemaVersion: API_SCHEMA_VERSION,
              peaks,
            }), "utf8");
            await rename(temporaryPath, targetPath);
            await reclaimCache().catch(() => undefined);
            return { peaks, etag };
          } finally {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
          }
        })().finally(() => {
          waveformInflight.delete(key);
        });
        waveformInflight.set(key, waveformPending);
      }

      return waveformResponse(request, waveformRoute, await waveformPending);
    } catch (error) {
      if (error instanceof TimelineFrameError) {
        return jsonError(error.status, error.code, error.message);
      }
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code === "ENOENT") {
        return jsonError(503, "ffmpeg_unavailable", "FFmpeg 不可用，暂时无法生成时间线预览");
      }
      if (code === "no_audio") {
        return jsonError(422, "no_audio", "该视频没有原声音轨");
      }
      if (route.kind === "waveform") {
        return jsonError(422, "waveform_not_available", "音频波形生成失败，可稍后重试");
      }
      return jsonError(422, "frame_not_available", "预览画面生成失败，可稍后重试");
    }
  };
}
