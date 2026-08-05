import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cutVideoBySegments, probeMedia, probePreviewProxyMedia } from "@video-workbench/koubo-adapter";
import {
  parseEditListDocument,
  ffmpegFileArg,
  ffmpegOutputArgs,
  runWithFfmpegComplexFilterFile,
} from "@video-workbench/core";
import { serializeProjectOperation as serializeProjectOperationDefault } from "@video-workbench/core/node";
import { isSafeProjectId } from "./project-media";
import { buildPreviewStream, type PreviewStream } from "./preview-stream";

export const EDIT_PREVIEW_CONFIG = Object.freeze({
  profile: "sharp-canonical-v1",
  schemaVersion: 2,
  container: "mp4",
  video: "concat-demuxer-select-cfr",
  audio: "aac-single-encode",
  gopSeconds: 0.2,
});

export type EditPreviewPhase = "pending" | "generating" | "current" | "failed" | "stale";

// `ledger-proxy-v1` is not a rendered artifact. It says: play the preview proxy
// directly and let the player follow the edit list, the way every desktop NLE
// does — the timeline *is* the source, so no intermediate media exists and no
// edit can make it stale. The three encoded profiles above stay for the cases
// the ledger cannot express (several source files, or a segment whose speed is
// not 1x); see `canPlayFromLedger`.
export type EditPreviewProfile = "sharp-canonical-v1" | "fast-proxy-v1" | "ledger-proxy-v1";
export type EditPreviewSourceKind = "canonical" | "fast-proxy" | "ledger-proxy";

export interface EditPreviewArtifactState {
  schemaVersion: 2;
  projectId: string;
  phase: EditPreviewPhase;
  editRevision: string;
  artifactRevision: string | null;
  cacheKey: string | null;
  sourceSha256: string | null;
  source: string | null;
  profile: EditPreviewProfile | null;
  sourceKind: EditPreviewSourceKind | null;
  sourceFrameRate: number | null;
  width: number | null;
  height: number | null;
  videoBitrate: number | null;
  duration: number | null;
  byteLength: number | null;
  hasVideo: boolean | null;
  hasAudio: boolean | null;
  generatedAt: string | null;
  generationMs: number | null;
  /**
   * Fragments to assemble into one continuous stream, in order.
   *
   * Present only on the ledger path. Its absence means the player has a single
   * finished file to play straight through; its presence means the player must
   * assemble, because a player that jumps leaks the deleted audio it jumps over.
   */
  stream: PreviewStream | null;
  error: string | null;
}

interface PreviewArtifactGenerateInput {
  input: string;
  output: string;
  frameRate: number;
  profile: "sharp-canonical-v1" | "fast-proxy-v1";
  segments: readonly { start: number; end: number }[];
}

type PreviewArtifactGenerate = (input: PreviewArtifactGenerateInput) => ReturnType<typeof cutVideoBySegments>;
type ProjectOperationSerializer = typeof serializeProjectOperationDefault;

export interface ProjectInput {
  projectId: string;
  projectDir: string;
  editRevision: string;
  sourceSha256: string;
  sourceProxy: string;
  sourceKind?: "canonical" | "fast-proxy";
  previewProfile?: "sharp-canonical-v1" | "fast-proxy-v1";
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  previewFrameRate: number;
  previewProxyRevision: string;
  previewProxyCacheKey: string;
  /** Project-relative path of a ready preview proxy, when the project has one. */
  previewProxySource?: string;
  previewProxyDuration?: number | null;
  previewProxyByteLength?: number | null;
  previewProxyWidth?: number | null;
  previewProxyHeight?: number | null;
  previewProxyFrameRate?: number | null;
  segments: Array<{ start: number; end: number; source?: string; playbackRate?: number }>;
  duration: number;
}

export interface EditPreviewArtifactDependencies {
  generate?: PreviewArtifactGenerate;
  /** Injectable so unit tests need not supply decodable media to exercise state. */
  buildStream?: typeof buildPreviewStream;
  probe?: typeof probeMedia;
  readProjectInput?: (projectsDir: string, projectId: string) => Promise<ProjectInput>;
  serializeProjectOperation?: ProjectOperationSerializer;
  now?: () => number;
  debounceMs?: number;
  /** ledger 构建的同步预算（毫秒）；测试可调小逼出 generating 路径。 */
  ledgerSyncBudgetMs?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

const canonicalVerificationCache = new Map<string, {
  size: number;
  mtimeMs: number;
  sha256: string;
  frameRate: number;
  width: number | null;
  height: number | null;
}>();
const canonicalVerificationInFlight = new Map<string, Promise<{ frameRate: number; width: number | null; height: number | null }>>();
const artifactProbeCache = new Map<string, { size: number; mtimeMs: number; media: Awaited<ReturnType<typeof probeMedia>> }>();

export interface CanonicalVerificationDependencies {
  probe?: (path: string) => Promise<{ frameRate: number; width?: number; height?: number }>;
  hash?: (path: string) => Promise<string>;
}

function finiteDimension(value: unknown): number | null {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension >= 2 ? dimension : null;
}

export function resetCanonicalVerificationCacheForTest(): void {
  canonicalVerificationCache.clear();
  canonicalVerificationInFlight.clear();
  artifactProbeCache.clear();
}

export async function verifyCanonicalSource(
  path: string,
  expectedSha256: string,
  dependencies: CanonicalVerificationDependencies = {},
): Promise<{ frameRate: number; width: number | null; height: number | null }> {
  const info = await stat(path);
  const cached = canonicalVerificationCache.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    if (cached.sha256 !== expectedSha256) throw new Error("Canonical source SHA-256 no longer matches the project lineage");
    return { frameRate: cached.frameRate, width: cached.width, height: cached.height };
  }
  const inFlightKey = `${path}\0${info.size}\0${info.mtimeMs}\0${expectedSha256}`;
  const pending = canonicalVerificationInFlight.get(inFlightKey);
  if (pending) return await pending;
  const verification = (async () => {
    const [probe, actualSha256] = await Promise.all([
      (dependencies.probe ?? probePreviewProxyMedia)(path),
      (dependencies.hash ?? sha256File)(path),
    ]);
    const after = await stat(path);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error("Canonical source changed during verification; retry");
    }
    if (actualSha256 !== expectedSha256) throw new Error("Canonical source SHA-256 no longer matches the project lineage");
    canonicalVerificationCache.set(path, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: actualSha256,
      frameRate: probe.frameRate,
      width: finiteDimension(probe.width),
      height: finiteDimension(probe.height),
    });
    return {
      frameRate: probe.frameRate,
      width: finiteDimension(probe.width),
      height: finiteDimension(probe.height),
    };
  })().finally(() => canonicalVerificationInFlight.delete(inFlightKey));
  canonicalVerificationInFlight.set(inFlightKey, verification);
  return await verification;
}

