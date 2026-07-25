import { describe, expect, it } from "vitest";
import {
  TIMELINE_SNAP_PX,
  collectTimelineSnapTargets,
  snapTimelineTime,
} from "./timelineSnapping";

describe("Product-owned HyperFrames timeline snapping fork", () => {
  it("collects linked clip edges while excluding the actively trimmed group", () => {
    expect(collectTimelineSnapTargets({
      elements: [
        { id: "a", start: 0, duration: 4 },
        { id: "b", start: 4, duration: 6 },
      ],
      playheadTime: 2,
      excludeElementId: "a",
    })).toEqual([
      { time: 2, type: "playhead" },
      { time: 4, type: "clip-edge" },
      { time: 10, type: "clip-edge" },
    ]);
  });

  it("uses the upstream eight-pixel threshold and playhead priority", () => {
    const pixelsPerSecond = 20;
    const threshold = TIMELINE_SNAP_PX / pixelsPerSecond;
    expect(snapTimelineTime(4.2, [
      { time: 4, type: "clip-edge" },
      { time: 4.1, type: "playhead" },
    ], threshold)).toEqual({
      time: 4.1,
      target: { time: 4.1, type: "playhead" },
    });
    expect(snapTimelineTime(4.5, [
      { time: 4, type: "clip-edge" },
    ], threshold)).toEqual({ time: 4.5, target: null });
  });
});

