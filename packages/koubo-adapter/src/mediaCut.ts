import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EDIT_LIST_MIN_SEGMENT_SECONDS, ffmpegFileArg, ffmpegOutputArgs } from "@video-workbench/core";

export interface MediaCutRange {
  start: number;
  end: number;
}

export interface MediaProbe {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoBitrate: number;
  videoProfile: string;
  pixelFormat: string;
  width: number;
  height: number;
  frameRate?: number;
}

export interface MediaCutResult {
  input: string;
  output: string;
  originalDuration: number;
  newDuration: number;
  deletedDuration: number;
  savedPercent: number;
  cutRanges: MediaCutRange[];
  keepSegments: MediaCutRange[];
  hasAudio: boolean;
  width: number;
  height: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function runCommand(
  command: string,
  args: string[],
  options: { inheritStderr?: boolean } = {},
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", options.inheritStderr ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!child.stdout) {
      reject(new Error(`${command} did not expose stdout`));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(
        `${command} failed (${code ?? "signal"})${stderr ? `: ${stderr.trim().slice(-3000)}` : ""}`,
      ));
    });
  });
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rational(value: unknown): number {
  const text = String(value ?? "");
  const [numerator, denominator] = text.split("/").map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) return numerator / denominator;
  return finite(text, 0);
}

/**
 * 视频流声明的显示旋转（度）。手机竖拍存储为横向帧 + display matrix
 * （现代文件在 side_data_list.rotation；老文件在 tags.rotate）。
 */
function displayRotation(video: Record<string, unknown> | undefined): number {
  if (!video) return 0;
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  for (const entry of sideData) {
    if (entry && typeof entry === "object" && "rotation" in entry) {
      const rotation = finite((entry as Record<string, unknown>).rotation);
      if (rotation !== 0) return rotation;
    }
  }
  const tags = video.tags && typeof video.tags === "object" ? video.tags as Record<string, unknown> : {};
  return finite(tags.rotate);
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const { stdout } = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration:stream=codec_type,bit_rate,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate"
      + ":stream_side_data=rotation:stream_tags=rotate",
    "-of", "json",
    ffmpegFileArg(path),
  ]);
  const payload = JSON.parse(stdout) as {
    format?: { duration?: string | number };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  // 宽高按**显示方向**报告：ffmpeg 转码时自动应用旋转，播放器渲染时也应用，
  // 所以存储坐标在整个产品里没有任何消费者。不归一化的话，手机竖拍
  // （1920×1080 + rotate 90）会推导出横屏画幅、生成横屏期望，再拦下
  // 自己转出来的竖屏预览——2026-08-04 用户真机 Sharp 校验失败正是这条链。
  const storedWidth = Math.max(0, finite(video?.width));
  const storedHeight = Math.max(0, finite(video?.height));
  const quarterTurned = Math.abs(displayRotation(video)) % 180 === 90;
  return {
    duration: Math.max(0, finite(payload.format?.duration)),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoBitrate: Math.max(0, finite(video?.bit_rate)),
    videoProfile: String(video?.profile ?? "high").toLowerCase(),
    pixelFormat: String(video?.pix_fmt ?? "yuv420p"),
    width: quarterTurned ? storedHeight : storedWidth,
    height: quarterTurned ? storedWidth : storedHeight,
    frameRate: Math.max(0, rational(video?.avg_frame_rate) || rational(video?.r_frame_rate)),
  };
}

