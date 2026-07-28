import { useEffect, useState, type RefObject } from "react";

export interface PictureSize {
  width: number;
  height: number;
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
export function containedPicture(video: HTMLVideoElement): PictureSize | null {
  const rect = video.getBoundingClientRect();
  const aspect = video.videoWidth / video.videoHeight;
  if (!Number.isFinite(aspect) || aspect <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  return rect.width / rect.height > aspect
    ? { width: rect.height * aspect, height: rect.height }
    : { width: rect.width, height: rect.width / aspect };
}

/**
 * Track the picture's size for anything that has to sit exactly on it.
 *
 * Shared by every layer over the player, because two layers that measure the
 * picture separately are two chances to disagree about where the frame is — and
 * subtitles and visuals have to land in the same coordinate space or the export
 * cannot reproduce what the preview showed.
 */
export function useContainedPicture(hostRef: RefObject<HTMLElement | null>): PictureSize | null {
  const [picture, setPicture] = useState<PictureSize | null>(null);

  useEffect(() => {
    const video = hostRef.current?.closest(".cf-cut-player-stage")?.querySelector("video");
    if (!video) return;
    const measure = () => {
      const next = containedPicture(video);
      setPicture((previous) => {
        if (!next) return previous;
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
  }, [hostRef]);

  return picture;
}
