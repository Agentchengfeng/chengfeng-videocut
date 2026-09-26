/**
 * The visual document: what is drawn on top of the footage, and when.
 *
 * The product already has two documents that decide things about the same
 * words. This is the third, and like the others it is defined by what it may
 * not decide:
 *
 * ```text
 * 剪口播 (edit-list)  which words play, and at what time   <- the only truth about time
 * 字幕   (subtitles)  what is written on screen
 * 画面   (this file)  what is drawn over the footage
 * ```
 *
 * So a layer stores **word ids, never seconds**. Its moment on screen is
 * recomputed from the transcript through the edit list every time it is needed,
 * which is what stops it from drifting when the cut changes underneath it.
 *
 * A layer contains either an HTML module or a verified local video asset.
 * Both use the same word anchors and derived composition clock. Media source
 * in/out points trim the asset; they never establish another timeline.
 *
 * Nothing renders. The layer is composited live in the preview and burned in
 * once, at export.
 */

import { VideocutError } from "./errors";
import type { EditListDocument } from "./editList";
import type { TimedWord } from "./cuts";
import { orderedSegments, timelineTimeForSourceTime, wordPlays, segmentMatchesWord } from "./subtitles";

export const VISUAL_SCHEMA_VERSION = 1 as const;

/**
 * The region a layer pushes the picture in on, as percentages of the frame.
 *
 * It exists because of a measured fact: the screen recording this product edits
 * is a page of 8-pixel text. A callout ring can say "look here", but at 1.1% of
 * frame height there is nothing legible to look at — the only honest fix is to
 * bring the region up to readable size. Percentages, never pixels, for the same
 * reason as everywhere else: the preview and the export must compute the same
 * crop from the same numbers.
 */
