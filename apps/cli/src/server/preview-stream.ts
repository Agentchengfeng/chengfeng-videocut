/// <reference types="node" />

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Media for playback that never seeks.
 *
 * The previous approach played the whole proxy and jumped `currentTime` at every
 * retained boundary. Every measurement said it was clean — zero dropped frames, a
 * single contiguous buffered range, 0–1ms stalls, exact landing positions — and it
 * was audibly broken: setting `currentTime` stops the decoder, not the sound, so
 * the 150–400ms already handed to the sound card played on. What sits immediately
 * after a retained boundary is always deleted content, so every seam leaked deleted
 * speech. Muting could not reach audio that was already past the volume stage, and
 * seeking early would have clipped the end of retained speech.
 *
 * Only a person listening caught it. This module exists so playback has nothing to
 * jump over: the retained ranges are cut into fragments and assembled into one
 * continuous stream before the player ever sees them.
 *
 * Nothing here re-encodes. Fragments are stream copies, which is why an edit costs
 * milliseconds instead of the twelve seconds a full re-encode took.
 */

const STREAM_DIRECTORY = "preview-stream" as const;
const FRAGMENTED_SUFFIX = ".frag.mp4" as const;
const KEYFRAMES_SUFFIX = ".keyframes.json" as const;
/** Keep a few generations so undo lands on a cache hit instead of a re-cut. */
const RETAINED_CHUNK_GENERATIONS = 240;

export interface PreviewStreamSegment {
  /** Project-relative path of the fragment, servable by the preview media route. */
  source: string;
  /**
   * Seconds of extra media at the head of this fragment.
   *
   * A stream copy can only start at a keyframe, so a fragment begins at or before
   * the requested range. The player trims exactly this much when appending, which
   * is what keeps the join frame-accurate without re-encoding: the data is
   * keyframe-aligned, the boundary is not.
   */
  headExtra: number;
  /** Where this fragment starts on the assembled timeline. */
  out: number;
  /** Retained duration, excluding `headExtra`. */
  dur: number;
}

export interface PreviewStream {
  segments: PreviewStreamSegment[];
  totalSeconds: number;
  /** Codec string the player needs before it can accept any fragment. */
  mimeType: string;
}

