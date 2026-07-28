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
 * There is exactly one kind of thing here: an HTML module laid over the
 * picture. The three things a person can want — footage as-is, footage with a
 * region called out, an animated explanation — are "no layer", "a transparent
 * layer that draws on the footage", and "a layer that draws its own picture".
 * One mechanism, three uses; no enum, and nothing to keep in sync.
 *
 * Nothing renders. The layer is composited live in the preview and burned in
 * once, at export.
 */

import { VideocutError } from "./errors";
import type { EditListDocument } from "./editList";
import type { TimedWord } from "./cuts";
import { orderedSegments, timelineTimeForSourceTime, wordPlays } from "./subtitles";

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

export interface VisualLayer {
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
  module: string;
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
  layerId: string;
  /** Seconds on the cut timeline. */
  start: number;
  end: number;
  duration: number;
  /** Every word this layer covers is gone from the edit; it cannot be placed. */
  orphaned: boolean;
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
export function visualLayerTimings(
  document: VisualDocument,
  words: readonly TimedWord[],
  editList: EditListDocument | null,
): VisualLayerTiming[] {
  const segments = orderedSegments(editList);
  const byId = new Map(words.map((word) => [word.id, word]));
  return document.layers.map((layer) => {
    const times: number[] = [];
    for (const wordId of layer.wordIds) {
      const word = byId.get(wordId);
      if (!word || !wordPlays(segments, word)) continue;
      const start = timelineTimeForSourceTime(segments, word.start);
      const end = timelineTimeForSourceTime(segments, word.end);
      if (start !== null) times.push(start);
      if (end !== null) times.push(end);
    }
    if (times.length === 0) {
      return { layerId: layer.id, start: 0, end: 0, duration: 0, orphaned: true };
    }
    const start = Math.min(...times);
    const end = Math.max(...times);
    return { layerId: layer.id, start, end, duration: Math.max(0, end - start), orphaned: false };
  });
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
export function activeVisualLayer(
  timings: readonly VisualLayerTiming[],
  timelineTime: number,
): VisualLayerTiming | null {
  let active: VisualLayerTiming | null = null;
  for (const timing of timings) {
    if (timing.orphaned) continue;
    if (timelineTime >= timing.start && timelineTime < timing.end) active = timing;
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
    assertModulePath(layer.module, index);
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
