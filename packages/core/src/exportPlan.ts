/**
 * The export plan: what the film is, decided before a single frame is touched.
 *
 * Everything upstream of here is annotation. The edit list says which words
 * play, the subtitle document says what is written, the visual document says
 * what is drawn — and none of them render anything. Export is the one place
 * that turns all three into pixels, so it is the one place where they have to
 * be reconciled against each other.
 *
 * This file does the reconciling and nothing else: no ffmpeg, no browser, no
 * disk. It reads the three documents and produces a plain description of the
 * film — how long, how many frames, which source spans, where the picture is
 * pushed in, what is drawn over each moment. That separation is deliberate:
 * the arithmetic that decides whether the export matches the preview is the
 * part most worth testing, and it should not need a video file to test.
 *
 * The invariant it exists to keep: **the plan is computed from the same
 * helpers the preview draws from.** Not a second implementation that agrees by
 * inspection — the same `subtitleCueTimings`, the same `visualLayerTimings`.
 * A film that disagrees with its own preview is worse than no export.
 */

import type { TimedWord } from "./cuts";
import type { EditListDocument, EditListSegment } from "./editList";
import { VideocutError } from "./errors";
import {
  orderedSegments,
  subtitleCueTimings,
  type SubtitleDocument,
  type SubtitleStyle,
} from "./subtitles";
import { visualLayerTimings, type VisualDocument, type VisualZoom } from "./visuals";

/**
 * How much bigger than the source the film is rendered.
 *
 * Two is not a guess about the footage — an upscale invents no detail, and the
 * screen recording this product edits is 960×720 whatever we do to it. It is
 * about everything drawn *on* the footage: subtitles and modules are redrawn
 * at the output size, so at 2× their type and strokes are genuinely twice the
 * resolution, and those are the parts of the frame a viewer reads. It also
 * buys the footage a second-order win, because every platform re-encodes what
 * it is given and allocates a larger frame more bits.
 */
export const EXPORT_DEFAULT_SCALE = 2;

/** A frame's pixel dimensions. Always even, because 4:2:0 chroma is subsampled. */
export interface ExportFrameSize {
  width: number;
  height: number;
}

/** One retained span of the source, in the order it plays. */
export interface ExportSourceSpan {
  sourceStart: number;
  sourceEnd: number;
}

/**
 * A region of the source frame, as fractions of it, shaped like the output.
 *
 * A stored zoom is an arbitrary rectangle — "the input box", "the result
 * panel" — and the preview does not show exactly that rectangle: it scales the
 * picture by whichever axis needs less magnification and keeps the frame's own
 * shape. So what is actually on screen is a frame-shaped box around the
 * requested region, and *that* is what an export has to reproduce. Resolving
 * it here rather than in the ffmpeg call is what makes the two agree.
 */
export interface ExportVisibleBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A stretch of the cut timeline held at one push-in (or at none). */
export interface ExportZoomSpan {
  start: number;
  end: number;
  /**
   * The same span counted in pictures, and the number the renderer actually
   * uses.
   *
   * The film is reassembled from these spans, so a span that yields one frame
   * fewer than its seconds implied does not shorten the film — it slides
   * everything after it against the overlay, and the drawings come away from
   * the words by a frame that no one can find. Snapping the boundaries to
   * whole frames here means the spans add up to exactly `frameCount`, by
   * construction rather than by luck.
   */
  startFrame: number;
  endFrame: number;
  /** Null means the whole frame: no crop, just the scale to output size. */
  box: ExportVisibleBox | null;
}

/** A subtitle screen, timed on the cut. */
export interface ExportSubtitleCue {
  cueId: string;
  text: string;
  start: number;
  end: number;
}

/** A drawn layer, timed on the cut, with the script under it on its own clock. */
export interface ExportVisualLayer {
  layerId: string;
  /** Project-relative path to the module's HTML. */
  module: string;
  start: number;
  end: number;
  duration: number;
  zoom: VisualZoom | null;
  cues: Array<{ text: string; start: number; end: number }>;
}

export interface ExportPlan {
  /** Length of the finished film, in seconds. */
  duration: number;
  fps: number;
  /** Exactly how many pictures the film is. The overlay renders this many. */
  frameCount: number;
  source: ExportFrameSize;
  output: ExportFrameSize;
  /** The retained source spans, in play order. */
  spans: ExportSourceSpan[];
  /** Contiguous, gapless, covering the whole film. */
  zoomSpans: ExportZoomSpan[];
  subtitleStyle: SubtitleStyle | null;
  subtitleCues: ExportSubtitleCue[];
  layers: ExportVisualLayer[];
  /** Things a person should be told about but that do not stop the export. */
  warnings: string[];
}

