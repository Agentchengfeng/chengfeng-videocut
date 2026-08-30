import type { ExportProfile } from "@video-workbench/contracts";

const FAST_MAX_WIDTH = 1440;
const FAST_MAX_HEIGHT = 1080;
const FAST_MAX_FPS = 30;

export interface ResolveExportProfileInput {
  profile?: ExportProfile;
  sourceWidth: number;
  sourceHeight: number;
  sourceFrameRate: number;
  scale?: number;
  fps?: number;
}

export interface ResolvedExportProfile {
  profile: ExportProfile;
  scale?: number;
  fps?: number;
}

/**
 * Resolve only the defaults owned by a product profile. Explicit CLI values
 * win, so the profile is a convenient product choice rather than a hidden
 * second parser for scale and frame rate.
 */
export function resolveExportProfile(input: ResolveExportProfileInput): ResolvedExportProfile {
  const profile = input.profile ?? "master";
  if (profile === "master") {
    return { profile, scale: input.scale, fps: input.fps };
  }
  const boundedScale = Math.min(
    1,
    FAST_MAX_WIDTH / input.sourceWidth,
    FAST_MAX_HEIGHT / input.sourceHeight,
  );
  return {
    profile,
    scale: input.scale ?? boundedScale,
    fps: input.fps ?? Math.min(FAST_MAX_FPS, input.sourceFrameRate),
  };
}

export interface FinalEncodingSettings {
  crf: string;
  preset: "slow" | "veryfast";
}

export function finalEncodingSettings(profile: ExportProfile = "master"): FinalEncodingSettings {
  return profile === "fast"
    ? { crf: "16", preset: "veryfast" }
    : { crf: "16", preset: "slow" };
}
