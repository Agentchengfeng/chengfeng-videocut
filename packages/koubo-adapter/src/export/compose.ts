/**
 * The film, assembled.
 *
 * Two passes, and the split is not an implementation detail — it is what makes
 * the export inspectable. The first pass answers "what does the cut look
 * like"; the second answers "what is drawn on it and how big is the film".
 * When something is wrong you can play the intermediate and know immediately
 * which half owns the fault.
 *
 * ```text
 * ① 拼底片   按账本把源片的 41 段接成一条 —— 只切，不缩放、不盖东西
 * ② 合成    推近（硬切区间 crop）→ 放大到输出尺寸 → 盖上逐帧画好的 PNG → 编码
 * ```
 *
 * The intermediate is encoded at CRF 10 in the source's own pixel format. It
 * is re-encoded once more in the second pass, and two lossy generations is one
 * more than anyone wants — CRF 10 is where the first one stops being visible.
 * Nothing is scaled in pass one for the same reason: resampling twice is worse
 * than resampling once, so the only scale in the whole export is the one that
 * lands on the output frame.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExportPlan } from "@video-workbench/core";
import { cropRectForBox } from "@video-workbench/core";
import { orderedSegmentManifest, probeMedia, type MediaProbe } from "../mediaCut";

/**
 * How hard the final encoder tries.
 *
 * This is the only encode a viewer ever sees, and it runs once per finished
 * film rather than on every preview, so it is worth the slow preset. CRF 16 on
 * a screen recording is well past the point where re-encoding shows; the
 * previous export re-encoded at *the source's own bitrate*, which cannot
 * preserve the source and reliably made white-background text mushier than the
 * original.
 */
const FINAL_CRF = "16";
const FINAL_PRESET = "slow";
const FINAL_AUDIO_BITRATE = "256k";
/** Near-transparent, so the second generation starts from what the cut was. */
const INTERMEDIATE_CRF = "10";

export interface FfmpegRunOptions {
  onLine?: (line: string) => void;
}