export interface BuildExportPlanInput {
  editList: EditListDocument | null;
  words: readonly TimedWord[];
  subtitles: SubtitleDocument | null;
  visuals: VisualDocument | null;
  source: ExportFrameSize & { duration: number; frameRate: number };
  /** Output size multiplier. Defaults to {@link EXPORT_DEFAULT_SCALE}. */
  scale?: number;
  /** Output frame rate. Defaults to the source's. */
  fps?: number;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new VideocutError("invalid_argument", message, details);
}

/** Chroma is subsampled two-to-one, so an odd dimension has no legal encoding. */
function evenUp(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function evenDown(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * The frame-shaped box the preview actually shows for a stored zoom.
 *
 * Mirrors the preview's transform exactly: `scale = min(100/width, 100/height)`
 * — the axis that needs less magnification wins, so nothing requested is ever
 * cropped away — centred on the requested region.
 *
 * It differs from the preview in one way, on purpose: the box is clamped
 * inside the frame. The preview lets a region near an edge pull the frame's
 * border into view, where it reads as a rendering glitch; a film cannot ship
 * black down one side because a rectangle was drawn near the margin.
 */
export function visibleBoxForZoom(zoom: VisualZoom): ExportVisibleBox {
  const scale = Math.min(100 / zoom.width, 100 / zoom.height);
  const width = Math.min(1, 1 / scale);
  const height = Math.min(1, 1 / scale);
  const centerX = (zoom.x + zoom.width / 2) / 100;
  const centerY = (zoom.y + zoom.height / 2) / 100;
  return {
    x: Math.min(Math.max(centerX - width / 2, 0), 1 - width),
    y: Math.min(Math.max(centerY - height / 2, 0), 1 - height),
    width,
    height,
  };
}

function spansFromEditList(editList: EditListDocument | null): {
  spans: ExportSourceSpan[];
  segments: EditListSegment[];
  duration: number;
} {
  const segments = orderedSegments(editList);
  if (segments.length === 0) {
    invalid("This project has no edit list, so there is nothing to export");
  }
  const offSpeed = segments.find((segment) => segment.playbackRate !== 1);
  if (offSpeed) {
    // Speed changes would have to be applied to the footage, the audio and the
    // module clock at once. Nothing in the product produces them today, so the
    // export refuses rather than silently exporting them at 1×.
    invalid("Export does not support speed changes yet", {
      segmentId: offSpeed.id,
      playbackRate: offSpeed.playbackRate,
    });
  }
  const spans = segments.map((segment) => ({
    sourceStart: segment.sourceStart,
    sourceEnd: segment.sourceEnd,
  }));
  const duration = spans.reduce(
    (total, span) => total + (span.sourceEnd - span.sourceStart),
    0,
  );
  return { spans, segments, duration };
}

/**
 * The push-in timeline: one entry per stretch, contiguous and gapless.
 *
 * Gapless because the ffmpeg side reassembles the film from these spans, so a
 * hole in the list is a hole in the film. Zoomed stretches are laid down
 * first, and the plain footage fills whatever is left between them.
 */
function zoomSpansForLayers(
  layers: readonly ExportVisualLayer[],
  frameCount: number,
  fps: number,
): ExportZoomSpan[] {
  const zoomed = layers
    .filter((layer) => layer.zoom)
    .map((layer) => ({
      startFrame: Math.max(0, Math.round(layer.start * fps)),
      endFrame: Math.min(frameCount, Math.round(layer.end * fps)),
      box: visibleBoxForZoom(layer.zoom!),
    }))
    .filter((span) => span.endFrame > span.startFrame)
    .sort((left, right) => left.startFrame - right.startFrame);

  const bounds: Array<{ startFrame: number; endFrame: number; box: ExportVisibleBox | null }> = [];
  let cursor = 0;
  for (const span of zoomed) {
    // Two layers pushing in at once cannot happen — a word belongs to one layer
    // — but a rounding overlap can, and it must not produce a negative span.
    const startFrame = Math.max(span.startFrame, cursor);
    if (startFrame > cursor) bounds.push({ startFrame: cursor, endFrame: startFrame, box: null });
    if (span.endFrame > startFrame) {
      bounds.push({ startFrame, endFrame: span.endFrame, box: span.box });
      cursor = span.endFrame;
    } else {
      cursor = Math.max(cursor, startFrame);
    }
  }
  if (frameCount > cursor) bounds.push({ startFrame: cursor, endFrame: frameCount, box: null });
  if (bounds.length === 0) bounds.push({ startFrame: 0, endFrame: frameCount, box: null });
  return bounds.map((span) => ({
    ...span,
    start: span.startFrame / fps,
    end: span.endFrame / fps,
  }));
}

export function buildExportPlan(input: BuildExportPlanInput): ExportPlan {
  const warnings: string[] = [];
  const { spans, duration } = spansFromEditList(input.editList);
  if (!(duration > 0)) invalid("The edit list keeps nothing, so there is no film to export");

  const scale = input.scale ?? EXPORT_DEFAULT_SCALE;
  if (!(scale > 0) || !Number.isFinite(scale)) invalid("Export scale must be a positive number");
  if (!(input.source.width > 0) || !(input.source.height > 0)) {
    invalid("The source has no readable frame size");
  }
  const fps = input.fps ?? input.source.frameRate;
  if (!(fps > 0) || !Number.isFinite(fps)) invalid("The source has no readable frame rate");

  const output: ExportFrameSize = {
    width: evenUp(input.source.width * scale),
    height: evenUp(input.source.height * scale),
  };

  const subtitleTimings = input.subtitles
    ? subtitleCueTimings(input.subtitles, input.words, input.editList)
    : [];
  const subtitleById = new Map((input.subtitles?.cues ?? []).map((cue) => [cue.id, cue]));
  const orphanedSubtitles = subtitleTimings.filter((timing) => timing.orphaned).length;
  if (orphanedSubtitles > 0) {
    warnings.push(`${orphanedSubtitles} 条字幕的词已经被剪掉，不会出现在成片里`);
  }
  const subtitleCues: ExportSubtitleCue[] = subtitleTimings
    .filter((timing) => !timing.orphaned)
    .map((timing) => ({
      cueId: timing.cueId,
      text: subtitleById.get(timing.cueId)?.text ?? "",
      start: timing.start,
      end: timing.end,
    }))
    .filter((cue) => cue.text.trim().length > 0)
    .sort((left, right) => left.start - right.start);

  const layerTimings = input.visuals
    ? visualLayerTimings(input.visuals, input.words, input.editList)
    : [];
  const orphanedLayers = layerTimings.filter((timing) => timing.orphaned).length;
  if (orphanedLayers > 0) {
    warnings.push(`${orphanedLayers} 个画面层的词已经被剪掉，不会出现在成片里`);
  }
  const layerById = new Map((input.visuals?.layers ?? []).map((layer) => [layer.id, layer]));
  const layers: ExportVisualLayer[] = layerTimings
    .filter((timing) => !timing.orphaned)
    .flatMap((timing) => {
      const layer = layerById.get(timing.layerId);
      if (!layer) return [];
      return [{
        layerId: layer.id,
        module: layer.module,
        start: timing.start,
        end: timing.end,
        duration: timing.duration,
        zoom: layer.zoom ?? null,
        // The script under the layer, moved onto the layer's own clock. Same
        // list the preview hands a module, so a module written against the
        // preview lands identically in the film.
        cues: subtitleCues
          .filter((cue) => cue.end > timing.start && cue.start < timing.end)
          .map((cue) => ({
            text: cue.text,
            start: cue.start - timing.start,
            end: cue.end - timing.start,
          })),
      }];
    })
    .sort((left, right) => left.start - right.start);

  // The film is a whole number of pictures, and that number is decided here
  // rather than by whichever of ffmpeg and the browser rounds first.
  const frameCount = Math.max(1, Math.round(duration * fps));
  const zoomSpans = zoomSpansForLayers(layers, frameCount, fps);
  for (const span of zoomSpans) {
    if (!span.box) continue;
    const cropWidth = evenDown(span.box.width * input.source.width);
    const cropHeight = evenDown(span.box.height * input.source.height);
    if (cropWidth < 16 || cropHeight < 16) {
      invalid("A push-in crops the frame down to nothing", { span });
    }
  }

  return {
    duration,
    fps,
    frameCount,
    source: { width: input.source.width, height: input.source.height },
    output,
    spans,
    zoomSpans,
    subtitleStyle: input.subtitles?.style ?? null,
    subtitleCues,
    layers,
    warnings,
  };
}

/**
 * The crop rectangle for a zoom span, in source pixels.
 *
 * Kept beside the box arithmetic instead of inside the ffmpeg call so both are
 * covered by the same tests, and so the rounding to even pixels happens once.
 */
export function cropRectForBox(
  box: ExportVisibleBox,
  source: ExportFrameSize,
): { width: number; height: number; x: number; y: number } {
  const width = Math.min(evenDown(box.width * source.width), source.width);
  const height = Math.min(evenDown(box.height * source.height), source.height);
  return {
    width,
    height,
    x: Math.min(Math.max(evenDown(box.x * source.width), 0), source.width - width),
    y: Math.min(Math.max(evenDown(box.y * source.height), 0), source.height - height),
  };
}
