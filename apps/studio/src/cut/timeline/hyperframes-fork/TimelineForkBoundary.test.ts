import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GUTTER,
  MIN_TIMELINE_EXTENT_S,
  RULER_H,
  TRACK_H,
  TRACKS_BOTTOM_PAD,
  TRACKS_LEFT_PAD,
  TRACKS_TOP_PAD,
  getTimelineCanvasHeight,
  getTimelineDisplayContentWidth,
  getTimelineFitPps,
} from "./timelineLayout";
import {
  MAX_TIMELINE_ZOOM_PERCENT,
  MIN_TIMELINE_ZOOM_PERCENT,
  clampTimelineZoomPercent,
  timelineSliderToZoomPercent,
  timelineZoomPercentToSlider,
} from "./timelineZoom";

const upstreamRoot = fileURLToPath(new URL("../hf-upstream-0.7.60/", import.meta.url));
const forkRoot = fileURLToPath(new URL("./", import.meta.url));
const cutTimelinePath = fileURLToPath(new URL("../CutTimeline.tsx", import.meta.url));

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = `${directory}/${entry}`;
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry) && !/\.test\.(?:ts|tsx)$/.test(entry)
      ? [path]
      : [];
  });
}

describe("Product-owned HyperFrames 0.7.60 Timeline fork boundary", () => {
  it("keeps the complete immutable upstream source snapshot byte-for-byte", () => {
    const manifest = readFileSync(`${upstreamRoot}/SHA256SUMS`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(line);
        if (!match) throw new Error(`Invalid upstream checksum row: ${line}`);
        return { expectedHash: match[1]!, relativePath: match[2]! };
      });

    expect(manifest).toHaveLength(114);
    for (const { expectedHash, relativePath } of manifest) {
      const actualHash = createHash("sha256")
        .update(readFileSync(`${upstreamRoot}/${relativePath}`))
        .digest("hex");
      expect(actualHash, relativePath).toBe(expectedHash);
    }

    const provenance = readFileSync(`${upstreamRoot}/PROVENANCE.md`, "utf8");
    expect(provenance).toContain("@hyperframes/studio");
    expect(provenance).toContain("0.7.60");
    expect(provenance).toContain("114 个");
  });

  it("preserves physical 60-second empty-space geometry without extending fit time", () => {
    expect({
      gutter: GUTTER,
      leftPad: TRACKS_LEFT_PAD,
      ruler: RULER_H,
      topPad: TRACKS_TOP_PAD,
      videoLane: TRACK_H,
      audioLane: TRACK_H,
      bottomPad: TRACKS_BOTTOM_PAD,
      canvas: getTimelineCanvasHeight(2),
    }).toEqual({
      gutter: 32,
      leftPad: 48,
      ruler: 24,
      topPad: 50,
      videoLane: 48,
      audioLane: 48,
      bottomPad: 72,
      canvas: 242,
    });
    expect(MIN_TIMELINE_EXTENT_S).toBe(60);

    const viewportWidth = 800;
    const availableWidth = viewportWidth - GUTTER - TRACKS_LEFT_PAD - 2;
    const shortFitPps = getTimelineFitPps(viewportWidth, 10);
    const longFitPps = getTimelineFitPps(viewportWidth, 100);
    expect(shortFitPps).toBeCloseTo(availableWidth / 60, 12);
    expect(longFitPps).toBeCloseTo(availableWidth / 100, 12);
    expect(getTimelineDisplayContentWidth({
      trackContentWidth: 10 * shortFitPps,
      viewportWidth,
      pps: shortFitPps,
    })).toBeCloseTo(60 * shortFitPps, 12);
  });

  it("retains the 10%-2000% logarithmic zoom contract", () => {
    expect(MIN_TIMELINE_ZOOM_PERCENT).toBe(10);
    expect(MAX_TIMELINE_ZOOM_PERCENT).toBe(2000);
    expect(clampTimelineZoomPercent(-1)).toBe(10);
    expect(clampTimelineZoomPercent(20_001)).toBe(2000);

    for (const percent of [10, 25, 100, 500, 2000]) {
      expect(
        timelineSliderToZoomPercent(timelineZoomPercentToSlider(percent)),
      ).toBeCloseTo(percent, -1);
    }
    // A logarithmic midpoint is the geometric, not arithmetic, midpoint.
    expect(timelineSliderToZoomPercent(50)).toBeLessThan((10 + 2000) / 2);
  });

  it("keeps runtime on Product props/Core and never imports the audit snapshot or Player Store", () => {
    const runtimeFiles = [...listSourceFiles(forkRoot), cutTimelinePath];
    const runtimeSource = runtimeFiles
      .map((path) => `\n/* ${path} */\n${readFileSync(path, "utf8")}`)
      .join("\n");

    expect(runtimeSource).not.toMatch(/from\s+["'][^"']*hf-upstream-0\.7\.60/);
    expect(runtimeSource).not.toMatch(/from\s+["'][^"']*vendor\/hyperframes/);
    expect(runtimeSource).not.toContain("usePlayerStore");
    expect(runtimeSource).not.toMatch(/from\s+["']@hyperframes\/player/);
    expect(runtimeSource).not.toContain("<audio");

    const canvasSource = readFileSync(`${forkRoot}/TimelineCanvas.tsx`, "utf8");
    const lanesSource = readFileSync(`${forkRoot}/TimelineLanes.tsx`, "utf8");
    const reduction = readFileSync(`${forkRoot}/REDUCTION.md`, "utf8");
    expect(lanesSource).toContain("TimelineLaneBaseProps");
    expect(canvasSource).toContain("onSegmentResizeStart");
    expect(lanesSource).toContain('data-linked-segment-id');
    for (const retainedFile of [
      "Timeline.tsx",
      "TimelineCanvas.tsx",
      "TimelineLanes.tsx",
      "TimelineTypes.ts",
      "TimelineToolbar.tsx",
      "TimelineRuler.tsx",
      "TimelineClip.tsx",
      "PlayheadIndicator.tsx",
      "timelineLayout.ts",
      "timelineSnapping.ts",
      "timelineTheme.ts",
      "timelineZoom.ts",
    ]) {
      expect(statSync(`${forkRoot}/${retainedFile}`).isFile(), retainedFile).toBe(true);
    }
    expect(reduction).toContain("Only these upstream branches are deleted");
    expect(reduction).toContain("usePlayerStore");
    expect(reduction).toContain("keyframes and GSAP controls");
    expect(reduction).toContain("selection, snapping");
  });
});