async function cachedArtifactProbe(path: string, probe: typeof probeMedia) {
  const info = await stat(path);
  const cached = artifactProbeCache.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return { info, media: cached.media };
  const media = await probe(path);
  artifactProbeCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, media });
  return { info, media };
}

function expectedSharpPreviewDimensions(input: ProjectInput): { width: number; height: number; minimumBitrate: number } {
  const sourceWidth = finiteDimension(input.sourceWidth);
  const sourceHeight = finiteDimension(input.sourceHeight);
  if (!sourceWidth || !sourceHeight) return { width: 1440, height: 1080, minimumBitrate: 3_000_000 };
  const scale = Math.min(1, 1440 / sourceWidth, 1080 / sourceHeight);
  const width = Math.max(2, Math.floor(sourceWidth * scale / 2) * 2);
  const height = Math.max(2, Math.floor(sourceHeight * scale / 2) * 2);
  return {
    width,
    height,
    minimumBitrate: Math.max(1, Math.round(3_000_000 * width * height / (1440 * 1080))),
  };
}

function assertArtifactQuality(input: ProjectInput, media: Awaited<ReturnType<typeof probeMedia>>): void {
  if (!media.hasVideo || !media.hasAudio || Math.abs(media.duration - input.duration) > 0.12) {
    throw new Error(`Generated preview validation failed: duration=${media.duration}`);
  }
  const expected = expectedSharpPreviewDimensions(input);
  if (input.previewProfile === "sharp-canonical-v1" && (
    media.width < expected.width || media.height < expected.height || media.videoBitrate < expected.minimumBitrate ||
    !Number.isFinite(media.frameRate) || Math.abs((media.frameRate ?? 0) - input.previewFrameRate) > 0.05
  )) throw new Error(
    `Sharp preview validation failed: ${media.width}x${media.height} @ ${media.videoBitrate}; ` +
    `expected at least ${expected.width}x${expected.height} @ ${expected.minimumBitrate}`,
  );
}

function filterTime(value: number): string {
  return value.toFixed(6);
}

function finiteFrameRate(value: unknown): number | null {
  const frameRate = Number(value);
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 120) return null;
  return frameRate;
}

function gopFrames(frameRate: number): number {
  return Math.max(1, Math.round(frameRate * EDIT_PREVIEW_CONFIG.gopSeconds));
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `${command} failed (${code ?? "signal"})${stderr ? `: ${stderr.trim().slice(-3000)}` : ""}`,
      ));
    });
  });
}

function x264Profile(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("baseline")) return "baseline";
  if (normalized.includes("main")) return "main";
  return "high";
}

function previewFilter(segments: readonly { start: number; end: number }[], hasAudio: boolean): string {
  const filters = [
    "[0:v:0]select=concatdec_select,setpts=PTS-STARTPTS[outv]",
  ];
  if (!hasAudio) return `${filters.join(";\n")}\n`;
  if (segments.length === 1) {
    const segment = segments[0];
    filters.push(
      `[1:a:0]asetpts=PTS-STARTPTS,` +
        `atrim=start=${filterTime(segment.start)}:end=${filterTime(segment.end)},` +
        "asetpts=PTS-STARTPTS[outa]",
    );
  } else {
    filters.push(
      `[1:a:0]asetpts=PTS-STARTPTS,asplit=${segments.length}` +
        segments.map((_, index) => `[asrc${index}]`).join(""),
    );
    segments.forEach((segment, index) => {
      filters.push(
        `[asrc${index}]atrim=start=${filterTime(segment.start)}:end=${filterTime(segment.end)},` +
          `asetpts=PTS-STARTPTS[a${index}]`,
      );
    });
    filters.push(
      `${segments.map((_, index) => `[a${index}]`).join("")}` +
        `concat=n=${segments.length}:v=0:a=1[outa]`,
    );
  }
  return `${filters.join(";\n")}\n`;
}

function concatFilePath(path: string): string {
  return resolve(path).replaceAll("\\", "\\\\").replaceAll("'", "'\\''");
}

function previewConcatManifest(
  source: string,
  segments: readonly { start: number; end: number }[],
): string {
  const escapedSource = concatFilePath(source);
  const entries = segments.map((segment) => [
    `file '${escapedSource}'`,
    `inpoint ${filterTime(segment.start)}`,
    `outpoint ${filterTime(segment.end)}`,
  ].join("\n"));
  return `ffconcat version 1.0\n${entries.join("\n")}\n`;
}

