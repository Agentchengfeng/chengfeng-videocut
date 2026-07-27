import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SubtitleStyle } from "@video-workbench/core";

export interface ActiveSubtitle {
  cueId: string;
  text: string;
  style: SubtitleStyle;
}

export interface SubtitleOverlayProps {
  subtitle: ActiveSubtitle | null;
}

/**
 * Turn a stored style into the frame-relative CSS that draws it.
 *
 * Every size in the document is a percentage of frame height or width, never a
 * pixel, so the same document renders identically at preview size and at export
 * size. `cqh`/`cqw` is that contract expressed directly: the overlay declares
 * itself a size container matched to the picture, and the percentages become
 * the units.
 */
function overlayTextStyle(style: SubtitleStyle): CSSProperties {
  return {
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize}cqh`,
    fontWeight: style.fontWeight,
    color: style.color,
    lineHeight: style.lineHeight,
    maxWidth: `${style.maxLineWidth}cqw`,
    background: style.backgroundColor || "transparent",
    ...(style.strokeWidth > 0
      ? {
        WebkitTextStroke: `${(style.strokeWidth / 100).toFixed(3)}em ${style.strokeColor}`,
        // Without this the stroke is painted over the glyph and eats the
        // counters of dense Han characters at subtitle sizes.
        paintOrder: "stroke fill",
      }
      : {}),
  };
}

/**
 * The picture inside the video element, which is not the video element.
 *
 * The element is sized by CSS; the media has its own shape; `object-fit:
 * contain` letterboxes the difference. Measured on a real project the element
 * was 651x564 while the picture was 651x488 — so an overlay matched to the
 * element drew the subtitle 16% too large and 32px too low, and the preview
 * would have been quietly wrong about the export. CSS cannot know the media's
 * shape, so this is measured.
 */
function containedPicture(video: HTMLVideoElement): { width: number; height: number } | null {
  const rect = video.getBoundingClientRect();
  const aspect = video.videoWidth / video.videoHeight;
  if (!Number.isFinite(aspect) || aspect <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  return rect.width / rect.height > aspect
    ? { width: rect.height * aspect, height: rect.height }
    : { width: rect.width, height: rect.width / aspect };
}

/**
 * The subtitles, on the video.
 *
 * Choosing a look with no way to see it is guesswork, so the preview draws the
 * document the same way an export would: same percentages, same anchoring, same
 * stroke. Nothing here decides anything — text and style are handed in already
 * resolved, and *when* each one shows comes from the cut, as it does everywhere.
 *
 * It never intercepts a click: the video underneath it is the play/pause target.
 */
export function SubtitleOverlay({ subtitle }: SubtitleOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [picture, setPicture] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const video = hostRef.current
      ?.closest(".cf-cut-player-stage")
      ?.querySelector("video");
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
  }, []);

  return (
    <div
      ref={hostRef}
      className="cf-cut-subtitle-overlay"
      data-anchor={subtitle?.style.anchor ?? "bottom"}
      style={{
        ...(picture ? { width: `${picture.width}px`, height: `${picture.height}px` } : {}),
        ...(subtitle ? { "--cf-subtitle-offset": `${subtitle.style.offsetY}cqh` } : {}),
      } as CSSProperties}
      aria-hidden="true"
    >
      {subtitle && (
        <span className="cf-cut-subtitle-overlay__text" style={overlayTextStyle(subtitle.style)}>
          {subtitle.text}
        </span>
      )}
    </div>
  );
}