export async function runFfmpeg(args: string[], options: FfmpegRunOptions = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      tail = `${tail}${chunk}`.slice(-8000);
      if (options.onLine) for (const line of chunk.split(/\r?\n/)) if (line.trim()) options.onLine(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code ?? "signal"}): ${tail.trim().slice(-3000)}`));
    });
  });
}

function seconds(value: number): string {
  return value.toFixed(6);
}

/**
 * Pass one: the cut, at source size, with sound.
 *
 * The concat demuxer decides the order and `concatdec_select` drops the frames
 * outside each declared window, so the whole film is decoded once instead of
 * once per retained span. Matroska rather than MP4 because the audio is kept
 * lossless here — it is encoded exactly once, in pass two, and a codec round
 * trip per pass is a real thing to give away.
 */
export async function assembleCut(input: {
  source: string;
  output: string;
  plan: ExportPlan;
  onLine?: (line: string) => void;
}): Promise<void> {
  const { plan } = input;
  await mkdir(dirname(input.output), { recursive: true });
  const manifestPath = `${input.output}.ffconcat`;
  await writeFile(
    manifestPath,
    orderedSegmentManifest(input.source, plan.spans.map((span) => ({
      start: span.sourceStart,
      end: span.sourceEnd,
    }))),
    "utf8",
  );
  await runFfmpeg([
    "-y", "-v", "error",
    "-copyts", "-segment_time_metadata", "1",
    "-f", "concat", "-safe", "0", "-i", manifestPath,
    "-i", `file:${input.source}`,
    "-filter_complex",
    [
      "[0:v:0]select=concatdec_select,setpts=PTS-STARTPTS[outv]",
      // Audio is assembled from the original rather than from the concat
      // demuxer: video-frame boundaries round, and rounding a picture is a
      // picture while rounding a sample is a click between every two spans.
      audioFilter(plan),
    ].join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", INTERMEDIATE_CRF,
    "-pix_fmt", "yuv420p",
    "-fps_mode", "cfr", "-r", String(plan.fps),
    "-c:a", "flac",
    "-t", seconds(plan.frameCount / plan.fps),
    `file:${input.output}`,
  ], { onLine: input.onLine });
}

function audioFilter(plan: ExportPlan): string {
  const spans = plan.spans;
  if (spans.length === 1) {
    const span = spans[0]!;
    return `[1:a:0]asetpts=PTS-STARTPTS,atrim=start=${seconds(span.sourceStart)}:end=${seconds(span.sourceEnd)},asetpts=PTS-STARTPTS[outa]`;
  }
  const parts = [
    `[1:a:0]asetpts=PTS-STARTPTS,asplit=${spans.length}${spans.map((_, index) => `[asrc${index}]`).join("")}`,
  ];
  spans.forEach((span, index) => {
    parts.push(
      `[asrc${index}]atrim=start=${seconds(span.sourceStart)}:end=${seconds(span.sourceEnd)},asetpts=PTS-STARTPTS[a${index}]`,
    );
  });
  parts.push(
    `${spans.map((_, index) => `[a${index}]`).join("")}concat=n=${spans.length}:v=0:a=1[outa]`,
  );
  return parts.join(";");
}

/**
 * Pass two: push in, scale up, lay the drawings on, encode.
 *
 * One ffmpeg per push-in span, joined afterwards, rather than one command that
 * assembles all the spans in a single filter graph. Both of the obvious
 * single-command shapes are traps, and both were tried:
 *
 * ```text
 * split + trim + concat   concat pulls its branches in order, so every later
 *                        branch holds every frame handed to it until its turn
 *                        —— 整片解码后堆在内存里
 * 多个 -i + concat        没有内存问题，但会死锁：前几段编完之后整个进程
 *                        停在 0% CPU，所有线程等在条件变量上（真发生过，
 *                        2026-07-29 第一次冒烟测试）
 * ```
 *
 * A span at a time is boring, and boring is the point: each command is one
 * input, one linear chain, one output. When a span comes out wrong you can
 * play that span.
 *
 * The order of operations inside a span is the preview's order, and it has to
 * be:
 *
 * ```text
 * 推近   只作用在录屏上 —— 模块自己按 zoom 调 viewBox，画出来的东西已经在放大后的位置
 * 放大   一次性缩到输出尺寸
 * 盖层   字幕和模块画在输出画面上，不跟着推近走
 * ```
 */
export async function composeFilm(input: {
  assembled: string;
  /** Null when nothing is written and nothing is drawn: the footage stands alone. */
  framePattern: string | null;
  output: string;
  workDirectory: string;
  plan: ExportPlan;
  onSpan?: (done: number, total: number) => void;
  onLine?: (line: string) => void;
}): Promise<void> {
  const { plan } = input;
  await mkdir(dirname(input.output), { recursive: true });
  await mkdir(input.workDirectory, { recursive: true });

  const spanFiles: string[] = [];
  for (const [index, span] of plan.zoomSpans.entries()) {
    const count = span.endFrame - span.startFrame;
    const spanFile = join(input.workDirectory, `span-${String(index).padStart(3, "0")}.mp4`);
    const steps = [`fps=${plan.fps}`];
    if (span.box) {
      const crop = cropRectForBox(span.box, plan.source);
      steps.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    }
    // Lanczos on the way up: the frame is 960 pixels of small white-background
    // type, and a softer kernel spends the extra resolution on nothing.
    steps.push(`scale=${plan.output.width}:${plan.output.height}:flags=lanczos`, "setsar=1");
    await runFfmpeg([
      "-y", "-v", "error",
      "-ss", seconds(span.startFrame / plan.fps),
      "-t", seconds(count / plan.fps),
      "-i", `file:${input.assembled}`,
      // The overlay frames for exactly this span, addressed by their own
      // numbers — the PNG index *is* the film's frame index, so a span can
      // never be handed the wrong drawings.
      ...(input.framePattern
        ? [
            "-framerate", String(plan.fps),
            "-start_number", String(span.startFrame),
            "-i", input.framePattern,
          ]
        : []),
      "-filter_complex", (input.framePattern
        ? [
            `[0:v]${steps.join(",")}[base]`,
            "[1:v]format=rgba,setsar=1[ovl]",
            // `eof_action=pass` so a missing tail frame leaves the footage
            // alone rather than ending the span early.
            "[base][ovl]overlay=x=0:y=0:format=auto:eof_action=pass[outv]",
          ]
        : [`[0:v]${steps.join(",")}[outv]`]).join(";"),
      "-map", "[outv]", "-an",
      "-c:v", "libx264", "-preset", FINAL_PRESET, "-crf", FINAL_CRF,
      "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-fps_mode", "cfr", "-r", String(plan.fps),
      // The span must be exactly as long as it was planned to be. One frame of
      // drift here slides every drawing after it off the words it belongs to.
      "-frames:v", String(count),
      `file:${spanFile}`,
    ], { onLine: input.onLine });
    spanFiles.push(spanFile);
    input.onSpan?.(index + 1, plan.zoomSpans.length);
  }

  // Joined without re-encoding: the spans were produced by one encoder with one
  // set of parameters, so the join is a container operation and the picture is
  // untouched. The sound comes from the assembled cut, encoded exactly once.
  const listPath = join(input.workDirectory, "spans.ffconcat");
  await writeFile(
    listPath,
    `ffconcat version 1.0\n${spanFiles.map((path) => `file '${concatPath(path)}'`).join("\n")}\n`,
    "utf8",
  );
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-i", `file:${input.assembled}`,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", FINAL_AUDIO_BITRATE,
    // No `-shortest`. The sound ends on a sample boundary a few milliseconds
    // before the last picture, and `-shortest` resolved that by dropping a
    // frame — the film came out 5012 pictures long when the plan said 5013.
    // Nobody would ever see it; that is exactly why it has to be caught here
    // rather than trusted to stay harmless.
    "-movflags", "+faststart",
    `file:${input.output}`,
  ], { onLine: input.onLine });
}

function concatPath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll("'", "'\\''");
}

/**
 * What the finished file actually turned out to be, read back off the disk.
 *
 * The frame count is counted, not inferred from the duration. A tolerance on
 * seconds is exactly the check that lets a single dropped picture through, and
 * a single dropped picture is how a film starts sliding against its own
 * overlay — the plan says how many pictures this film is, so the file has to
 * have that many.
 */
export async function verifyFilm(path: string, plan: ExportPlan): Promise<{
  probe: MediaProbe;
  frames: number;
  problems: string[];
}> {
  const probe = await probeMedia(path);
  const frames = await countVideoFrames(path);
  const problems: string[] = [];
  if (!probe.hasVideo) problems.push("成片没有视频轨");
  if (!probe.hasAudio) problems.push("成片没有音频轨");
  if (probe.width !== plan.output.width || probe.height !== plan.output.height) {
    problems.push(`成片尺寸是 ${probe.width}×${probe.height}，计划是 ${plan.output.width}×${plan.output.height}`);
  }
  if (frames !== plan.frameCount) {
    problems.push(`成片是 ${frames} 帧，计划是 ${plan.frameCount} 帧`);
  }
  return { probe, frames, problems };
}

async function countVideoFrames(path: string): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames",
      "-of", "csv=p=0",
      `file:${path}`,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  const count = Number(output.trim());
  return Number.isFinite(count) ? count : -1;
}

export function intermediatePath(workDirectory: string): string {
  return join(workDirectory, "assembled.mkv");
}