export interface VisualZoom {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualMedia {
  assetId: string;
  /** Source-local seconds, never composition positions. */
  sourceIn: number;
  sourceOut: number;
  fit: "contain" | "cover";
  muted: true;
  /** Include only the leading gap when the layer covers the first kept word. */
  includeLeadingGap?: boolean;
}

export interface VisualLayer {
  /** Opt-in authoring basis; never a second placement timeline. */
  animation?: VisualAnimationBinding;
  id: string;
  /**
   * The transcript words this layer covers, in spoken order. These are what
   * give the layer its timing; the layer itself holds no seconds.
   */
  wordIds: string[];
  /**
   * Project-relative path to the module's HTML. Relative because the project
   * directory moves between machines, and an absolute path baked into a
   * document is a path that is wrong on the next one.
   */
  module?: string;
  media?: VisualMedia;
  /**
   * Push the footage in on this region while the layer is up. The overlay is
   * transformed with the picture, so a module keeps drawing in original frame
   * coordinates and never knows the zoom exists. Subtitles are not transformed:
   * they sit on the output frame, not on the footage.
   */
  zoom?: VisualZoom;
}

export interface VisualDocument {
  schemaVersion: typeof VISUAL_SCHEMA_VERSION;
  projectId: string;
  /**
   * The transcript these layers were placed against. Not a gate — the document
   * stays usable when the transcript moves on. It is here so a mismatch can be
   * explained rather than guessed at.
   */
  baseTranscriptRevision: string;
  /**
   * Which registered motion style every module in this project is drawn in.
   *
   * Recorded once per document rather than per module, because the thing it
   * protects is consistency: a project whose fifth module invents its own look
   * is worse than one with no modules. The registry is the list of legal
   * values; today it holds `xiaohei` alone.
   */
  animationStyle: string;
  layers: VisualLayer[];
}

export interface VisualLayerTiming {
  animation?: ResolvedVisualAnimation;
  layerId: string;
  /** Seconds on the cut timeline. */
  start: number;
  end: number;
  duration: number;
  /** Every word this layer covers is gone from the edit; it cannot be placed. */
  orphaned: boolean;
}

export interface VisualAnimationBinding {
  schemaVersion: 1;
  clock: "local0";
  authoredDuration: number;
  anchorWordIds: string[];
  canvas?: "project" | "source";
}
export type VisualAnimationIssue = "duration_changed" | "missing_anchor" | "discontinuous" | "orphaned";
export interface ResolvedVisualAnimation {
  clock: "local0";
  authoredDuration: number;
  canvas: "project" | "source";
  issues: VisualAnimationIssue[];
  wordCues: Array<{ id: string; text: string; start: number; end: number }>;
}

/** Shared by the API/preview and export. No mutation, retiming or text rebinding. */
export function resolveVisualAnimation(
  layer: VisualLayer, words: readonly TimedWord[], editList: EditListDocument | null,
  timing: Pick<VisualLayerTiming, "start" | "duration" | "orphaned">,
): ResolvedVisualAnimation | undefined {
  if (!layer.animation) return undefined;
  const segments = orderedSegments(editList);
  const selected = words.filter(word => layer.wordIds.includes(word.id));
  const wordCues = selected.flatMap(word => segments.flatMap(segment => {
    if (!segmentMatchesWord(segment, word)) return [];
    const a = Math.max(segment.sourceStart, word.start), b = Math.min(segment.sourceEnd, word.end);
    return b > a ? [{ id: word.id, text: word.text ?? "",
      start: segment.timelineStart + (a - segment.sourceStart) / segment.playbackRate - timing.start,
      end: segment.timelineStart + (b - segment.sourceStart) / segment.playbackRate - timing.start }] : [];
  })).sort((a, b) => a.start - b.start);
  const issues: VisualAnimationIssue[] = [];
  if (timing.orphaned) issues.push("orphaned");
  else {
    if (Math.abs(timing.duration - layer.animation.authoredDuration) > 0.001) issues.push("duration_changed");
    if (layer.animation.anchorWordIds.some(id => !wordCues.some(cue => cue.id === id))) issues.push("missing_anchor");
    // Include pauses within the source sentence, but not unrelated material
    // inserted between its pieces. Repetition/reordering is also ambiguous.
    const spans = segments.flatMap(segment => {
      const matching = selected.filter(word => segmentMatchesWord(segment, word));
      if (!matching.length) return [];
      const a = Math.max(segment.sourceStart, Math.min(...matching.map(w => w.start)));
      const b = Math.min(segment.sourceEnd, Math.max(...matching.map(w => w.end)));
      return b > a ? [{ start: segment.timelineStart + (a - segment.sourceStart) / segment.playbackRate,
        end: segment.timelineStart + (b - segment.sourceStart) / segment.playbackRate }] : [];
    }).sort((a, b) => a.start - b.start);
    const ids = wordCues.map(cue => layer.wordIds.indexOf(cue.id));
    const repeatedWord = selected.some(word => {
      const pieces = segments.filter(segment => segmentMatchesWord(segment, word))
        .map(segment => ({ a: Math.max(segment.sourceStart, word.start), b: Math.min(segment.sourceEnd, word.end), t: segment.timelineStart }))
        .filter(piece => piece.b > piece.a).sort((a, b) => a.t - b.t);
      return pieces.some((piece, i) => i > 0 && piece.a < pieces[i - 1]!.b - 0.001);
    });
    if (spans.some((span, i) => i > 0 && span.start > spans[i - 1]!.end + 0.001)
      || repeatedWord || ids.some((id, i) => i > 0 && id < ids[i - 1]!)) issues.push("discontinuous");
  }
  return { clock: "local0", authoredDuration: layer.animation.authoredDuration,
    canvas: layer.animation.canvas ?? "project", issues, wordCues };
}

/** The only style in the registry today. */
export const DEFAULT_ANIMATION_STYLE = "xiaohei";

export function createVisualDocument(
  projectId: string,
  baseTranscriptRevision: string,
  animationStyle: string = DEFAULT_ANIMATION_STYLE,
): VisualDocument {
  return {
    schemaVersion: VISUAL_SCHEMA_VERSION,
    projectId,
    baseTranscriptRevision,
    animationStyle,
    layers: [],
  };
}

/**
 * When each layer appears and for how long, computed fresh from the edit list.
 *
 * Words the edit removed are skipped rather than failing the layer: a layer
 * that lost a word in the middle still shows, just shorter. A layer that lost
 * *every* word is reported as orphaned — that is something a person has to
 * decide about, not something to silently drop.
 *
 * This is the same computation the subtitles use, on the same helpers, because
 * "when do these words play" has exactly one answer in this product.
 */
/**
 * A pause this short between two layers is a seam, not a scene.
 *
 * A layer's words end where speech ends, and the next layer's words begin
 * after the breath between sentences — so back-to-back layers left a
 * tenth-of-a-second hole where the module unmounted and one frame of raw
 * footage flashed through. The subtitles already solved this exact thing for
 * screens: the small gap between words belongs to what came before.
 */
const LAYER_GAP_ABSORB_SECONDS = 0.75;

export function visualLayerTimings(
  document: VisualDocument,
  words: readonly TimedWord[],
  editList: EditListDocument | null,
): VisualLayerTiming[] {
  const segments = orderedSegments(editList);
  const byId = new Map(words.map((word) => [word.id, word]));
  const timings: VisualLayerTiming[] = document.layers.map((layer) => {
    const times: number[] = [];
    for (const wordId of layer.wordIds) {
      const word = byId.get(wordId);
      if (!word || !wordPlays(segments, word)) continue;
      for (const segment of segments) {
        if (!segmentMatchesWord(segment, word)) continue;
        const a = Math.max(segment.sourceStart, word.start), b = Math.min(segment.sourceEnd, word.end);
        if (b > a) times.push(segment.timelineStart + (a - segment.sourceStart) / segment.playbackRate,
          segment.timelineStart + (b - segment.sourceStart) / segment.playbackRate);
      }
    }
    if (times.length === 0) {
      return { layerId: layer.id, start: 0, end: 0, duration: 0, orphaned: true };
    }
    let start = Math.min(...times);
    if (layer.media?.includeLeadingGap) {
      const anchor = layer.wordIds.map(id => byId.get(id)).find(w => w && wordPlays(segments, w));
      const instanceSegments = anchor?.instanceId ? segments.filter(s => segmentMatchesWord(s, anchor)) : segments;
      const first = words.filter(w => !w.isGap && wordPlays(instanceSegments, w))
        .map(w => ({id:w.id, time:timelineTimeForSourceTime(segments,w.start,w)}))
        .filter(w => w.time !== null).sort((a,b) => a.time! - b.time!)[0];
      if (first && layer.wordIds.includes(first.id)) start = instanceSegments[0]?.timelineStart ?? 0;
    }
    const end = Math.max(...times);
    return { layerId: layer.id, start, end, duration: Math.max(0, end - start), orphaned: false };
  });

  const ordered = timings
    .filter((timing) => !timing.orphaned)
    .sort((left, right) => left.start - right.start);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index]!;
    const next = ordered[index + 1]!;
    // Finite video clips cannot absorb gaps or shift their source clock.
    if (document.layers.find(l => l.id === current.layerId)?.media ||
        document.layers.find(l => l.id === next.layerId)?.media ||
        document.layers.find(l => l.id === current.layerId)?.animation ||
        document.layers.find(l => l.id === next.layerId)?.animation) continue;
    const gap = next.start - current.end;
    if (gap > 0 && gap <= LAYER_GAP_ABSORB_SECONDS) {
      // When the gap contains an edit cut, the cut decides who owns which
      // side: a hard cut in the footage is where the next shot begins, and
      // from that instant the picture is the next beat's business. Splitting
      // anywhere else leaves a sliver of the incoming shot uncovered — a
      // transparent annotation layer ahead of an opaque animation showed six
      // frames of stray footage exactly this way, and a viewer reads that as
      // a glitch, not a pause.
      let split = next.start;
      for (const segment of segments) {
        if (segment.timelineStart > current.end + 0.0005 && segment.timelineStart < next.start - 0.0005) {
          split = segment.timelineStart;
        }
      }
      current.end = split;
      current.duration = Math.max(0, current.end - current.start);
      if (split < next.start) {
        next.start = split;
        next.duration = Math.max(0, next.end - next.start);
      }
    }
  }
  for (const timing of timings) {
    const layer = document.layers.find(l => l.id === timing.layerId)!;
    if (layer.animation) timing.animation = resolveVisualAnimation(layer, words, editList, timing);
    const media = document.layers.find(l => l.id === timing.layerId)?.media;
    if (media && !timing.orphaned) {
      timing.end = Math.min(timing.end, timing.start + media.sourceOut - media.sourceIn);
      // EDL accumulation can produce 27.439999999999998. Chromium truncates
      // currentTime assignment to 27.439999, so normalize seek targets too.
      timing.start = Math.round(timing.start * 1_000_000) / 1_000_000;
      timing.end = Math.round(timing.end * 1_000_000) / 1_000_000;
      timing.duration = Math.max(0, timing.end - timing.start);
    }
  }
  return timings;
}