export async function generatePreviewArtifactVideo(input: {
  input: string;
  output: string;
  frameRate: number;
  profile?: "sharp-canonical-v1" | "fast-proxy-v1";
  segments: readonly { start: number; end: number }[];
}): ReturnType<typeof cutVideoBySegments> {
  const source = await probeMedia(input.input);
  if (!source.hasVideo || !(source.duration > 0)) {
    throw new Error(`Input is not a readable video: ${input.input}`);
  }
  const segments = input.segments.map((segment, index) => {
    if (
      !(segment.start >= 0) ||
      !(segment.end <= source.duration + 0.001) ||
      !(segment.end - segment.start >= 0.029)
    ) {
      throw new Error(`Invalid preview segment #${index}`);
    }
    return { start: segment.start, end: Math.min(source.duration, segment.end) };
  });
  if (segments.length === 0) throw new Error("Edit list must retain at least one segment");
  const frameRate = finiteFrameRate(input.frameRate) ?? 30;
  const profile = input.profile ?? "sharp-canonical-v1";
  const keyint = gopFrames(frameRate);
  await mkdir(dirname(input.output), { recursive: true });
  const temporaryOutput = `${input.output}.tmp-${process.pid}-${Date.now()}.mp4`;
  const workDir = await mkdtemp(join(tmpdir(), "chengfeng-videocut-preview-"));
  try {
    const filterPath = join(workDir, "preview-edl-filter.txt");
    const concatPath = join(workDir, "preview-edl.ffconcat");
    const videoFilter = profile === "sharp-canonical-v1"
      ? `scale=w='min(iw,1440)':h='min(ih,1080)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${frameRate}`
      : `fps=${frameRate}`;
    const filter = previewFilter(segments, source.hasAudio)
      .replace("setpts=PTS-STARTPTS[outv]", `setpts=PTS-STARTPTS,${videoFilter}[outv]`);
    await writeFile(filterPath, filter, "utf8");
    await writeFile(concatPath, previewConcatManifest(input.input, segments), "utf8");
    const expectedDuration = segments.reduce(
      (total, segment) => total + segment.end - segment.start,
      0,
    );
    const bitrateK = source.videoBitrate > 0
      ? profile === "sharp-canonical-v1"
        ? Math.max(3_000, Math.min(8_000, Math.round(source.videoBitrate / 1000 * 1.5)))
        : Math.max(200, Math.round(source.videoBitrate / 1000))
      : 0;
    const videoArgs = bitrateK > 0
      ? [
          "-b:v", `${bitrateK}k`,
          "-maxrate", `${Math.round(bitrateK * 1.3)}k`,
          "-bufsize", `${bitrateK * 2}k`,
        ]
      : ["-crf", "18"];
    await runWithFfmpegComplexFilterFile(filterPath, (filterArgs) =>
      runCommand("ffmpeg", [
        "-y", "-v", "error",
        "-copyts", "-segment_time_metadata", "1",
        "-f", "concat", "-safe", "0", "-i", concatPath,
        ...(source.hasAudio ? ["-i", ffmpegFileArg(input.input)] : []),
        ...filterArgs,
        "-map", "[outv]",
        ...(source.hasAudio ? ["-map", "[outa]"] : []),
        "-c:v", "libx264", "-profile:v", x264Profile(source.videoProfile),
        ...videoArgs,
        "-pix_fmt", source.pixelFormat,
        "-r", String(frameRate),
        "-fps_mode:v", "cfr",
        "-g", String(keyint),
        "-keyint_min", String(keyint),
        "-sc_threshold", "0",
        ...(source.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : []),
        "-t", filterTime(expectedDuration),
        "-movflags", "+faststart",
        ...ffmpegOutputArgs("mp4", temporaryOutput),
      ]));
    const media = await probeMedia(temporaryOutput);
    if (!media.hasVideo || (source.hasAudio && !media.hasAudio)) {
      throw new Error("Preview artifact lost required media streams");
    }
    await rename(temporaryOutput, input.output);
    return {
      input: input.input,
      output: input.output,
      originalDuration: source.duration,
      newDuration: media.duration,
      deletedDuration: Math.max(0, source.duration - media.duration),
      savedPercent: source.duration > 0 ? Math.max(0, source.duration - media.duration) / source.duration * 100 : 0,
      cutRanges: [],
      keepSegments: segments.map((segment) => ({ ...segment })),
      hasAudio: media.hasAudio,
      width: media.width,
      height: media.height,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(temporaryOutput, { force: true });
  }
}

export function editPreviewArtifactCacheKey(input: {
  sourceSha256: string;
  editRevision: string;
  config?: unknown;
}): string {
  const playbackProjection = input.config && typeof input.config === "object"
    ? (input.config as Record<string, unknown>).playbackProjection
    : undefined;
  return sha256(JSON.stringify({
    sourceSha256: input.sourceSha256,
    playbackProjection: playbackProjection ?? input.editRevision,
    config: input.config ?? EDIT_PREVIEW_CONFIG,
  }));
}

export function editPreviewArtifactConfig(input: ProjectInput) {
  const sourceKind = input.sourceKind ?? "fast-proxy";
  const profile = input.previewProfile ?? "fast-proxy-v1";
  return {
    ...EDIT_PREVIEW_CONFIG,
    profile,
    sourceKind,
    frameRate: input.previewFrameRate,
    gopFrames: gopFrames(input.previewFrameRate),
    canonicalSource: input.sourceProxy,
    sourceFrameRate: input.previewFrameRate,
    playbackProjection: input.segments.map((segment) => ({
      source: (segment as { source?: unknown }).source ?? "",
      start: filterTime(segment.start),
      end: filterTime(segment.end),
      rate: filterTime(Number((segment as { playbackRate?: unknown }).playbackRate ?? 1)),
    })),
    ...(sourceKind === "fast-proxy" ? {
      previewProxyRevision: input.previewProxyRevision,
      previewProxyCacheKey: input.previewProxyCacheKey,
    } : {}),
  };
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertSafeProjectId(projectId: string): void {
  if (!isSafeProjectId(projectId)) throw new Error("Invalid project id");
}

async function projectFile(projectDir: string, relativePath: string, label: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`${label} has an invalid path`);
  }
  const candidate = resolve(projectDir, relativePath);
  if (!isWithin(projectDir, candidate)) throw new Error(`${label} escapes project`);
  const resolved = await realpath(candidate);
  if (!isWithin(projectDir, resolved)) throw new Error(`${label} escapes project`);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
  return resolved;
}

