import { describe, expect, it } from "bun:test";
import type { EditListDocument } from "@video-workbench/contracts";
import type { TimedWord } from "./cuts";
import {
  buildExportPlan,
  cropRectForBox,
  visibleBoxForZoom,
  type BuildExportPlanInput,
} from "./exportPlan";
import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_SCHEMA_VERSION,
  type SubtitleDocument,
} from "./subtitles";
import { createVisualDocument, type VisualDocument } from "./visuals";

function editList(segments: Array<[number, number, number]>): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "export-contract",
    sourceDuration: 100,
    baseCutsRevision: "b".repeat(64),
    baseTranscriptRevision: "a".repeat(64),
    mode: "manual",
    duration: segments.reduce((total, [start, end]) => total + (end - start), 0),
    segments: segments.map(([sourceStart, sourceEnd, timelineStart], index) => ({
      id: `seg-${index}`,
      sourceStart,
      sourceEnd,
      timelineStart,
      playbackRate: 1,
    })),
  } as EditListDocument;
}

const words: TimedWord[] = Array.from({ length: 10 }, (_, index) => ({
  id: `w-${index + 1}`,
  text: "字",
  start: index,
  end: index + 1,
}));

function subtitles(cues: Array<[string, string[]]>): SubtitleDocument {
  return {
    schemaVersion: SUBTITLE_SCHEMA_VERSION,
    projectId: "export-contract",
    baseTranscriptRevision: "a".repeat(64),
    style: DEFAULT_SUBTITLE_STYLE,
    cues: cues.map(([text, wordIds], index) => ({ id: `sub-${index}`, text, wordIds })),
  };
}

function visuals(
  layers: Array<{ id: string; wordIds: string[]; zoom?: { x: number; y: number; width: number; height: number } }>,
): VisualDocument {
  return {
    ...createVisualDocument("export-contract", "a".repeat(64)),
    layers: layers.map((layer) => ({
      id: layer.id,
      wordIds: layer.wordIds,
      module: `modules/${layer.id}/index.html`,
      ...(layer.zoom ? { zoom: layer.zoom } : {}),
    })),
  };
}

function plan(overrides: Partial<BuildExportPlanInput> = {}) {
  return buildExportPlan({
    editList: editList([[0, 10, 0]]),
    words,
    subtitles: null,
    visuals: null,
    source: { width: 960, height: 720, duration: 100, frameRate: 60 },
    ...overrides,
  });
}

