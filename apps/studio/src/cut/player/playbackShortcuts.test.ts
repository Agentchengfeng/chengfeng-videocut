import { describe, expect, it } from "vitest";
import {
  resolveCutPlaybackShortcut,
  seekTargetForFrameDelta,
} from "./playbackShortcuts";

function keyboard(code: string, input: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    code,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...input,
  };
}

describe("Product playback shortcuts", () => {
  it("maps only playback actions supported by the Product kernel", () => {
    expect(resolveCutPlaybackShortcut(keyboard("Space"))).toEqual({ type: "toggle-play" });
    expect(resolveCutPlaybackShortcut(keyboard("ArrowRight"))).toEqual({ type: "seek-frames", frames: 1 });
    expect(resolveCutPlaybackShortcut(keyboard("ArrowLeft", { shiftKey: true }))).toEqual({ type: "seek-frames", frames: -10 });
    expect(resolveCutPlaybackShortcut(keyboard("KeyM"))).toEqual({ type: "toggle-muted" });
    expect(resolveCutPlaybackShortcut(keyboard("KeyL", { shiftKey: true }))).toEqual({ type: "toggle-loop" });
    expect(resolveCutPlaybackShortcut(keyboard("KeyK"))).toEqual({ type: "pause" });
    expect(resolveCutPlaybackShortcut(keyboard("KeyF"))).toEqual({ type: "toggle-fullscreen" });
    expect(resolveCutPlaybackShortcut(keyboard("KeyJ"))).toBeNull();
    expect(resolveCutPlaybackShortcut(keyboard("KeyL"))).toBeNull();
  });

  it("clamps frame steps to the edited timeline", () => {
    expect(seekTargetForFrameDelta(12, 1, 30)).toBeCloseTo(12 + 1 / 30);
    expect(seekTargetForFrameDelta(0, -10, 30)).toBe(0);
    expect(seekTargetForFrameDelta(29.9, 10, 30)).toBe(30);
  });
});
