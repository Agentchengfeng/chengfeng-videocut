import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { EditListDocument, EditListSegment } from "@video-workbench/contracts";
import type { TimedWord } from "@video-workbench/core";

const run = promisify(execFile);
const SR = 16_000;
/** Audible means clearly above this recording's own noise floor. */
const AUDIBLE_ABOVE_FLOOR_DB = 14;
/** A move must make the seam at least this much quieter to be worth it. */
const MIN_GAIN_DB = 6;
const SEARCH_SECONDS = 0.12;
const STEP = 0.005;
const EPS = 0.0005;

interface Pcm { samples: Int16Array; floor: number }
const cache = new Map<string, Pcm>();

async function narrationPcm(path: string): Promise<Pcm> {
  const info = await stat(path);
  const key = `${path}:${info.size}:${info.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
  const buffer = stdout as unknown as Buffer;
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  const windows: number[] = [];
  for (let i = 0; i + SR / 20 <= samples.length; i += SR / 2) windows.push(levelAt(samples, (i + SR / 40) / SR, 0.025));
  windows.sort((a, b) => a - b);
  const pcm = { samples, floor: windows[Math.floor(windows.length * 0.05)] ?? -70 };
  cache.clear();
  cache.set(key, pcm);
  return pcm;
}

function levelAt(samples: Int16Array, t: number, half = 0.005): number {
  const from = Math.max(0, Math.round((t - half) * SR)), to = Math.min(samples.length, Math.round((t + half) * SR));
  if (to <= from) return -120;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!;
  return 20 * Math.log10(Math.sqrt(sum / (to - from)) / 32768 + 1e-9);
}

function loudest(samples: Int16Array, from: number, to: number): number {
  let max = -120;
  for (let t = from; t < to; t += STEP) max = Math.max(max, levelAt(samples, t));
  return max;
}

export interface SeamReport { timelineTime: number; edge: "start" | "end"; segmentId: string; level: number }

function narrationPath(document: EditListDocument): string | null {
  const narration = document.segments.filter((s) => !s.instanceId?.startsWith("insert:"));
  const path = narration[0]?.source;
  if (!path || narration.some((s) => s.source !== path)) return null;
  const declared = document.sources?.find((s) => s.path === path);
  if (declared && declared.mediaKind !== "audio") return null;
  return path;
}

function ripple(document: EditListDocument, segments: EditListSegment[]): EditListDocument {
  let cursor = 0;
  const timed = [...segments].sort((a, b) => a.timelineStart - b.timelineStart).map((segment) => {
    const next = { ...segment, timelineStart: Math.round(cursor * 1e6) / 1e6 };
    cursor += (segment.sourceEnd - segment.sourceStart) / segment.playbackRate;
    return next;
  });
  return { ...document, segments: timed, duration: Math.round(cursor * 1e6) / 1e6 };
}

/**
 * Move each seam this edit created to the quietest nearby instant, so a cut does
 * not carry half a syllable of removed speech or clip a kept word. Rules, all
 * measured on the narration audio itself:
 *  - only seams that are audibly above the recording's noise floor;
 *  - only seams this edit changed — a boundary the person trimmed by hand stays;
 *  - never into a kept word, and never re-admitting removed audio that is audible;
 *  - only when the new point is clearly quieter.
 * Seams inside continuous speech (no quiet point) are left for a person to hear.
 */
export async function refineSeams(input: {
  projectDir: string;
  before: EditListDocument | null;
  after: EditListDocument;
  words: readonly TimedWord[];
}): Promise<EditListDocument> {
  const path = narrationPath(input.after);
  if (!path) return input.after;
  const { samples, floor } = await narrationPcm(resolve(input.projectDir, path));
  const audible = floor + AUDIBLE_ABOVE_FLOOR_DB;
  const known = new Set<string>();
  for (const s of input.before?.segments ?? []) if (s.source === path) { known.add(`s${s.sourceStart.toFixed(3)}`); known.add(`e${s.sourceEnd.toFixed(3)}`); }
  const narration = input.after.segments.filter((s) => s.source === path && !s.instanceId?.startsWith("insert:"));
  const bySource = [...narration].sort((a, b) => a.sourceStart - b.sourceStart);
  const spoken = input.words.filter((w) => !w.isGap && (w.source === undefined || w.source === path));
  const adjusted = new Map<string, { sourceStart: number; sourceEnd: number }>();
  for (const segment of narration) {
    const kept = spoken.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid > segment.sourceStart && mid < segment.sourceEnd;
    });
    if (!kept.length) continue;
    const k = bySource.indexOf(segment);
    const previousEnd = k > 0 ? bySource[k - 1]!.sourceEnd : 0;
    const nextStart = k + 1 < bySource.length ? bySource[k + 1]!.sourceStart : Infinity;
    let a = segment.sourceStart, b = segment.sourceEnd;
    const pick = (candidates: number[], origin: number) => candidates.reduce((best, t) => {
      const lt = Math.round(levelAt(samples, t)), lb = Math.round(levelAt(samples, best));
      return lt < lb || (lt === lb && Math.abs(t - origin) < Math.abs(best - origin)) ? t : best;
    }, origin);
    if (!known.has(`s${a.toFixed(3)}`) && a > EPS && levelAt(samples, a) > audible) {
      const candidates: number[] = [];
      for (let t = Math.max(a - SEARCH_SECONDS, previousEnd + 0.01); t <= Math.min(kept[0]!.start, b - 0.05) + EPS; t += STEP) {
        if (t >= a || loudest(samples, t, a) < audible) candidates.push(t);
      }
      const best = pick(candidates, a);
      if (levelAt(samples, a) - levelAt(samples, best) >= MIN_GAIN_DB) a = Math.round(best * 1000) / 1000;
    }
    if (!known.has(`e${b.toFixed(3)}`) && levelAt(samples, b) > audible) {
      const candidates: number[] = [];
      for (let t = Math.max(kept[kept.length - 1]!.end, a + 0.05); t <= Math.min(b + SEARCH_SECONDS, nextStart - 0.01) + EPS; t += STEP) {
        if (t <= b || loudest(samples, b, t) < audible) candidates.push(t);
      }
      const best = pick(candidates, b);
      if (levelAt(samples, b) - levelAt(samples, best) >= MIN_GAIN_DB) b = Math.round(best * 1000) / 1000;
    }
    if (a !== segment.sourceStart || b !== segment.sourceEnd) adjusted.set(segment.id, { sourceStart: a, sourceEnd: b });
  }
  if (!adjusted.size) return input.after;
  return ripple(input.after, input.after.segments.map((s) => adjusted.has(s.id) ? { ...s, ...adjusted.get(s.id)! } : s));
}

/** Seams still audible (continuous speech): a short list for a person to listen to. */
export async function audibleSeams(projectDir: string, document: EditListDocument): Promise<SeamReport[]> {
  const path = narrationPath(document);
  if (!path) return [];
  const { samples, floor } = await narrationPcm(resolve(projectDir, path));
  const audible = floor + AUDIBLE_ABOVE_FLOOR_DB;
  const out: SeamReport[] = [];
  for (const s of document.segments) {
    if (s.source !== path || s.instanceId?.startsWith("insert:") || s.sourceEnd - s.sourceStart < 0.1) continue;
    const length = (s.sourceEnd - s.sourceStart) / s.playbackRate;
    if (s.sourceStart > EPS) {
      const level = levelAt(samples, s.sourceStart);
      if (level > audible) out.push({ timelineTime: s.timelineStart, edge: "start", segmentId: s.id, level: Math.round(level) });
    }
    const level = levelAt(samples, s.sourceEnd);
    if (level > audible) out.push({ timelineTime: s.timelineStart + length, edge: "end", segmentId: s.id, level: Math.round(level) });
  }
  return out.sort((x, y) => x.timelineTime - y.timelineTime);
}