describe("export plan", () => {
  it("makes the film a whole number of pictures and doubles the frame by default", () => {
    const result = plan();
    expect(result.duration).toBeCloseTo(10, 6);
    expect(result.frameCount).toBe(600);
    expect(result.output).toEqual({ width: 1920, height: 1440 });
  });

  it("keeps every dimension even, because 4:2:0 has no odd size", () => {
    const result = plan({ source: { width: 961, height: 721, duration: 100, frameRate: 30 }, scale: 1 });
    expect(result.output.width % 2).toBe(0);
    expect(result.output.height % 2).toBe(0);
  });

  it("refuses a speed change rather than exporting it at 1x", () => {
    const document = editList([[0, 10, 0]]);
    document.segments[0]!.playbackRate = 1.5;
    expect(() => plan({ editList: document })).toThrow(/speed changes/);
  });

  describe("push-in spans", () => {
    it("covers the whole film with no gap and no overlap", () => {
      const result = plan({
        visuals: visuals([
          { id: "vis-1", wordIds: ["w-3", "w-4"], zoom: { x: 20, y: 20, width: 50, height: 50 } },
          { id: "vis-2", wordIds: ["w-7"], zoom: { x: 0, y: 0, width: 60, height: 60 } },
        ]),
      });
      expect(result.zoomSpans[0]!.startFrame).toBe(0);
      expect(result.zoomSpans.at(-1)!.endFrame).toBe(result.frameCount);
      for (let index = 1; index < result.zoomSpans.length; index += 1) {
        expect(result.zoomSpans[index]!.startFrame).toBe(result.zoomSpans[index - 1]!.endFrame);
      }
    });

    it("adds up to exactly the film's frame count", () => {
      // The renderer reassembles the film span by span. One frame more or less
      // in the total slides every drawing after it off the words it belongs to.
      const result = plan({
        visuals: visuals([
          { id: "vis-1", wordIds: ["w-2"], zoom: { x: 10, y: 10, width: 40, height: 40 } },
          { id: "vis-2", wordIds: ["w-5"], zoom: { x: 10, y: 10, width: 40, height: 40 } },
          { id: "vis-3", wordIds: ["w-9"], zoom: { x: 10, y: 10, width: 40, height: 40 } },
        ]),
      });
      const total = result.zoomSpans.reduce(
        (sum, span) => sum + (span.endFrame - span.startFrame),
        0,
      );
      expect(total).toBe(result.frameCount);
    });

    it("is one plain span when nothing pushes in", () => {
      const result = plan({ visuals: visuals([{ id: "vis-1", wordIds: ["w-2"] }]) });
      expect(result.zoomSpans).toHaveLength(1);
      expect(result.zoomSpans[0]!.box).toBeNull();
    });
  });

  describe("visible box", () => {
    it("keeps the frame's own shape, on the axis that needs less magnification", () => {
      // The preview scales by min(100/w, 100/h) and keeps the frame shape, so
      // what is on screen is a frame-shaped box around the request, never the
      // request itself. A module points its viewBox at the request and lets
      // `preserveAspectRatio="meet"` do the same thing — these two have to
      // land on the same pixels or the drawing sits off the footage.
      const box = visibleBoxForZoom({ x: 18.75, y: 18.75, width: 62.5, height: 62.5 });
      expect(box.width).toBeCloseTo(0.625, 6);
      expect(box.height).toBeCloseTo(0.625, 6);
      expect(box.x).toBeCloseTo(0.1875, 6);
      expect(box.y).toBeCloseTo(0.1875, 6);
    });

    it("uses the gentler axis when the request is not square", () => {
      const box = visibleBoxForZoom({ x: 10, y: 40, width: 80, height: 20 });
      // 100/80 is gentler than 100/20, so the box is 80% of the frame.
      expect(box.width).toBeCloseTo(0.8, 6);
      expect(box.height).toBeCloseTo(0.8, 6);
    });

    it("stays inside the frame instead of pulling the border into view", () => {
      const box = visibleBoxForZoom({ x: 0, y: 60, width: 40, height: 40 });
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(box.y + box.height).toBeLessThanOrEqual(1 + 1e-9);
    });

    it("crops to even pixels that stay within the source", () => {
      const rect = cropRectForBox(
        visibleBoxForZoom({ x: 5, y: 37.5, width: 62.5, height: 62.5 }),
        { width: 960, height: 720 },
      );
      expect(rect).toEqual({ width: 600, height: 450, x: 48, y: 270 });
      expect(rect.x + rect.width).toBeLessThanOrEqual(960);
      expect(rect.y + rect.height).toBeLessThanOrEqual(720);
    });
  });

  describe("what is drawn", () => {
    it("moves a layer's script onto the layer's own clock", () => {
      const result = plan({
        subtitles: subtitles([["前面", ["w-1"]], ["层里第一句", ["w-3"]], ["层里第二句", ["w-4"]]]),
        visuals: visuals([{ id: "vis-1", wordIds: ["w-3", "w-4"] }]),
      });
      const layer = result.layers[0]!;
      expect(layer.start).toBeCloseTo(2, 6);
      expect(layer.cues.map((cue) => cue.text)).toEqual(["层里第一句", "层里第二句"]);
      // A module knows nothing about where it sits in the film.
      expect(layer.cues[0]!.start).toBeCloseTo(0, 6);
      expect(layer.cues[1]!.start).toBeCloseTo(1, 6);
    });

    it("says out loud when a screen or a layer lost all its words", () => {
      const result = plan({
        editList: editList([[5, 10, 0]]),
        subtitles: subtitles([["剪掉了", ["w-1"]], ["还在", ["w-7"]]]),
        visuals: visuals([{ id: "vis-1", wordIds: ["w-2"] }]),
      });
      expect(result.subtitleCues.map((cue) => cue.text)).toEqual(["还在"]);
      expect(result.layers).toHaveLength(0);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings.join(" ")).toContain("字幕");
      expect(result.warnings.join(" ")).toContain("画面层");
    });

    it("drops a screen with no text rather than drawing an empty plate", () => {
      const result = plan({ subtitles: subtitles([["   ", ["w-1"]], ["有字", ["w-2"]]]) });
      expect(result.subtitleCues.map((cue) => cue.text)).toEqual(["有字"]);
    });
  });
});
