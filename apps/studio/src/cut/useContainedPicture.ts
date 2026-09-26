import { useEffect, useState, type RefObject } from "react";
import { parseCanvasAspect } from "@video-workbench/core";

export interface PictureSize {
  width: number;
  height: number;
}

/** The composition canvas is distinct from the source video's intrinsic frame. */
export function projectCanvasAspect(value: unknown): number | undefined {
  const aspect = parseCanvasAspect(value);
  // Preserve absence until the player knows whether the source has a picture.
  // Video uses its intrinsic frame; audio explicitly supplies the 16:9 fallback.
  return aspect ? aspect.w / aspect.h : undefined;
}

/**
 * The picture inside the video element, which is not the video element.
 *
 * The element is sized by CSS; the media has its own shape; `object-fit:
 * contain` letterboxes the difference. Measured on a real project the element
 * was 651x564 while the picture was 651x488 — an overlay matched to the element
 * drew its content 16% too large and 32px too low, and the preview would have
 * been quietly wrong about the export. CSS cannot know the media's shape, so
 * this is measured.
 */
export function containedPicture(video: HTMLVideoElement, fallbackAspect: number | null = null, preferCanvas = false): PictureSize | null {
  // offsetWidth/offsetHeight, never getBoundingClientRect: the push-in
  // transforms this element, and a rect measured while a zoom is up is
  // inflated by the zoom scale. That exact mistake was fixed once inside the
  // zoom math and survived here — it stayed invisible until the preview
  // stream attached while the playhead sat inside a pushed-in layer, at which
  // point every overlay grew 1.6x and the picture slid off its frame.
  const width = video.offsetWidth;
  const height = video.offsetHeight;
  const mediaAspect = video.videoWidth / video.videoHeight;
  // Canvas-anchored content uses the saved project ratio for both audio and
  // video. Source-anchored annotations retain the intrinsic picture geometry.
  const aspect = preferCanvas && fallbackAspect !== null ? fallbackAspect
    : Number.isFinite(mediaAspect) && mediaAspect > 0 ? mediaAspect : fallbackAspect;
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0 || width <= 0 || height <= 0) return null;
  return width / height > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

/**
 * Track the picture's size for anything that has to sit exactly on it.
 *
 * Shared by every layer over the player, because two layers that measure the
 * picture separately are two chances to disagree about where the frame is — and
 * subtitles and visuals have to land in the same coordinate space or the export
 * cannot reproduce what the preview showed.
 */
export function useContainedPicture(hostRef: RefObject<HTMLElement | null>, fallbackAspect: number | null = null, preferCanvas = false): PictureSize | null {
  const [picture, setPicture] = useState<PictureSize | null>(null);

  useEffect(() => {
    const video = hostRef.current?.closest(".cf-cut-player-stage")?.querySelector("video");
    if (!video) return;
    const measure = () => {
      const next = containedPicture(video, fallbackAspect, preferCanvas);
      setPicture((previous) => {
        if (!next) return null;
        // Resize fires continuously during a drag; only a real change may set
        // state, or the whole player re-renders for every pixel.
        if (
          previous
          && Math.abs(previous.width - next.width) < 0.5
          && Math.abs(previous.height - next.height) < 0.5
        ) return previous;
        return next;
      });
    };
    measure();
    // The media's shape is unknown until metadata lands, and it changes when a
    // new assembled stream is attached.
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    return () => {
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [hostRef, fallbackAspect, preferCanvas]);

  return picture;
}
