/// <reference types="node" />

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ffmpegFileArg } from "@video-workbench/core";

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
 * Only the audio is re-encoded, and only to place the seam fades; video is copied.
 *
 * ## Cut from the proxy itself, not from a rewrapped copy
 *
 * An earlier version rewrapped the whole proxy into a fragmented copy first and cut
 * from that. It cost 96MB of disk and — far worse — **2.4 seconds on the first cut
 * after any idle period**, because a fragmented file has no index and opening it
 * pulls the whole thing off the disk. These projects live on an external USB drive,
 * so every edit after a pause froze the app for over two seconds while ffmpeg's own
 * work took 0.1s.
 *
 * The rewrap was never needed: whether a *fragment* can be appended on its own is
 * decided by the output flags, not by the input's container. Cutting straight from
 * the indexed proxy lets ffmpeg seek to the range and read only what it needs.
 */

const STREAM_DIRECTORY = "preview-stream" as const;
const KEYFRAMES_SUFFIX = ".keyframes.json" as const;
const LOUDNESS_SUFFIX = ".loudness.json" as const;
/** Resolution of the loudness map, in seconds. Fine enough to find a gap between words. */
const LOUDNESS_STEP = 0.01;
/** How far a boundary may move to find silence, in seconds. */
const QUIET_SEARCH_SECONDS = 0.25;
/**
 * How far above the room tone still counts as sound.
 *
 * This is the *fallback* yardstick, used only where no transcript word can be tied
 * to a boundary. Where one can, `tailReleaseLevel` scales the verdict to that word
 * — see the constants below for why a single absolute level cannot work.
 */
const SOUND_ABOVE_FLOOR = 1.5;
/**
 * When a word's tail counts as closed, relative to that word's own peak.
 *
 * How quiet "quiet" is depends on the word that made the sound: a loud word rings
 * out loudly, a soft one softly, and any absolute level splits them wrong. Both
 * failures were measured on one recording (floor 248): 「站」 peaks at 2468 and its
 * tail was still an audible 「喔」 at 567 — 23% of its peak — which floor x 2.5
 * (620) waved through; 「到」 peaks at 2112 and its tail still simmered audibly at
 * 339 — 16% of its peak — which floor x 1.5 (372) waved through. Chasing the second
 * with a still-lower absolute would start cutting into room noise everywhere else.
 *
 * 15% is -16.5dB below the word's own peak. The measured leaks sat at -12~-16dB of
 * their words; the landings listeners accepted sat at -17dB and below. And because
 * a tail decays steeply, the search lands well under whatever ceiling admits it —
 * both measured cases land within 2% either side of the room tone.
 */
const TAIL_RELEASE_RATIO = 0.15;
/**
 * The release level never demands quieter than the room itself.
 *
 * The floor is the 5th percentile, so genuine room tone spends most of its time
 * above it — this recording's room idles at 248-280 against a floor of 248.
 * Requiring a dip under 1.2x floor would wait for silence the recording does not
 * contain, and the search would give up and leave the cut in the worst place.
 */
const FLOOR_RELEASE = 1.2;
/** Keep a few generations so undo lands on a cache hit instead of a re-cut. */
const RETAINED_CHUNK_GENERATIONS = 240;
/**
 * Length of the gain ramp at each end of a retained range, in seconds.
 *
 * A cut lands where one sound stops and another was removed; splicing that with a
 * hard edge is what makes a click. Four independent projects converge on this order
 * of magnitude — auto-editor 3ms, jumpcutter ~9ms, the MSE spec's own audio splice
 * 5ms — and auto-editor added it only after shipping without it and hearing pops.
 *
 * It is also what makes cutting *past* the end of a word safe: whatever the extra
 * few milliseconds catch has already been taken to zero.
 */