export async function projectInput(projectsDir: string, projectId: string): Promise<ProjectInput> {
  assertSafeProjectId(projectId);
  const registryEntry = resolve(projectsDir, projectId);
  const realProjectsDir = await realpath(projectsDir);
  const [entryInfo, realProjectDir] = await Promise.all([
    lstat(registryEntry),
    realpath(registryEntry),
  ]);
  const projectInfo = await stat(realProjectDir);
  if (!projectInfo.isDirectory()) throw new Error("Registered project entry is not a directory");
  if (!entryInfo.isSymbolicLink() && !isWithin(realProjectsDir, realProjectDir)) {
    throw new Error("Project directory escapes projects root");
  }
  const [editRaw, workbenchRaw, projectRaw] = await Promise.all([
    readFile(join(realProjectDir, "edit-list.json"), "utf8"),
    readFile(join(realProjectDir, "workbench.json"), "utf8"),
    readFile(join(realProjectDir, "project.json"), "utf8").catch(() => "{}"),
  ]);
  const edit = parseEditListDocument(JSON.parse(editRaw));
  const workbench = JSON.parse(workbenchRaw) as Record<string, any>;
  const project = JSON.parse(projectRaw) as Record<string, any>;
  const sourceSha256 = String(workbench.sourceSha256 ?? "");
  const proxySource = String(workbench.previewProxy?.source ?? "");
  const canonicalCandidate = [project.source?.path, project.inputVideo, workbench.videoSource]
    .find((value) => value !== undefined && value !== null);
  const hasCanonical = canonicalCandidate !== undefined;
  const canonicalRelative = hasCanonical ? String(canonicalCandidate) : "";
  const previewProxyRevision = String(workbench.previewProxy?.revision ?? "");
  const previewProxyCacheKey = String(workbench.previewProxy?.cacheKey ?? "");
  // A ready proxy is what makes ledger playback viable: it is keyframed every
  // 0.2s, so jumping between retained ranges costs a decoder flush and at most
  // six frames. Only accept it when the proxy declared itself ready and the file
  // is really inside the project.
  const proxyReady = workbench.previewProxy?.status === "ready" && Boolean(proxySource);
  const previewProxySource = proxyReady
    && await projectFile(realProjectDir, proxySource, "Preview proxy").then(() => proxySource, () => "")
    ? proxySource
    : undefined;
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("Current project has no verified canonical source SHA-256");
  let sourceProxy: string;
  let sourceKind: "canonical" | "fast-proxy" = "canonical";
  if (hasCanonical) {
    // A declared canonical lineage is authoritative: every failure is unsafe,
    // and must not silently switch this revision to a lossy proxy.
    sourceProxy = await projectFile(realProjectDir, canonicalRelative, "Canonical source");
  } else {
    if (!proxySource) throw new Error("Current project has no canonical source or preview proxy");
    sourceProxy = await projectFile(realProjectDir, proxySource, "Preview proxy");
    sourceKind = "fast-proxy";
  }
  const sourceProbe = sourceKind === "canonical"
    ? await verifyCanonicalSource(sourceProxy, sourceSha256)
    : null;
  const previewFrameRate = Math.min(
    60,
    finiteFrameRate(sourceProbe?.frameRate) ?? finiteFrameRate(workbench.previewProxy?.frameRate) ?? 0,
  );
  if (!previewFrameRate) throw new Error("Current project source has no verified frame-rate contract");
  return {
    projectId,
    projectDir: realProjectDir,
    editRevision: sha256(editRaw),
    sourceSha256,
    sourceProxy,
    sourceKind,
    previewProfile: sourceKind === "canonical" ? "sharp-canonical-v1" : "fast-proxy-v1",
    sourceWidth: sourceProbe?.width ?? null,
    sourceHeight: sourceProbe?.height ?? null,
    previewFrameRate,
    previewProxyRevision,
    previewProxyCacheKey,
    previewProxySource,
    previewProxyDuration: finiteNumber(workbench.previewProxy?.duration),
    previewProxyByteLength: finiteNumber(workbench.previewProxy?.byteLength),
    previewProxyWidth: finiteNumber(workbench.previewProxy?.width),
    previewProxyHeight: finiteNumber(workbench.previewProxy?.height),
    previewProxyFrameRate: finiteFrameRate(workbench.previewProxy?.frameRate),
    duration: edit.duration,
    segments: edit.segments.map((segment) => ({
      source: segment.source,
      start: segment.sourceStart,
      end: segment.sourceEnd,
      playbackRate: segment.playbackRate,
    })),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// How many encoded artifacts to keep besides the one in use. The cache key is
// per edit revision, so a couple of recent ones let undo land on a hit instead
// of a re-encode. Everything older is unreachable: nothing can ask for an edit
// revision that no longer exists.
const RETAINED_ARTIFACT_GENERATIONS = 3;

// Encoded artifacts are derived data — 35MB each, one per edit, and the cache key
// changes on every keystroke. Without a bound they simply accumulate: the first
// real project reached 26 files and 1.1GB with no way to clean them, because no
// CLI command and no code path ever deleted one. Pruning belongs here rather than
// in a command the person has to remember.
async function pruneEncodedArtifacts(
  artifactDir: string,
  keep: readonly string[],
): Promise<{ removed: number; freedBytes: number }> {
  const protectedNames = new Set(keep);
  let removed = 0;
  let freedBytes = 0;
  let entries: string[];
  try {
    entries = await readdir(artifactDir);
  } catch {
    return { removed, freedBytes };
  }
  const candidates: Array<{ name: string; mtimeMs: number; size: number }> = [];
  for (const name of entries) {
    // Only ever touch this directory's own generated artifacts. The name shape is
    // the cache key, so anything else here (current.json, a stray temp file being
    // written by another process) is left alone.
    if (!/^[a-f0-9]{64}\.mp4$/.test(name) || protectedNames.has(name)) continue;
    try {
      const info = await stat(join(artifactDir, name));
      if (info.isFile()) candidates.push({ name, mtimeMs: info.mtimeMs, size: info.size });
    } catch { continue; }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates.slice(RETAINED_ARTIFACT_GENERATIONS)) {
    try {
      await rm(join(artifactDir, candidate.name), { force: true });
      removed += 1;
      freedBytes += candidate.size;
    } catch { continue; }
  }
  return { removed, freedBytes };
}

// What the edit list can and cannot say through ledger playback.
//
// It can say "play these ranges of one file in this order" — that is exactly a
// `currentTime` jump per boundary, so no media has to be produced. It cannot say
// "play two different files" (one `<video>` element, and a second one is a hard
// rule violation) and it cannot say "play this range at 1.5x" (the element has a
// single playbackRate, and per-segment speed would need it changed mid-stream in
// a way that drifts audio). Those two cases keep the encoded artifact path.
export function canPlayFromLedger(input: ProjectInput): boolean {
  if (!input.previewProxySource) return false;
  if (input.segments.length === 0) return false;
  const sources = new Set(input.segments.map((segment) => segment.source ?? ""));
  if (sources.size !== 1) return false;
  return input.segments.every((segment) => {
    const rate = segment.playbackRate ?? 1;
    return Number.isFinite(rate) && Math.abs(rate - 1) < 1e-9;
  });
}

// The ledger state is `current` the instant it is asked for. There is nothing to
// generate, so no edit can leave it stale and `artifactRevision` always equals
// the edit revision it was asked about.
async function ledgerProxyState(
  input: ProjectInput,
  generatedAt: string,
  buildStream: typeof buildPreviewStream,
): Promise<EditPreviewArtifactState> {
  // Cut the fragments now. They are stream copies keyed by source range, so an
  // unchanged range is reused and a keystroke costs milliseconds — but they must
  // exist before the state claims to be playable, or the player would assemble
  // from files that are not there yet.
  const stream = await buildStream({
    projectDir: input.projectDir,
    proxySource: input.previewProxySource as string,
    proxyCacheKey: input.previewProxyCacheKey || sha256(input.previewProxySource as string),
    segments: input.segments.map((segment) => ({ start: segment.start, end: segment.end })),
  });
  return {
    schemaVersion: 2,
    projectId: input.projectId,
    phase: "current",
    editRevision: input.editRevision,
    artifactRevision: input.editRevision,
    cacheKey: null,
    sourceSha256: input.sourceSha256,
    source: input.previewProxySource ?? null,
    profile: "ledger-proxy-v1",
    sourceKind: "ledger-proxy",
    sourceFrameRate: input.previewProxyFrameRate ?? input.previewFrameRate,
    width: input.previewProxyWidth ?? null,
    height: input.previewProxyHeight ?? null,
    videoBitrate: null,
    // The assembled length, not the proxy's: what plays is the stream.
    duration: stream.totalSeconds,
    byteLength: input.previewProxyByteLength ?? null,
    hasVideo: true,
    hasAudio: true,
    generatedAt,
    generationMs: 0,
    stream,
    error: null,
  };
}

/**
 * 给 Promise 一个同步预算：预算内落定返回结果，预算外返回 null（拒绝会照常抛，
 * 让路由把错误映射成可读消息）。计时器在落定时清掉，不留悬挂句柄。
 */
async function raceWithBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), budgetMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function blankState(projectId: string, editRevision = "none"): EditPreviewArtifactState {
  // "pending"，不是 "stale"：这个项目从未有过剪后预览，没有东西可以「过期」。
  // 把这两个状态混为一谈，会让「正在准备」被报告成「已失效」——2026-08-04
  // Issue #3 的两条误导消息正是这么来的。
  return {
    schemaVersion: 2, projectId, phase: "pending", editRevision,
    artifactRevision: null, cacheKey: null, sourceSha256: null, source: null,
    duration: null, byteLength: null, hasVideo: null, hasAudio: null,
    profile: null, sourceKind: null, sourceFrameRate: null, width: null, height: null, videoBitrate: null,
    generatedAt: null, generationMs: null, stream: null, error: null,
  };
}

function expectedRelativeSource(cacheKey: string): string {
  return `.chengfeng-videocut/preview-edited/${cacheKey}.mp4`;
}

function expectedCacheKeyForInput(input: ProjectInput): string {
  return editPreviewArtifactCacheKey({
    sourceSha256: input.sourceSha256,
    editRevision: input.editRevision,
    config: editPreviewArtifactConfig(input),
  });
}

async function trustedPreviousPreviewSource(
  projectDir: string,
  source: string | null | undefined,
): Promise<string | null> {
  if (
    typeof source !== "string" ||
    !/^\.chengfeng-videocut\/preview-edited\/[a-f0-9]{64}\.mp4$/.test(source)
  ) return null;
  try {
    await projectFile(projectDir, source, "Previous preview artifact");
    return source;
  } catch {
    return null;
  }
}

function stateMatchesInput(state: EditPreviewArtifactState, input: ProjectInput, cacheKey: string): boolean {
  const profile = input.previewProfile ?? "fast-proxy-v1";
  const sourceKind = input.sourceKind ?? "fast-proxy";
  return (
    state.schemaVersion === 2 &&
    state.projectId === input.projectId &&
    state.editRevision === input.editRevision &&
    state.cacheKey === cacheKey &&
    state.sourceSha256 === input.sourceSha256 &&
    state.profile === profile &&
    state.sourceKind === sourceKind &&
    (state.phase === "generating" || state.phase === "failed" ||
      state.source === null || state.source === expectedRelativeSource(cacheKey))
  );
}

function writerTempOutput(output: string): string {
  return `${output}.writer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.mp4`;
}

export class EditPreviewArtifactManager {
  private readonly desired = new Map<string, string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scheduleEpochs = new Map<string, number>();
  private readonly publishEpochs = new Map<string, number>();
  private readonly states = new Map<string, EditPreviewArtifactState>();
  /** ledger 构建的 in-flight 表：同一 revision 只跑一份，轮询共享同一个 Promise。 */
  private readonly ledgerBuilds = new Map<string, { revision: string; promise: Promise<EditPreviewArtifactState> }>();
  private readonly ledgerSyncBudgetMs: number;
  private readonly generate: PreviewArtifactGenerate;
  private readonly probe: typeof probeMedia;
  private readonly readProjectInput: (projectsDir: string, projectId: string) => Promise<ProjectInput>;
  private readonly serializeProjectOperation: ProjectOperationSerializer;
  private readonly buildStream: typeof buildPreviewStream;
  private readonly now: () => number;
  private readonly debounceMs: number;

  constructor(private readonly projectsDir: string, dependencies: EditPreviewArtifactDependencies = {}) {
    this.generate = dependencies.generate ?? generatePreviewArtifactVideo;
    this.buildStream = dependencies.buildStream ?? buildPreviewStream;
    this.probe = dependencies.probe ?? probeMedia;
    this.readProjectInput = dependencies.readProjectInput ?? projectInput;
    this.ledgerSyncBudgetMs = dependencies.ledgerSyncBudgetMs ?? 800;
    this.serializeProjectOperation = dependencies.serializeProjectOperation ?? serializeProjectOperationDefault;
    this.now = dependencies.now ?? Date.now;
    this.debounceMs = dependencies.debounceMs ?? 180;
  }

  async status(projectId: string): Promise<EditPreviewArtifactState> {
    const input = await this.readProjectInput(this.projectsDir, projectId);
    if (canPlayFromLedger(input)) {
      // No artifact, so nothing can be stale and nothing may be scheduled. Drop
      // any state left by the encoded path so a previously rendered artifact can
      // never be reported as the current preview for this revision.
      //
      // 构建是 single-flight 的，并且只给一个同步预算：全缓存命中（毫秒级）
      // 与从前一样在本次请求内直接返回 current；首次构建（切片 + 响度全解码，
      // 可达分钟级）不再挂起 HTTP 请求——立即返回 generating，构建在后台
      // 继续，轮询追平。修订安全不变：结果只对计算它的 editRevision 存储，
      // 每次 status 都重新读盘、重新走到这里。
      const reported = this.states.get(projectId);
      if (
        reported?.phase === "failed" &&
        reported.editRevision === input.editRevision &&
        reported.schemaVersion === 2 &&
        reported.projectId === projectId
      ) return reported;
      const inflight = this.ledgerBuilds.get(projectId);
      let build: Promise<EditPreviewArtifactState>;
      if (inflight && inflight.revision === input.editRevision) {
        build = inflight.promise;
      } else {
        build = ledgerProxyState(input, new Date(this.now()).toISOString(), this.buildStream);
        const entry = { revision: input.editRevision, promise: build };
        this.ledgerBuilds.set(projectId, entry);
        build.then(
          (state) => {
            if (this.ledgerBuilds.get(projectId) !== entry) return;
            this.ledgerBuilds.delete(projectId);
            this.states.set(projectId, state);
            this.desired.set(projectId, input.editRevision);
          },
          (error) => {
            if (this.ledgerBuilds.get(projectId) !== entry) return;
            this.ledgerBuilds.delete(projectId);
            this.states.set(projectId, {
              ...blankState(projectId, input.editRevision),
              phase: "failed",
              error: String(error),
            });
          },
        );
      }
      const state = await raceWithBudget(build, this.ledgerSyncBudgetMs);
      if (!state) {
        // 还在构建：诚实报告 generating。source 为 null——旧媒体绝不冒充新剪辑。
        return {
          ...blankState(projectId, input.editRevision),
          phase: "generating",
          sourceSha256: input.sourceSha256,
        };
      }
      this.states.set(projectId, state);
      this.desired.set(projectId, input.editRevision);
      const timer = this.timers.get(projectId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(projectId);
      }
      // Ledger playback reads none of the encoded artifacts, so whatever a
      // previously encoded history left behind is now dead weight. Keep a few
      // generations in case the project later needs the fallback path.
      void pruneEncodedArtifacts(
        join(input.projectDir, ".chengfeng-videocut", "preview-edited"),
        [],
      ).catch(() => undefined);
      return state;
    }
    const expectedCacheKey = expectedCacheKeyForInput(input);
    const manifest = join(input.projectDir, ".chengfeng-videocut", "preview-edited", "current.json");
    try {
      const saved = await this.readTrustedCurrentManifest(input, expectedCacheKey);
      if (saved) return saved;
      const raw = JSON.parse(await readFile(manifest, "utf8")) as EditPreviewArtifactState;
      const cached = this.states.get(projectId);
      if (
        cached &&
        stateMatchesInput(cached, input, expectedCacheKey) &&
        (cached.phase === "generating" || cached.phase === "failed")
      ) return cached;
      const stale = { ...raw, phase: "stale" as const, editRevision: input.editRevision };
      this.states.set(projectId, stale);
      return stale;
    } catch {
      const cached = this.states.get(projectId);
      if (
        cached &&
        stateMatchesInput(cached, input, expectedCacheKey) &&
        (cached.phase === "generating" || cached.phase === "failed")
      ) return cached;
      return blankState(projectId, input.editRevision);
    }
  }

  private async readTrustedCurrentManifest(
    input: ProjectInput,
    expectedCacheKey: string,
  ): Promise<EditPreviewArtifactState | null> {
    const manifest = join(input.projectDir, ".chengfeng-videocut", "preview-edited", "current.json");
    const saved = JSON.parse(await readFile(manifest, "utf8")) as EditPreviewArtifactState;
    const expectedSource = expectedRelativeSource(expectedCacheKey);
    const profile = input.previewProfile ?? "fast-proxy-v1";
    const sourceKind = input.sourceKind ?? "fast-proxy";
    if (
      saved.schemaVersion === 2 &&
      saved.projectId === input.projectId &&
      saved.phase === "current" &&
      saved.editRevision === input.editRevision &&
      saved.artifactRevision === input.editRevision &&
      saved.cacheKey === expectedCacheKey &&
      saved.sourceSha256 === input.sourceSha256 &&
      saved.profile === profile &&
      saved.sourceKind === sourceKind &&
      saved.source === expectedSource
    ) {
      const file = resolve(input.projectDir, String(saved.source));
      const expectedFile = join(input.projectDir, expectedSource);
      let info = null;
      try { info = await stat(file); } catch { info = null; }
      if (file === expectedFile && info?.isFile() && info.size === saved.byteLength) {
        try {
          const probed = await cachedArtifactProbe(file, this.probe);
          assertArtifactQuality(input, probed.media);
        } catch {
          return null;
        }
        this.states.set(input.projectId, saved);
        return saved;
      }
    }
    return null;
  }

  schedule(projectId: string): void {
    const epoch = (this.scheduleEpochs.get(projectId) ?? 0) + 1;
    this.scheduleEpochs.set(projectId, epoch);
    this.publishEpochs.set(projectId, (this.publishEpochs.get(projectId) ?? 0) + 1);
    void this.readProjectInput(this.projectsDir, projectId).then(async (input) => {
      if (this.scheduleEpochs.get(projectId) !== epoch) return;
      this.desired.set(projectId, input.editRevision);
      if (canPlayFromLedger(input)) {
        // Ledger playback has no generation step. Publish the current state and
        // stop — never fall through into the debounce timer, or every edit would
        // start an ffmpeg run whose output nobody reads.
        this.states.set(projectId, await ledgerProxyState(input, new Date(this.now()).toISOString(), this.buildStream));
        const pending = this.timers.get(projectId);
        if (pending) {
          clearTimeout(pending);
          this.timers.delete(projectId);
        }
        return;
      }
      const cacheKey = expectedCacheKeyForInput(input);
      const previous = this.states.get(projectId);
      const source = await trustedPreviousPreviewSource(input.projectDir, previous?.source);
      if (this.scheduleEpochs.get(projectId) !== epoch) return;
      this.states.set(projectId, {
        ...(previous ?? blankState(projectId, input.editRevision)),
        schemaVersion: 2,
        projectId,
        phase: "generating",
        editRevision: input.editRevision,
        cacheKey,
        sourceSha256: input.sourceSha256,
        profile: input.previewProfile ?? "fast-proxy-v1",
        sourceKind: input.sourceKind ?? "fast-proxy",
        sourceFrameRate: input.previewFrameRate,
        source,
        error: null,
      });
      const timer = this.timers.get(projectId);
      if (timer) clearTimeout(timer);
      this.timers.set(projectId, setTimeout(() => {
        this.timers.delete(projectId);
        void this.run(projectId);
      }, this.debounceMs));
    }).catch((error) => {
      if (this.scheduleEpochs.get(projectId) !== epoch) return;
      const previous = this.states.get(projectId) ?? blankState(projectId);
      this.states.set(projectId, {
        ...previous, schemaVersion: 2, projectId, phase: "failed", error: String(error),
      });
    });
  }

  retry(projectId: string): void {
    this.states.delete(projectId);
    this.ledgerBuilds.delete(projectId);
    this.schedule(projectId);
  }

  async ensure(projectId: string): Promise<EditPreviewArtifactState> {
    const current = await this.status(projectId);
    if (current.phase === "stale" || current.phase === "pending") this.schedule(projectId);
    return this.states.get(projectId) ?? current;
  }

  private async run(projectId: string): Promise<void> {
    if (this.running.has(projectId)) return;
    const promise = this.runLoop(projectId).finally(() => this.running.delete(projectId));
    this.running.set(projectId, promise);
    await promise;
  }

  private async runLoop(projectId: string): Promise<void> {
    while (true) {
      const input = await this.readProjectInput(this.projectsDir, projectId);
      const revision = input.editRevision;
      const runEpoch = this.publishEpochs.get(projectId) ?? 0;
      this.desired.set(projectId, this.desired.get(projectId) ?? revision);
      const cacheKey = expectedCacheKeyForInput(input);
      const artifactDir = join(input.projectDir, ".chengfeng-videocut", "preview-edited");
      const relativeSource = expectedRelativeSource(cacheKey);
      const output = join(input.projectDir, relativeSource);
      const manifest = join(artifactDir, "current.json");
      await mkdir(artifactDir, { recursive: true });
      const started = this.now();
      let temporaryManifest: string | null = null;
      let temporaryOutput: string | null = null;
      const cleanupTemporaryOutput = async () => {
        if (!temporaryOutput) return;
        await rm(temporaryOutput, { force: true }).catch(() => undefined);
        temporaryOutput = null;
      };
      try {
        const validate = async (path: string) => {
          const { info, media } = await cachedArtifactProbe(path, this.probe);
          if (!info.isFile()) throw new Error(`Preview artifact is not a file: ${path}`);
          assertArtifactQuality(input, media);
          return { info, media };
        };
        const trustedCurrent = await this.readTrustedCurrentManifest(input, cacheKey).catch(() => null);
        if (trustedCurrent) {
          this.states.set(projectId, trustedCurrent);
          return;
        }
        const cachedOutput = await validate(output).catch(() => null);
        if (cachedOutput) {
          const publishResult = await this.serializeProjectOperation(input.projectDir, async () => {
            const publishInput = await this.readProjectInput(this.projectsDir, projectId);
            const publishCacheKey = expectedCacheKeyForInput(publishInput);
            if (
              publishInput.editRevision !== revision ||
              publishCacheKey !== cacheKey ||
              this.desired.get(projectId) !== revision ||
              this.publishEpochs.get(projectId) !== runEpoch
            ) return { published: false, input: publishInput };
            const trustedPublished = await this.readTrustedCurrentManifest(publishInput, cacheKey).catch(() => null);
            if (trustedPublished) return { published: true, input: publishInput, state: trustedPublished };
            const validated = await validate(output);
            const next: EditPreviewArtifactState = {
              schemaVersion: 2, projectId, phase: "current", editRevision: revision,
              artifactRevision: revision, cacheKey, sourceSha256: input.sourceSha256,
              source: relativeSource, duration: validated.media.duration, byteLength: validated.info.size,
              hasVideo: validated.media.hasVideo, hasAudio: validated.media.hasAudio,
              profile: input.previewProfile ?? "fast-proxy-v1",
              sourceKind: input.sourceKind ?? "fast-proxy",
              sourceFrameRate: input.previewFrameRate,
              width: validated.media.width, height: validated.media.height,
              videoBitrate: validated.media.videoBitrate,
              generatedAt: new Date(this.now()).toISOString(), generationMs: this.now() - started, stream: null, error: null,
            };
            temporaryManifest = `${manifest}.tmp-${process.pid}-${this.now()}`;
            await writeFile(temporaryManifest, `${JSON.stringify(next, null, 2)}\n`);
            await rename(temporaryManifest, manifest);
            temporaryManifest = null;
            return { published: true, input: publishInput, state: next };
          });
          if (publishResult.published && publishResult.state) {
            this.states.set(projectId, publishResult.state);
            return;
          }
          if (publishResult.input.editRevision !== revision) {
            this.desired.set(projectId, publishResult.input.editRevision);
            continue;
          }
        }
        temporaryOutput = writerTempOutput(output);
        await this.generate({
          input: input.sourceProxy,
          output: temporaryOutput,
          frameRate: input.previewFrameRate,
          profile: input.previewProfile ?? "fast-proxy-v1",
          segments: input.segments,
        });
        let validated: Awaited<ReturnType<typeof validate>>;
        try {
          validated = await validate(temporaryOutput);
        } catch (error) {
          await rm(temporaryOutput, { force: true }).catch(() => undefined);
          temporaryOutput = null;
          throw error;
        }
        const currentInput = await this.readProjectInput(this.projectsDir, projectId);
        const currentCacheKey = expectedCacheKeyForInput(currentInput);
        if (
          currentInput.editRevision !== revision ||
          currentCacheKey !== cacheKey ||
          this.desired.get(projectId) !== revision ||
          this.publishEpochs.get(projectId) !== runEpoch
        ) {
          await cleanupTemporaryOutput();
          if (currentInput.editRevision !== revision) this.desired.set(projectId, currentInput.editRevision);
          continue;
        }
        const publishResult = await this.serializeProjectOperation(input.projectDir, async () => {
          const publishInput = await this.readProjectInput(this.projectsDir, projectId);
          const publishCacheKey = expectedCacheKeyForInput(publishInput);
          if (
            publishInput.editRevision !== revision ||
            publishCacheKey !== cacheKey ||
            this.desired.get(projectId) !== revision ||
            this.publishEpochs.get(projectId) !== runEpoch
          ) {
            return { published: false, input: publishInput };
          }
          const trustedPublished = await this.readTrustedCurrentManifest(publishInput, cacheKey).catch(() => null);
          if (trustedPublished) {
            await cleanupTemporaryOutput();
            return { published: true, input: publishInput, state: trustedPublished };
          }
          if (!temporaryOutput) throw new Error("Preview artifact writer temp is unavailable");
          await rename(temporaryOutput, output);
          temporaryOutput = null;
          const publishValidated = await validate(output);
          const finalInput = await this.readProjectInput(this.projectsDir, projectId);
          const finalCacheKey = expectedCacheKeyForInput(finalInput);
          if (
            finalInput.editRevision !== revision ||
            finalCacheKey !== cacheKey ||
            this.desired.get(projectId) !== revision ||
            this.publishEpochs.get(projectId) !== runEpoch
          ) {
            return { published: false, input: finalInput };
          }
          const next: EditPreviewArtifactState = {
            schemaVersion: 2, projectId, phase: "current", editRevision: revision,
            artifactRevision: revision, cacheKey, sourceSha256: input.sourceSha256,
            source: relativeSource, duration: publishValidated.media.duration, byteLength: publishValidated.info.size,
            hasVideo: publishValidated.media.hasVideo, hasAudio: publishValidated.media.hasAudio,
            profile: input.previewProfile ?? "fast-proxy-v1",
            sourceKind: input.sourceKind ?? "fast-proxy",
            sourceFrameRate: input.previewFrameRate,
            width: publishValidated.media.width, height: publishValidated.media.height,
            videoBitrate: publishValidated.media.videoBitrate,
            generatedAt: new Date(this.now()).toISOString(),
            generationMs: this.now() - started, stream: null, error: null,
          };
          temporaryManifest = `${manifest}.tmp-${process.pid}-${this.now()}`;
          await writeFile(temporaryManifest, `${JSON.stringify(next, null, 2)}\n`);
          await rename(temporaryManifest!, manifest);
          temporaryManifest = null;
          return { published: true, input: publishInput, state: next };
        });
        if (!publishResult.published) {
          if (temporaryManifest) await rm(temporaryManifest, { force: true }).catch(() => undefined);
          temporaryManifest = null;
          await cleanupTemporaryOutput();
          if (publishResult.input.editRevision !== revision) {
            this.desired.set(projectId, publishResult.input.editRevision);
          }
          continue;
        }
        if (!publishResult.state) throw new Error("Preview artifact publish did not return a current state");
        this.states.set(projectId, publishResult.state);
        // Bound the cache. Never remove the artifact just published, nor the one
        // the manifest points at — those two can differ for a moment while a
        // concurrent reader still holds the old manifest.
        await pruneEncodedArtifacts(artifactDir, [
          basename(String(publishResult.state.source ?? "")),
          basename(relativeSource),
        ].filter(Boolean));
        return;
      } catch (error) {
        const previous = this.states.get(projectId) ?? blankState(projectId, revision);
        this.states.set(projectId, {
          ...previous, schemaVersion: 2, projectId, phase: "failed", editRevision: revision,
          cacheKey, sourceSha256: input.sourceSha256,
          profile: input.previewProfile ?? "fast-proxy-v1",
          sourceKind: input.sourceKind ?? "fast-proxy",
          sourceFrameRate: input.previewFrameRate,
          error: error instanceof Error ? error.message : String(error),
        });
        if (temporaryManifest) await rm(temporaryManifest, { force: true }).catch(() => undefined);
        await cleanupTemporaryOutput();
        return;
      }
    }
  }
}

export function createEditPreviewArtifactHandler(manager: EditPreviewArtifactManager) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const match = /^\/api\/v1\/projects\/([^/]+)\/preview-artifact$/.exec(url.pathname);
    if (!match) return null;
    if (request.method !== "GET" && request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let projectId: string;
    try {
      projectId = decodeURIComponent(match[1]);
      assertSafeProjectId(projectId);
    } catch {
      return Response.json({ error: "invalid_project_id" }, { status: 400 });
    }
    try {
      if (request.method === "POST") manager.retry(projectId);
      const state = await manager.ensure(projectId);
      return Response.json(state, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = String(error);
      // 常驻服务的环境变量是进程启动那一刻的快照：ffmpeg 装晚了，服务进程
      // 就一直看不见它——doctor 在终端里全绿也一样（Issue #3 真机根因）。
      if (/uv_spawn|ENOENT/.test(message) && /ffmpeg|ffprobe/.test(message)) {
        return Response.json({
          error: "media_tools_missing",
          message: `服务进程找不到 ffmpeg/ffprobe（${message}）。` +
            `如果终端里 ffmpeg 可用，说明服务是在安装 ffmpeg 之前启动的：` +
            `运行 chengfeng-videocut service restart 让服务读到新环境。`,
        }, { status: 500 });
      }
      return Response.json({ error: "preview_artifact_error", message }, { status: 500 });
    }
  };
}