/**
 * Where on the source a moment of the cut came from, or null past the end.
 *
 * The inverse of the mapping the timings use. It exists so a person or an Agent
 * can *look at* the footage a layer will cover before deciding what to draw and
 * where: every frame-grabbing tool addresses the original file, while
 * everything a layer knows is expressed on the cut timeline.
 */
export function sourceTimeForCutTime(
  editList: EditListDocument | null,
  cutTime: number,
): number | null {
  for (const segment of orderedSegments(editList)) {
    const span = (segment.sourceEnd - segment.sourceStart) / segment.playbackRate;
    if (cutTime >= segment.timelineStart && cutTime < segment.timelineStart + span) {
      return segment.sourceStart + (cutTime - segment.timelineStart) * segment.playbackRate;
    }
  }
  return null;
}

/** Which layer is on screen at a moment, or null. Later layers win a tie. */
export function isVisualTimeActive(time: number, start: number, end: number): boolean {
  // Browsers round media seeks to microseconds; remove floating-point EDL noise,
  // not a frame-sized grace period. End remains exclusive, including adjacent layers.
  const micros = (value: number) => Math.round(value * 1_000_000);
  return micros(time) >= micros(start) && micros(time) < micros(end);
}

export function activeVisualLayer(
  timings: readonly VisualLayerTiming[],
  timelineTime: number,
): VisualLayerTiming | null {
  let active: VisualLayerTiming | null = null;
  for (const timing of timings) {
    if (timing.orphaned) continue;
    if (isVisualTimeActive(timelineTime, timing.start, timing.end)) active = timing;
  }
  return active;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new VideocutError("invalid_visuals", message, details);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A module path this product is willing to load.
 *
 * The document is written by an Agent and read by a browser, so the path is
 * untrusted input that ends up in a URL. Escaping the project directory has to
 * be refused here rather than caught downstream — by then it is already a
 * fetch.
 */
function assertModulePath(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`layers[${index}].module is required`);
  }
  const path = value.trim();
  if (path.startsWith("/") || /^[a-zA-Z]+:/.test(path)) {
    invalid(`layers[${index}].module must be relative to the project`, { path });
  }
  if (path.split("/").some((part) => part === "..")) {
    invalid(`layers[${index}].module must stay inside the project`, { path });
  }
  if (path.includes("\\")) {
    // The module path contract is URL-style: forward slashes only. Backslashes
    // would bypass the ".." check above and break overlay URL assembly.
    invalid(`layers[${index}].module must use forward slashes`, { path });
  }
  if (!path.toLowerCase().endsWith(".html")) {
    invalid(`layers[${index}].module must be an HTML module`, { path });
  }
  return path;
}