export interface BuildPreviewStreamInput {
  projectDir: string;
  /** Project-relative path of the ready preview proxy. */
  proxySource: string;
  /** Identity of the proxy; a new one invalidates the fragmented copy and the index. */
  proxyCacheKey: string;
  segments: readonly { start: number; end: number }[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

/**
 * Rewrap the proxy so its fragments can be appended one at a time, and record
 * where its keyframes are. Both are stream copies of an existing file, keyed by the
 * proxy's identity, so this happens once per proxy rather than once per edit.
 */
async function ensureFragmentedProxy(input: BuildPreviewStreamInput): Promise<{
  fragmented: string;
  keyframes: number[];
}> {
  const directory = join(input.projectDir, ".chengfeng-videocut", STREAM_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const fragmented = join(directory, `${input.proxyCacheKey}${FRAGMENTED_SUFFIX}`);
  const indexPath = join(directory, `${input.proxyCacheKey}${KEYFRAMES_SUFFIX}`);
  const proxy = join(input.projectDir, input.proxySource);

  if (!await exists(fragmented)) {
    const temporary = `${fragmented}.tmp-${process.pid}`;
    try {
      await run("ffmpeg", [
        "-y", "-v", "error", "-i", `file:${proxy}`, "-c", "copy",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        // Named explicitly: the temporary carries a `.tmp-<pid>` suffix so the
        // container cannot be inferred from the extension.
        "-f", "mp4", `file:${temporary}`,
      ]);
      await rename(temporary, fragmented);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  if (!await exists(indexPath)) {
    // Packet flags rather than `-skip_frame nokey`: that option filters frames, not
    // packets, and silently returns every packet here.
    const raw = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags",
      "-of", "csv=p=0", `file:${fragmented}`,
    ]);
    const keyframes = raw.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(","))
      .filter((parts) => (parts[1] ?? "").includes("K"))
      .map((parts) => Number(parts[0]))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    if (keyframes.length === 0) {
      throw new Error("Fragmented preview proxy reports no keyframes");
    }
    const temporary = `${indexPath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(keyframes), "utf8");
    await rename(temporary, indexPath);
    return { fragmented, keyframes };
  }

  const keyframes = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    throw new Error("Preview proxy keyframe index is unusable");
  }
  return { fragmented, keyframes: keyframes as number[] };
}

function keyframeAtOrBefore(keyframes: readonly number[], time: number): number {
  let low = 0;
  let high = keyframes.length - 1;
  let best = keyframes[0] ?? 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = keyframes[middle]!;
    if (candidate <= time + 1e-6) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Drop fragments no longer referenced, keeping a bounded history.
 *
 * Fragments are keyed by source range, so most of them survive an edit untouched —
 * that is the whole reason a keystroke costs milliseconds. The bound exists because
 * the previous cache had none and reached 26 files and 1.1GB on a real project.
 */
async function pruneChunks(directory: string, keep: ReadonlySet<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.m4s$/.test(name) || keep.has(name)) continue;
    try {
      const info = await stat(join(directory, name));
      if (info.isFile()) candidates.push({ name, mtimeMs: info.mtimeMs });
    } catch { continue; }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates.slice(RETAINED_CHUNK_GENERATIONS)) {
    await rm(join(directory, candidate.name), { force: true }).catch(() => undefined);
  }
}

/**
 * Join ranges that were never actually cut apart.
 *
 * A restore inserts a range rather than growing its neighbour, so undoing a cut
 * leaves two ranges that are still adjacent in the source — a seam where the
 * speaker never stopped talking. On one real project that was 11 of 40.
 *
 * Every seam is a place where playback can go wrong and a fragment that has to be
 * cut, so the ones that carry no editorial meaning should not exist. This is the one
 * change audapolis credits for its crackling fix: it splits render items only where
 * the source is genuinely discontinuous, not wherever the edit list happens to have
 * a boundary.
 */
export function mergeContiguousRanges(
  ranges: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    if (!(range.end > range.start)) continue;
    const last = merged[merged.length - 1];
    // A frame is 33ms at 30fps, so a millisecond of slack cannot swallow real content.
    if (last && Math.abs(range.start - last.end) < 1e-3) {
      last.end = range.end;
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

export async function buildPreviewStream(
  input: BuildPreviewStreamInput,
): Promise<PreviewStream> {
  const { fragmented, keyframes } = await ensureFragmentedProxy(input);
  const directory = join(input.projectDir, ".chengfeng-videocut", STREAM_DIRECTORY);
  const segments: PreviewStreamSegment[] = [];
  const keep = new Set<string>();
  let out = 0;

  for (const segment of mergeContiguousRanges(input.segments)) {
    const start = segment.start;
    const end = segment.end;
    const duration = end - start;
    if (!(duration > 0)) continue;
    const keyframe = keyframeAtOrBefore(keyframes, start);
    // Keyed by what the fragment contains, not by which edit asked for it, so an
    // unchanged range is never cut twice.
    const name = `${sha256(`${input.proxyCacheKey}|${keyframe.toFixed(6)}|${end.toFixed(6)}`)}.m4s`;
    const path = join(directory, name);
    keep.add(name);
    if (!await exists(path)) {
      const temporary = `${path}.tmp-${process.pid}`;
      try {
        await run("ffmpeg", [
          "-y", "-v", "error",
          "-ss", keyframe.toFixed(6), "-to", end.toFixed(6),
          "-i", `file:${fragmented}`, "-c", "copy",
          "-movflags", "frag_keyframe+empty_moov+default_base_moof",
          "-f", "mp4", `file:${temporary}`,
        ]);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    segments.push({
      source: `.chengfeng-videocut/${STREAM_DIRECTORY}/${basename(path)}`,
      headExtra: roundSeconds(Math.max(0, start - keyframe)),
      out: roundSeconds(out),
      dur: roundSeconds(duration),
    });
    out += duration;
  }

  await pruneChunks(directory, keep);

  return {
    segments,
    totalSeconds: roundSeconds(out),
    mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  };
}
