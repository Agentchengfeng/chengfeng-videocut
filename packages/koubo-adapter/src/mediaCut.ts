import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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

export async function probeMedia(path: string): Promise<MediaProbe> {
  const { stdout } = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration:stream=codec_type,bit_rate,profile,pix_fmt,width,height",
    "-of", "json",
    `file:${path}`,
  ]);
  const payload = JSON.parse(stdout) as {
    format?: { duration?: string | number };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    duration: Math.max(0, finite(payload.format?.duration)),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoBitrate: Math.max(0, finite(video?.bit_rate)),
    videoProfile: String(video?.profile ?? "high").toLowerCase(),
    pixelFormat: String(video?.pix_fmt ?? "yuv420p"),
    width: Math.max(0, finite(video?.width)),
    height: Math.max(0, finite(video?.height)),
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

function x264Profile(value: string): string {
  if (value.includes("baseline")) return "baseline";
  if (value.includes("main")) return "main";
  return "high";
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, values.length)) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        await task(values[index], index);
      }
    },
  );
  await Promise.all(workers);
}

function concatPath(path: string): string {
  return path.replaceAll("'", "'\\''");
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
  await mkdir(dirname(input.output), { recursive: true });
  const temporaryOutput = `${input.output}.tmp-${process.pid}-${Date.now()}.mp4`;
  const workDir = await mkdtemp(join(tmpdir(), "chengfeng-videocut-cut-"));
  try {
    if (cutRanges.length === 0) {
      await runCommand("ffmpeg", [
        "-y", "-v", "error", "-i", `file:${input.input}`, "-map", "0", "-c", "copy",
        "-movflags", "+faststart", `file:${temporaryOutput}`,
      ]);
    } else {
      const segmentPaths = keepSegments.map((_, index) =>
        join(workDir, `segment-${String(index).padStart(5, "0")}.mp4`));
      const bitrateK = sourceProbe.videoBitrate > 0
        ? Math.max(200, Math.round(sourceProbe.videoBitrate / 1000))
        : 0;
      await mapConcurrent(
        keepSegments,
        input.concurrency ?? 4,
        async (segment, index) => {
          const videoArgs = bitrateK > 0
            ? [
                "-b:v", `${bitrateK}k`,
                "-maxrate", `${Math.round(bitrateK * 1.3)}k`,
                "-bufsize", `${bitrateK * 2}k`,
              ]
            : ["-crf", "18"];
          await runCommand("ffmpeg", [
            "-y", "-v", "error",
            "-ss", segment.start.toFixed(3),
            "-to", segment.end.toFixed(3),
            "-accurate_seek", "-i", `file:${input.input}`,
            "-map", "0:v:0", "-map", "0:a?",
            "-c:v", "libx264", "-profile:v", x264Profile(sourceProbe.videoProfile),
            ...videoArgs,
            "-pix_fmt", sourceProbe.pixelFormat,
            "-c:a", "aac", "-b:a", "128k",
            "-avoid_negative_ts", "make_zero",
            `file:${segmentPaths[index]}`,
          ]);
        },
      );
      const concatFile = join(workDir, "concat.txt");
      await writeFile(
        concatFile,
        `${segmentPaths.map((path) => `file '${concatPath(path)}'`).join("\n")}\n`,
        "utf8",
      );
      await runCommand("ffmpeg", [
        "-y", "-v", "error", "-f", "concat", "-safe", "0",
        "-i", concatFile, "-c", "copy", "-movflags", "+faststart",
        `file:${temporaryOutput}`,
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
