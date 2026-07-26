/// <reference types="node" />

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Media for playback that never seeks.
 *
 * The first approach played the whole proxy and jumped `currentTime` at every
 * retained boundary. Every measurement said it was clean — zero dropped frames, a
 * single contiguous buffered range, 0–1ms stalls, exact landing positions — and it
 * was audibly broken: setting `currentTime` stops the decoder, not the sound, so
 * the 150–400ms already handed to the sound card played on. What sits immediately
 * after a retained boundary is always deleted content, so every seam leaked deleted
 * speech. Only a person listening caught it.
 *
 * So the retained ranges are assembled into one continuous stream before the player
 * ever sees them, and there is nothing left to jump over.
 *
 * ## Why a fixed grid, and not a fragment per range
 *
 * Cutting one fragment per retained range meant an edit ran ffmpeg, and ffmpeg had
 * to open the whole proxy. That open is nearly free while the file is still in the
 * page cache and expensive when it is not — measured at 2.4s on an external USB
 * disk, which is where these projects actually live. So every edit after a pause
 * froze the app for a second or two, unpredictably, for work the user could not see.
 *
 * The proxy is therefore sliced once, on a fixed ~2s grid, and never sliced again.
 * A retained range is then expressed as *whole grid chunks plus a trim window* —
 * arithmetic, not media work. An edit runs no subprocess and reads no large file,
 * so its cost no longer depends on how fast the user's disk is or on what happens
 * to be cached. Slicing costs one pass over the proxy (~0.15s warm) and the chunks
 * together take the same space the single rewrapped copy used to.
 *
 * This is what streaming players do, for the same reason.
 */

const STREAM_DIRECTORY = "preview-stream" as const;
const CHUNK_INDEX_SUFFIX = ".chunks.json" as const;
/** Grid pitch. Small enough that a range wastes little, large enough to keep the count sane. */
const CHUNK_SECONDS = 2;

export interface PreviewStreamSegment {
  /** Project-relative path of the chunk, servable by the preview media route. */
  source: string;
  /**
   * Where this chunk's own timeline zero lands on the assembled timeline.
   *
   * Chunks are cut with reset timestamps, so each one starts at zero regardless of
   * where it sits in the proxy. This is negative whenever a chunk starts before the
   * retained range it serves.
   */
  offset: number;
  /**
   * Keep only this span of assembled time from the chunk.
   *
   * The grid does not line up with speech, so the first and last chunk of a range
   * carry material that belongs to deleted content. The trim window discards it
   * *before* it becomes media — which is the whole point: audio that never enters
   * the buffer can never be heard, whereas audio skipped at playback time can.
   */
  start: number;
  end: number;
}

export interface PreviewStream {
  segments: PreviewStreamSegment[];
  totalSeconds: number;
  /** Codec string the player needs before it can accept any chunk. */
  mimeType: string;
}

export interface BuildPreviewStreamInput {
  projectDir: string;
  /** Project-relative path of the ready preview proxy. */
  proxySource: string;
  /** Identity of the proxy; a new one invalidates the grid. */
  proxyCacheKey: string;
  segments: readonly { start: number; end: number }[];
}

export interface GridChunk {
  name: string;
  start: number;
  end: number;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function run(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(0, 400)}`)));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function parseSegmentList(csv: string, directory: string): GridChunk[] {
  const chunks: GridChunk[] = [];
  for (const line of csv.split("\n")) {
    const [name, start, end] = line.trim().split(",");
    if (!name || start === undefined || end === undefined) continue;
    const from = Number(start);
    const to = Number(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) continue;
    chunks.push({ name: join(directory, name).split("/").pop() ?? name, start: from, end: to });
  }
  return chunks;
}

/**
 * Slice the proxy onto the grid, once per proxy.
 *
 * `-map 0` is required: without it the segment muxer reports "output file does not
 * contain any stream" and writes nothing. Each chunk carries `empty_moov`, so it is
 * self-describing and can be appended on its own, and `-reset_timestamps` makes
 * every chunk start at zero — which is why placement is per-chunk arithmetic rather
 * than something that has to be read back out of the media.
 */
async function ensureGrid(input: BuildPreviewStreamInput): Promise<GridChunk[]> {
  const directory = join(input.projectDir, ".chengfeng-videocut", STREAM_DIRECTORY, input.proxyCacheKey);
  const indexPath = `${directory}${CHUNK_INDEX_SUFFIX}`;
  if (await exists(indexPath)) {
    return JSON.parse(await readFile(indexPath, "utf8")) as GridChunk[];
  }

  const staging = `${directory}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const listPath = join(staging, "list.csv");
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-i", `file:${join(input.projectDir, input.proxySource)}`,
      "-map", "0", "-c", "copy",
      "-f", "segment",
      "-segment_time", String(CHUNK_SECONDS),
      "-reset_timestamps", "1",
      "-segment_format", "mp4",
      "-segment_format_options", "movflags=frag_keyframe+empty_moov+default_base_moof",
      "-segment_list", `file:${listPath}`,
      "-segment_list_type", "csv",
      `file:${join(staging, "%05d.m4s")}`,
    ]);
    const chunks = parseSegmentList(await readFile(listPath, "utf8"), staging);
    if (chunks.length === 0) throw new Error("proxy produced no playable chunks");
    await rm(listPath, { force: true });
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
    await writeFile(indexPath, JSON.stringify(chunks), "utf8");
    return chunks;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Drop grids belonging to proxies that no longer exist. */
async function pruneGrids(root: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (entry === keep || entry === `${keep}${CHUNK_INDEX_SUFFIX}`) return;
    await rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined);
  }));
}

/**
 * Place retained ranges onto the grid. Pure arithmetic — this is the entire cost of
 * an edit, and the only part that can be wrong without anything reporting an error.
 *
 * Every chunk a range touches gets the *same* trim window (the range's span on the
 * assembled timeline) and its own offset. The window is what makes grid alignment
 * irrelevant: material outside the range is discarded before it becomes media.
 */
export function planPreviewStreamSegments(
  chunks: readonly GridChunk[],
  ranges: readonly { start: number; end: number }[],
  sourceOf: (chunk: GridChunk) => string,
): { segments: PreviewStreamSegment[]; totalSeconds: number } {
  const segments: PreviewStreamSegment[] = [];
  let out = 0;
  for (const range of ranges) {
    const duration = range.end - range.start;
    if (!(duration > 0)) continue;
    for (const chunk of chunks) {
      // Half-open on both sides: a chunk that merely touches a boundary carries
      // nothing of this range, and appending it would be pure waste.
      if (chunk.end <= range.start || chunk.start >= range.end) continue;
      segments.push({
        source: sourceOf(chunk),
        offset: roundSeconds(out + chunk.start - range.start),
        start: roundSeconds(out),
        end: roundSeconds(out + duration),
      });
    }
    out += duration;
  }
  return { segments, totalSeconds: roundSeconds(out) };
}

export async function buildPreviewStream(
  input: BuildPreviewStreamInput,
): Promise<PreviewStream> {
  const chunks = await ensureGrid(input);
  const planned = planPreviewStreamSegments(
    chunks,
    input.segments,
    (chunk) => `.chengfeng-videocut/${STREAM_DIRECTORY}/${input.proxyCacheKey}/${chunk.name}`,
  );
  await pruneGrids(join(input.projectDir, ".chengfeng-videocut", STREAM_DIRECTORY), input.proxyCacheKey);
  return {
    ...planned,
    mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  };
}
