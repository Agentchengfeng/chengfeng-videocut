import type { CSSProperties } from "react";
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
 * itself a size container matched to the video box, and the percentages become
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
  return (
    <div
      className="cf-cut-subtitle-overlay"
      data-anchor={subtitle?.style.anchor ?? "bottom"}
      style={subtitle
        ? { "--cf-subtitle-offset": `${subtitle.style.offsetY}cqh` } as CSSProperties
        : undefined}
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