/**
 * Reject a document that cannot mean one thing.
 *
 * Two layers claiming the same word means two pictures on screen at once, and
 * the one you get depends on array order — the kind of fault that surfaces as a
 * rendering glitch three steps later.
 *
 * This raises `VideocutError`, not `TypeError`, because the callers that matter
 * are an HTTP handler and a CLI: a malformed document supplied by a client is
 * that client's fault and must come back as 400, not as "the product broke".
 */
export function assertVisualDocument(value: unknown): asserts value is VisualDocument {
  if (!isObject(value)) invalid("Visual document must be an object");
  if (value.schemaVersion !== VISUAL_SCHEMA_VERSION) {
    invalid(`Unsupported visual schema: ${String(value.schemaVersion)}`);
  }
  if (typeof value.projectId !== "string" || !value.projectId.trim()) {
    invalid("Visual document requires projectId");
  }
  if (typeof value.animationStyle !== "string" || !value.animationStyle.trim()) {
    invalid("Visual document requires animationStyle");
  }
  if (!Array.isArray(value.layers)) invalid("Visual document requires a layers array");

  const seenIds = new Set<string>();
  const claimedWords = new Map<string, string>();
  value.layers.forEach((layer, index) => {
    if (!isObject(layer)) invalid(`layers[${index}] must be an object`);
    const id = typeof layer.id === "string" ? layer.id.trim() : "";
    if (!id) invalid(`layers[${index}].id is required`);
    if (seenIds.has(id)) invalid(`Visual layer id is not unique: ${id}`);
    seenIds.add(id);
    if (layer.media !== undefined) {
      if (layer.module !== undefined || layer.zoom !== undefined || !isObject(layer.media))
        invalid(`layers[${index}] must choose media or HTML, without video zoom`);
      const { assetId, sourceIn, sourceOut, fit, muted, includeLeadingGap } = layer.media;
      if (typeof assetId !== "string" || !/^[a-f0-9]{64}$/.test(assetId) ||
          typeof sourceIn !== "number" || !Number.isFinite(sourceIn) || sourceIn < 0 ||
          typeof sourceOut !== "number" || !Number.isFinite(sourceOut) || sourceOut <= sourceIn ||
          sourceOut > 3600 || (fit !== "contain" && fit !== "cover") || muted !== true ||
          (includeLeadingGap !== undefined && typeof includeLeadingGap !== "boolean"))
        invalid(`layers[${index}].media requires a verified asset, bounded source range, fit and muted=true`);
    } else assertModulePath(layer.module, index);
    if (layer.zoom !== undefined) {
      if (!isObject(layer.zoom)) invalid(`layers[${index}].zoom must be an object`);
      const { x, y, width, height } = layer.zoom as Record<string, unknown>;
      for (const [name, value] of [["x", x], ["y", y], ["width", width], ["height", height]] as const) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          invalid(`layers[${index}].zoom.${String(name)} must be a number`);
        }
      }
      const zx = x as number, zy = y as number, zw = width as number, zh = height as number;
      // A region smaller than a tenth of the frame is a magnification past 10x —
      // at that point the "footage" is a smear of compression blocks, and the
      // request is almost certainly a typo rather than an intention.
      if (zw < 10 || zh < 10 || zx < 0 || zy < 0 || zx + zw > 100 || zy + zh > 100) {
        invalid(`layers[${index}].zoom must be a region inside the frame, at least 10% on each side`, {
          zoom: layer.zoom,
        });
      }
    }
    if (!Array.isArray(layer.wordIds) || layer.wordIds.length === 0) {
      invalid(`layers[${index}].wordIds must name the words this layer covers`);
    }
    if (layer.animation !== undefined) {
      const a = layer.animation;
      if (!isObject(a) || layer.media !== undefined || a.schemaVersion !== 1 || a.clock !== "local0"
        || Object.keys(a).some(key => !["schemaVersion", "clock", "authoredDuration", "anchorWordIds", "canvas"].includes(key))
        || typeof a.authoredDuration !== "number" || !Number.isFinite(a.authoredDuration)
        || a.authoredDuration <= 0 || a.authoredDuration > 3600
        || !Array.isArray(a.anchorWordIds) || a.anchorWordIds.length === 0
        || new Set(a.anchorWordIds).size !== a.anchorWordIds.length
        || a.anchorWordIds.some(id => typeof id !== "string" || !(layer.wordIds as unknown[]).includes(id))
        || (a.canvas !== undefined && a.canvas !== "project" && a.canvas !== "source")
        || ((a.canvas ?? "project") === "project" && layer.zoom !== undefined)) {
        invalid(`layers[${index}].animation requires a bounded local0 basis and stable layer word anchors`);
      }
    }
    for (const wordId of layer.wordIds) {
      if (typeof wordId !== "string" || !wordId.trim()) {
        invalid(`layers[${index}].wordIds must contain word ids`);
      }
      const owner = claimedWords.get(wordId);
      if (owner) {
        invalid(`Word ${wordId} is claimed by two visual layers: ${owner} and ${id}`);
      }
      claimedWords.set(wordId, id);
    }
  });
}
