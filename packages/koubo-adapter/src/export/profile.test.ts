import { describe, expect, it } from "bun:test";
import { finalEncodingSettings, resolveExportProfile } from "./profile";

describe("export profiles", () => {
  it("preserves the existing master defaults", () => {
    expect(resolveExportProfile({
      sourceWidth: 2880,
      sourceHeight: 2160,
      sourceFrameRate: 60,
    })).toEqual({ profile: "master", scale: undefined, fps: undefined });
    expect(finalEncodingSettings("master")).toEqual({ crf: "16", preset: "slow" });
  });

  it("caps a Retina 4:3 source at 1440x1080 and 30fps", () => {
    expect(resolveExportProfile({
      profile: "fast",
      sourceWidth: 2880,
      sourceHeight: 2160,
      sourceFrameRate: 60,
    })).toEqual({ profile: "fast", scale: 0.5, fps: 30 });
    expect(finalEncodingSettings("fast")).toEqual({ crf: "16", preset: "veryfast" });
  });

  it("never upscales or raises fps and accepts explicit overrides", () => {
    expect(resolveExportProfile({
      profile: "fast",
      sourceWidth: 960,
      sourceHeight: 720,
      sourceFrameRate: 24,
    })).toEqual({ profile: "fast", scale: 1, fps: 24 });
    expect(resolveExportProfile({
      profile: "fast",
      sourceWidth: 2880,
      sourceHeight: 2160,
      sourceFrameRate: 60,
      scale: 0.75,
      fps: 25,
    })).toEqual({ profile: "fast", scale: 0.75, fps: 25 });
  });
});