const SEAM_FADE_SECONDS = 0.005;

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
  /** Identity of the proxy; a new one invalidates the indexes cached beside it. */
  proxyCacheKey: string;
  segments: readonly { start: number; end: number }[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roundSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function runBinary(command: string, args: readonly string[]): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(new Uint8Array(Buffer.concat(chunks)))
      : reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(0, 400)}`)));
  });
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

/**
 * A scratch path no other write can collide with.
 *
 * The process id alone does not do that: two requests arriving together are the
 * *same* process, so both cut the same fragment into the same temporary file, the
 * first rename succeeds and the second fails with ENOENT — a 500 for work that had
 * in fact just completed. One edit plus a poll is enough to line them up.
 */
let scratchCounter = 0;
function scratchPath(path: string): string {
  scratchCounter += 1;
  return `${path}.tmp-${process.pid}-${scratchCounter}`;
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
 * Record where the proxy's keyframes are and how loud it is, once per proxy.
 *
 * Both are read-only passes over a file that already exists, keyed by the proxy's
 * identity, so this happens once per proxy rather than once per edit.
 */
async function ensureProxyIndexes(input: BuildPreviewStreamInput): Promise<{
  proxy: string;
  keyframes: number[];
  loudness: { step: number; rms: number[]; quiet: number; floor: number };
}> {
  const directory = join(input.projectDir, ".chengfeng-videocut", STREAM_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const indexPath = join(directory, `${input.proxyCacheKey}${KEYFRAMES_SUFFIX}`);
  const loudnessPath = join(directory, `${input.proxyCacheKey}${LOUDNESS_SUFFIX}`);
  const proxy = join(input.projectDir, input.proxySource);

  if (!await exists(indexPath)) {
    // Packet flags rather than `-skip_frame nokey`: that option filters frames, not
    // packets, and silently returns every packet here.
    const raw = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags",
      "-of", "csv=p=0", ffmpegFileArg(proxy),
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
    const temporary = scratchPath(indexPath);
    await writeFile(temporary, JSON.stringify(keyframes), "utf8");
    await rename(temporary, indexPath);
    return { proxy, keyframes, loudness: await ensureLoudness(proxy, loudnessPath) };
  }

  const keyframes = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    throw new Error("Preview proxy keyframe index is unusable");
  }
  return {
    proxy,
    keyframes: keyframes as number[],
    loudness: await ensureLoudness(proxy, loudnessPath),
  };
}

/**
 * Where the audio is quiet, sampled every 10ms.
 *
 * Transcription marks where it *recognised* a word, not where the sound stops — a
 * measured case wrote 40ms for a syllable whose audio ran 180ms. Cutting at the
 * written boundary therefore cuts through the word itself, and no fixed margin fixes
 * that: it needs to know where the sound actually stops.
 *
 * Computed once per proxy and cached beside the keyframe index. One pass over the
 * audio of an eight-minute proxy takes about two seconds.
 */
function quietFrom(floor: number): number {
  return Math.max(1, Math.round(floor * SOUND_ABOVE_FLOOR));
}

async function ensureLoudness(
  source: string,
  indexPath: string,
): Promise<{ step: number; rms: number[]; quiet: number; floor: number }> {
  if (await exists(indexPath)) {
    const stored = JSON.parse(await readFile(indexPath, "utf8")) as
      { step: number; rms: number[]; quiet: number; floor?: number };
    if (stored?.rms?.length) {
      // Recompute the verdict from the stored floor so changing the multiplier
      // takes effect without anyone having to know this cache exists.
      const floor = stored.floor ?? stored.quiet / 2.5;
      return { ...stored, floor, quiet: quietFrom(floor) };
    }
  }
  const raw = await runBinary("ffmpeg", [
    "-v", "error", "-i", ffmpegFileArg(source),
    "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
  ]);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
  const window = Math.round(16000 * LOUDNESS_STEP);
  const rms: number[] = [];
  for (let index = 0; index + window <= samples.length; index += window) {
    let sum = 0;
    for (let offset = 0; offset < window; offset += 1) {
      const value = samples[index + offset]!;
      sum += value * value;
    }
    rms.push(Math.round(Math.sqrt(sum / window)));
  }
  if (rms.length === 0) throw new Error("preview proxy has no audio to measure");
  // The floor is what this recording calls silence — room tone, not zero. Taking a
  // low percentile rather than the minimum keeps one freak sample from setting it.
  const sorted = [...rms].sort((left, right) => left - right);
  const floor = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  // Store the floor, not the verdict: the multiplier is a judgement that gets
  // revisited, and baking it into the cache would make revisiting it require
  // deleting files nobody remembers exist.
  const map = { step: LOUDNESS_STEP, rms, floor, quiet: quietFrom(floor) };
  const temporary = scratchPath(indexPath);
  await writeFile(temporary, JSON.stringify(map), "utf8");
  await rename(temporary, indexPath);
  return map;
}

/**
 * What the transcript knows about where speech is, in source seconds.
 *
 * `onsets` is where each word starts speaking. A boundary may be extended through
 * the silence after the kept speech, but it must stop before whatever is said next
 * — kept or deleted, it does not matter, because either way playing it here is
 * wrong. Deleted speech played twice is the bug this whole design exists to
 * prevent; kept speech played early is just as wrong.
 *
 * `words` carries the full spans, for tying a boundary to the word whose sound is
 * decaying across it. A word with a broken end still contributes its onset — the
 * guard above must not weaken just because a span cannot be measured.
 */
async function transcriptGuide(projectDir: string): Promise<{
  onsets: number[];
  words: { start: number; end: number }[];
}> {
  try {
    const raw = JSON.parse(await readFile(join(projectDir, "transcript.json"), "utf8")) as {
      cues?: Array<{ words?: Array<{ start?: number; end?: number; isGap?: boolean }> }>;
    };
    const onsets: number[] = [];
    const words: { start: number; end: number }[] = [];
    for (const cue of raw.cues ?? []) {
      for (const word of cue.words ?? []) {
        if (word.isGap === true) continue;
        if (typeof word.start !== "number" || !Number.isFinite(word.start)) continue;
        onsets.push(word.start);
        if (typeof word.end === "number" && Number.isFinite(word.end) && word.end > word.start) {
          words.push({ start: word.start, end: word.end });
        }
      }
    }
    return {
      onsets: onsets.sort((left, right) => left - right),
      words: words.sort((left, right) => left.start - right.start),
    };
  } catch {
    // No transcript to consult: refuse to extend rather than guess where speech is.
    return { onsets: [], words: [] };
  }
}

/** The last word that starts at or before this instant, by transcript order. */
function wordAtOrBefore(
  words: readonly { start: number; end: number }[],
  time: number,
): { start: number; end: number } | null {
  let low = 0;
  let high = words.length - 1;
  let found: { start: number; end: number } | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = words[middle]!;
    if (candidate.start <= time + 1e-6) {
      found = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * True when this instant falls inside a transcribed word.
 *
 * A range that opens on a word the transcript can see is opening on speech, not on
 * leftover sound — whatever the level says, moving the boundary would clip words,
 * and the loudness map cannot tell a word's own body from a tail. The transcript
 * can, so it gets the veto.
 */
function insideSpokenWord(
  words: readonly { start: number; end: number }[],
  time: number,
): boolean {
  const word = wordAtOrBefore(words, time);
  return word !== null && time < word.end - 1e-6;
}

/**
 * The level at which the sound decaying across this boundary counts as closed.
 *
 * The word responsible is the last one the transcript starts before the boundary:
 * at a range end that is the kept word being completed, at a range start it is the
 * deleted word whose tail is spilling in. Its own peak sets the yardstick —
 * `TAIL_RELEASE_RATIO` of it, but never below what the room itself produces. With
 * no transcript, or no word to tie to, the absolute fallback stands.
 */
export function tailReleaseLevel(
  map: { step: number; rms: number[]; quiet: number; floor: number },
  words: readonly { start: number; end: number }[],
  boundary: number,
): number {
  const word = wordAtOrBefore(words, boundary);
  if (!word) return map.quiet;
  const first = Math.max(0, Math.floor(word.start / map.step));
  const last = Math.min(map.rms.length - 1, Math.floor(word.end / map.step));
  let peak = 0;
  for (let index = first; index <= last; index += 1) {
    peak = Math.max(peak, map.rms[index] ?? 0);
  }
  if (peak <= 0) return map.quiet;
  return Math.max(map.floor * FLOOR_RELEASE, peak * TAIL_RELEASE_RATIO);
}

function nextOnsetAfter(onsets: readonly number[], time: number): number | null {
  let low = 0;
  let high = onsets.length - 1;
  let found: number | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = onsets[middle]!;
    if (candidate > time + 1e-6) {
      found = candidate;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

/**
 * Move a boundary off the sound and into the silence just past it.
 *
 * Later, never earlier: a boundary that lands inside a word must give the whole word
 * back, and the only direction that does that is outward. It stops at the first quiet
 * sample, so a boundary already in silence does not move at all, and it gives up
 * after a quarter second rather than run into whatever comes next.
 */
/**
 * True when the sound at this instant is spilling over from before it.
 *
 * A boundary can be loud for two opposite reasons, and they need opposite handling:
 * the kept word is starting (leave it alone — moving would clip its onset), or what
 * was deleted is still ringing out (move past it — playing it is the leak this
 * design exists to prevent). Speech that was already loud a moment earlier is the
 * second kind; a genuine onset rises out of silence.
 */
/**
 * Closed means staying quiet, not dipping.
 *
 * A ringing tail passes through single quiet samples on its way back up — this
 * recording reads 278 at 185.59 with 426 right behind it — and a cut in that dip
 * leaks the rest of the ring. Two consecutive samples (20ms) is enough to tell a
 * dip from a landing without demanding a pause the speech may not contain.
 */
function soundClosedAt(
  map: { step: number; rms: number[]; quiet: number },
  time: number,
): boolean {
  const at = (seconds: number) => map.rms[Math.floor(seconds / map.step)] ?? 0;
  return at(time) <= map.quiet && at(time + map.step) <= map.quiet;
}

export function soundSpillsInto(
  map: { step: number; rms: number[]; quiet: number },
  time: number,
): boolean {
  const at = (seconds: number) => map.rms[Math.floor(seconds / map.step)] ?? 0;
  if (soundClosedAt(map, time)) return false;
  // Two samples back: one is within the rise of a real onset, three starts reaching
  // into whatever preceded a genuine pause.
  return at(time - map.step * 2) > map.quiet;
}

export function quietBoundaryAfter(
  map: { step: number; rms: number[]; quiet: number },
  time: number,
  limitSeconds = QUIET_SEARCH_SECONDS,
): number {
  if (soundClosedAt(map, time)) return time;
  const steps = Math.ceil(limitSeconds / map.step);
  for (let index = 1; index <= steps; index += 1) {
    const candidate = time + index * map.step;
    if (soundClosedAt(map, candidate)) return roundSeconds(candidate);
  }
  return time;
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

/**
 * Move each cut off the sound and into the silence just past it.
 *
 * Used when the ledger is written, never when it is read: what comes out of here
 * becomes the record, and everything downstream copies it verbatim.
 */
export async function placeCutBoundaries(input: {
  projectDir: string;
  proxySource: string;
  proxyCacheKey: string;
  ranges: readonly { start: number; end: number }[];
}): Promise<{ start: number; end: number }[]> {
  const { loudness } = await ensureProxyIndexes({
    projectDir: input.projectDir,
    proxySource: input.proxySource,
    proxyCacheKey: input.proxyCacheKey,
    segments: [],
  });
  const { onsets, words } = await transcriptGuide(input.projectDir);
  const ranges = [...input.ranges];
  return ranges.map((range, index) => {
    // The word decaying across each edge sets the yardstick there — its own peak,
    // not a project-wide constant, decides how quiet its tail must get. Every
    // absolute level tried so far let one word's tail through while chasing
    // another's; the only measure they all share is themselves.
    const endRelease = { ...loudness, quiet: tailReleaseLevel(loudness, words, range.end) };
    const limits = [
      QUIET_SEARCH_SECONDS,
      ranges[index + 1] === undefined ? Infinity : ranges[index + 1]!.start - range.end,
      // The hard stop is whatever is *said* next, kept or deleted alike. A boundary
      // sitting on a deleted word's onset looks exactly like a word still being
      // spoken, and searching forward for silence walks straight through it.
      onsets.length === 0 ? 0 : (nextOnsetAfter(onsets, range.end) ?? Infinity) - range.end,
    ];
    const room = Math.max(0, Math.min(...limits));
    const end = quietBoundaryAfter(endRelease, range.end, room);
    // The same rule at the other edge. A range can open in the middle of the take
    // that was cut — transcription put the boundary there, but the previous take is
    // still ringing — and then the kept word is heard twice: once as that leftover,
    // once for real. Only move when the sound is spilling in; a range that opens on
    // its own word's onset must not lose it — the transcript, not the level, gets
    // that veto, because a word-relative level is low enough to mistake a noisy
    // pause before an onset for a tail.
    //
    // At most half the range, so a range can never be trimmed out of existence. A
    // range made *entirely* of leftover sound is usually one the user restored on
    // purpose; making it vanish would leave it marked kept on screen and silent in
    // the ears, which is the one mismatch this product refuses. And never up to the
    // next onset: the same hard stop the end obeys, because the first kept word is
    // exactly what a start must not eat.
    const startRelease = { ...loudness, quiet: tailReleaseLevel(loudness, words, range.start) };
    const spillRoom = Math.min(
      QUIET_SEARCH_SECONDS,
      (end - range.start) / 2,
      onsets.length === 0
        ? QUIET_SEARCH_SECONDS
        : (nextOnsetAfter(onsets, range.start) ?? Infinity) - range.start,
    );
    // A start that continues straight on from the previous range is not a cut at
    // all — the source is contiguous there, the seam gets merged away before
    // cutting, and nothing was deleted that could spill in. Moving it would tear a
    // hole in speech the user kept: a real project's restore seam at 187.19 sits in
    // a word's decay, exactly the shape the spill test looks for.
    const previous = ranges[index - 1];
    const seam = previous !== undefined && Math.abs(range.start - previous.end) < 1e-3;
    const start = !seam
      && !insideSpokenWord(words, range.start)
      && soundSpillsInto(startRelease, range.start)
      ? quietBoundaryAfter(startRelease, range.start, Math.max(0, spillRoom))
      : range.start;
    return { start, end };
  });
}

export async function buildPreviewStream(
  input: BuildPreviewStreamInput,
): Promise<PreviewStream> {
  const { proxy, keyframes, loudness } = await ensureProxyIndexes(input);
  const directory = join(input.projectDir, ".chengfeng-videocut", STREAM_DIRECTORY);
  const segments: PreviewStreamSegment[] = [];
  const keep = new Set<string>();
  let out = 0;

  const ranges = mergeContiguousRanges(input.segments);
  for (const segment of ranges) {
    const start = segment.start;
    // Cut exactly where the ledger says. Placing the boundary is the ledger's job
    // and only the ledger's — see `placeBoundaries`. Nudging it here as well is how
    // one seam produced three separate bugs in a day.
    const end = segment.end;
    const duration = end - start;
    if (!(duration > 0)) continue;
    const keyframe = keyframeAtOrBefore(keyframes, start);
    // Keyed by what the fragment contains, not by which edit asked for it, so an
    // unchanged range is never cut twice.
    // `start` belongs in the key even though the cut runs from the keyframe: the
    // fades are placed relative to the range, so two fragments with the same
    // keyframe and end but different starts are different media.
    const name = `${sha256(`${input.proxyCacheKey}|${keyframe.toFixed(6)}|${start.toFixed(6)}|${end.toFixed(6)}|f${SEAM_FADE_SECONDS}`)}.m4s`;
    const path = join(directory, name);
    keep.add(name);
    if (!await exists(path)) {
      const temporary = scratchPath(path);
      // Video is copied; only the audio is touched, and only at the two ends. The
      // re-encode costs about 50ms per fragment, which is the price of not clicking.
      const fadeIn = roundSeconds(start - keyframe);
      const fadeOut = roundSeconds(fadeIn + duration - SEAM_FADE_SECONDS);
      const audio = duration > SEAM_FADE_SECONDS * 4
        ? [
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-af", `afade=t=in:st=${fadeIn.toFixed(6)}:d=${SEAM_FADE_SECONDS},`
              + `afade=t=out:st=${fadeOut.toFixed(6)}:d=${SEAM_FADE_SECONDS}`,
          ]
        // Too short to ramp both ends without them meeting; leave it alone rather
        // than fade a fragment into and out of itself.
        : ["-c", "copy"];
      try {
        await run("ffmpeg", [
          "-y", "-v", "error",
          "-ss", keyframe.toFixed(6), "-to", end.toFixed(6),
          "-i", ffmpegFileArg(proxy),
          ...audio,
          "-movflags", "frag_keyframe+empty_moov+default_base_moof",
          "-f", "mp4", ffmpegFileArg(temporary),
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
