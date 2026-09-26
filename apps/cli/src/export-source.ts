import { VideocutError, canvasDimensions, parseCanvasAspect } from "@video-workbench/core";
import { type MediaProbe } from "@video-workbench/koubo-adapter";

/** Shared by dry-run and execution. A generated canvas is not a replacement source. */
export function exportSource(probe: MediaProbe, aspectRatio: unknown) {
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new VideocutError("invalid_project", "Export requires a readable source with positive duration");
  }
  if (probe.hasVideo) {
    if (![probe.width, probe.height].every(n => Number.isFinite(n) && n >= 2)) throw new VideocutError("invalid_project", "Video has no readable frame dimensions");
    const aspect = parseCanvasAspect(aspectRatio);
    const same = !aspect || Math.abs(aspect.w / aspect.h - probe.width / probe.height) < 0.00001;
    const canvas = same ? { width: probe.width, height: probe.height } : canvasDimensions(aspectRatio);
    return {
      audioOnly: false,
      source: { width: probe.width, height: probe.height, duration: probe.duration, frameRate: probe.frameRate ?? 30 },
      canvas,
      defaultScale: same ? undefined : 1,
    };
  }
  if (!probe.hasAudio) {
    throw new VideocutError("invalid_project", "Export source has neither a readable video nor audio stream");
  }
  // Legacy missing/invalid metadata follows the same audio fallback as preview.
  // New writes still reject invalid ratios in the project-config API.
  const canvas = canvasDimensions(parseCanvasAspect(aspectRatio) ? aspectRatio : "16:9");
  if (![canvas.width, canvas.height].every(n => Number.isFinite(n) && n >= 2 && n <= 8192)) {
    throw new VideocutError("invalid_project", "Audio-only export canvas exceeds supported dimensions");
  }
  return {
    audioOnly: true,
    canvas,
    source: { ...canvas, duration: probe.duration, frameRate: 30 },
    // The synthetic canvas is already authored at output resolution, unlike
    // low-resolution video which retains the existing default upscale.
    defaultScale: 1,
  };
}