export function mergeCutRanges(
  ranges: readonly MediaCutRange[],
  duration: number,
  mergeGap = 0.2,
): MediaCutRange[] {
  const normalized = ranges.map((range, index) => {
    const start = Math.max(0, Math.min(duration, finite(range.start, -1)));
    const end = Math.max(0, Math.min(duration, finite(range.end, -1)));
    if (start < 0 || end <= start) throw new Error(`Invalid cut range #${index}`);
    return { start, end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MediaCutRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + mergeGap) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function keepSegmentsForCuts(
  ranges: readonly MediaCutRange[],
  duration: number,
): MediaCutRange[] {
  const keep: MediaCutRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor + 0.001) keep.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration - 0.001) keep.push({ start: cursor, end: duration });
  return keep.filter((segment) => segment.end - segment.start >= 0.01);
}

/**
 * Validates source ranges without sorting them. Their input order is the
 * authored edit-list order and therefore part of the exported video meaning.
 */
export function normalizeOrderedMediaSegments(
  segments: readonly MediaCutRange[],
  duration: number,
): MediaCutRange[] {
  if (!(duration > 0)) throw new Error("Source duration must be positive");
  if (segments.length === 0) throw new Error("Edit list must retain at least one segment");
  return segments.map((segment, index) => {
    const start = finite(segment.start, -1);
    const end = finite(segment.end, -1);
    if (
      start < 0 ||
      end > duration + 0.001 ||
      end - start < EDIT_LIST_MIN_SEGMENT_SECONDS - 0.001
    ) {
      throw new Error(`Invalid edit-list segment #${index}`);
    }
    return {
      start: Math.min(duration, start),
      end: Math.min(duration, end),
    };
  });
}

function x264Profile(value: string): string {
  if (value.includes("baseline")) return "baseline";
  if (value.includes("main")) return "main";
  return "high";
}

function filterTime(value: number): string {
  return value.toFixed(6);
}

function concatFilePath(path: string): string {
  return resolve(path).replaceAll("\\", "\\\\").replaceAll("'", "'\\''");
}

/** Exported for the film export, which assembles the same spans in the same order. */
export function orderedSegmentManifest(
  source: string,
  segments: readonly MediaCutRange[],
): string {
  const escapedSource = concatFilePath(source);
  const entries = segments.map((segment) => [
    `file '${escapedSource}'`,
    `inpoint ${filterTime(segment.start)}`,
    `outpoint ${filterTime(segment.end)}`,
  ].join("\n"));
  return `ffconcat version 1.0\n${entries.join("\n")}\n`;
}

/**
 * Video order comes from the concat demuxer and concatdec_select excludes frames
 * outside each declared inpoint/outpoint window, without buffering one decoded
 * video copy per EDL segment. Audio remains decoded PCM inside this graph and
 * reaches exactly one output AAC encoder, so encoder priming/padding cannot
 * accumulate once per retained segment.
 *
 * Video and audio are assembled independently. This prevents video-frame
 * boundary rounding from inserting silence between sample-accurate audio trims.
 */
function orderedSegmentFilter(
  segments: readonly MediaCutRange[],
  hasAudio: boolean,
): string {
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

async function renderVideoSegments(input: {
  input: string;
  output: string;
  sourceProbe: MediaProbe;
  cutRanges: readonly MediaCutRange[];
  keepSegments: readonly MediaCutRange[];
  concurrency?: number;
}): Promise<MediaCutResult> {
  const { sourceProbe } = input;
  const cutRanges = input.cutRanges.map((range) => ({ ...range }));
  const keepSegments = input.keepSegments.map((segment) => ({ ...segment }));
  await mkdir(dirname(input.output), { recursive: true });
  const temporaryOutput = `${input.output}.tmp-${process.pid}-${Date.now()}.mp4`;
  const workDir = await mkdtemp(join(tmpdir(), "chengfeng-videocut-cut-"));
  try {
    const isWholeSource = keepSegments.length === 1 &&
      keepSegments[0].start <= 0.001 &&
      keepSegments[0].end >= sourceProbe.duration - 0.001;
    if (isWholeSource) {
      await runCommand("ffmpeg", [
        "-y", "-v", "error", "-i", ffmpegFileArg(input.input), "-map", "0", "-c", "copy",
        "-movflags", "+faststart", ...ffmpegOutputArgs("mp4", temporaryOutput),
      ]);
    } else {
      const bitrateK = sourceProbe.videoBitrate > 0
        ? Math.max(200, Math.round(sourceProbe.videoBitrate / 1000))
        : 0;
      const videoArgs = bitrateK > 0
        ? [
            "-b:v", `${bitrateK}k`,
            "-maxrate", `${Math.round(bitrateK * 1.3)}k`,
            "-bufsize", `${bitrateK * 2}k`,
          ]
        : ["-crf", "18"];
      const filterPath = join(workDir, "ordered-edl-filter.txt");
      const concatPath = join(workDir, "ordered-edl.ffconcat");
      await writeFile(
        concatPath,
        orderedSegmentManifest(input.input, keepSegments),
        "utf8",
      );
      await writeFile(
        filterPath,
        orderedSegmentFilter(keepSegments, sourceProbe.hasAudio),
        "utf8",
      );
      const expectedDuration = keepSegments.reduce(
        (total, segment) => total + segment.end - segment.start,
        0,
      );
      await runCommand("ffmpeg", [
        "-y", "-v", "error",
        "-copyts", "-segment_time_metadata", "1",
        "-f", "concat", "-safe", "0", "-i", concatPath,
        ...(sourceProbe.hasAudio ? ["-i", ffmpegFileArg(input.input)] : []),
        "-filter_complex_script", filterPath,
        "-map", "[outv]",
        ...(sourceProbe.hasAudio ? ["-map", "[outa]"] : []),
        "-c:v", "libx264", "-profile:v", x264Profile(sourceProbe.videoProfile),
        ...videoArgs,
        "-pix_fmt", sourceProbe.pixelFormat,
        ...(sourceProbe.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : []),
        "-t", filterTime(expectedDuration),
        "-movflags", "+faststart",
        ...ffmpegOutputArgs("mp4", temporaryOutput),
      ]);
    }
    const outputProbe = await probeMedia(temporaryOutput);
    if (!outputProbe.hasVideo || !(outputProbe.duration > 0)) {
      throw new Error("FFmpeg produced an invalid cut video");
    }
    if (sourceProbe.hasAudio && !outputProbe.hasAudio) {
      throw new Error("Cut video lost the source audio stream");
    }
    await rename(temporaryOutput, input.output);
    const deletedDuration = Math.max(0, sourceProbe.duration - outputProbe.duration);
    return {
      input: input.input,
      output: input.output,
      originalDuration: sourceProbe.duration,
      newDuration: outputProbe.duration,
      deletedDuration,
      savedPercent: sourceProbe.duration > 0 ? deletedDuration / sourceProbe.duration * 100 : 0,
      cutRanges,
      keepSegments,
      hasAudio: outputProbe.hasAudio,
      width: outputProbe.width,
      height: outputProbe.height,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(temporaryOutput, { force: true });
  }
}

export async function cutVideoByRanges(input: {
  input: string;
  output: string;
  ranges: readonly MediaCutRange[];
  concurrency?: number;
}): Promise<MediaCutResult> {
  const sourceProbe = await probeMedia(input.input);
  if (!sourceProbe.hasVideo || !(sourceProbe.duration > 0)) {
    throw new Error(`Input is not a readable video: ${input.input}`);
  }
  const cutRanges = mergeCutRanges(input.ranges, sourceProbe.duration);
  const keepSegments = keepSegmentsForCuts(cutRanges, sourceProbe.duration);
  if (keepSegments.length === 0) throw new Error("Cut selection would remove the entire video");
  return renderVideoSegments({
    ...input,
    sourceProbe,
    cutRanges,
    keepSegments,
  });
}

/** Exports the authored EDL order instead of re-deriving order from cut ranges. */
export async function cutVideoBySegments(input: {
  input: string;
  output: string;
  segments: readonly MediaCutRange[];
  cutRanges?: readonly MediaCutRange[];
  concurrency?: number;
}): Promise<MediaCutResult> {
  const sourceProbe = await probeMedia(input.input);
  if (!sourceProbe.hasVideo || !(sourceProbe.duration > 0)) {
    throw new Error(`Input is not a readable video: ${input.input}`);
  }
  return renderVideoSegments({
    input: input.input,
    output: input.output,
    sourceProbe,
    cutRanges: input.cutRanges
      ? mergeCutRanges(input.cutRanges, sourceProbe.duration)
      : [],
    keepSegments: normalizeOrderedMediaSegments(input.segments, sourceProbe.duration),
    concurrency: input.concurrency,
  });
}

export async function readCutRanges(path: string): Promise<MediaCutRange[]> {
  const payload = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("cut-selection.json must be an object");
  }
  const ranges = (payload as Record<string, unknown>).cutRanges;
  if (!Array.isArray(ranges)) return [];
  return ranges.map((range) => {
    if (!range || typeof range !== "object" || Array.isArray(range)) {
      throw new Error("cutRanges entries must be objects");
    }
    return {
      start: finite((range as Record<string, unknown>).start, -1),
      end: finite((range as Record<string, unknown>).end, -1),
    };
  });
}
