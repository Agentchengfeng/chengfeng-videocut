import { describe, expect, it } from "vitest";
import { resolveSeekPercent } from "./PlayerControls";
import { shouldMutePreviewAudio } from "../lib/timelineIframeHelpers";

describe("resolveSeekPercent", () => {
  it("returns 0 when the track width is invalid", () => {
    expect(resolveSeekPercent(100, 0, 0)).toBe(0);
  });

  it("snaps to the start within the edge threshold", () => {
    expect(resolveSeekPercent(105, 100, 200)).toBe(0);
  });

  it("snaps to the end within the edge threshold", () => {
    expect(resolveSeekPercent(298, 100, 200)).toBe(1);
  });

  it("preserves the true percent away from the edges", () => {
    expect(resolveSeekPercent(150, 100, 200)).toBe(0.25);
  });
});

describe("shouldMutePreviewAudio", () => {
  it("mutes when the user toggled audio off", () => {
    expect(shouldMutePreviewAudio(true, 1)).toBe(true);
  });

  it("keeps audio enabled at every playback rate unless the user muted it", () => {
    expect(shouldMutePreviewAudio(false, 2)).toBe(false);
    expect(shouldMutePreviewAudio(false, 1.5)).toBe(false);
    expect(shouldMutePreviewAudio(false, 1)).toBe(false);
    expect(shouldMutePreviewAudio(false, 0.5)).toBe(false);
  });
});
