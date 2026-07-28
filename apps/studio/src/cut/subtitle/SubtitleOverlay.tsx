import { useRef, type CSSProperties } from "react";
import type { SubtitleStyle } from "@video-workbench/core";
import { useContainedPicture } from "../useContainedPicture";
import { subtitleTextCss } from "./subtitleCss";

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
 * the units. Everything attached to the type — outline, shadow, plate, tracking
 * — is a percentage of the font size instead, which `em` already means.
 */
function overlayTextStyle(style: SubtitleStyle): CSSProperties {
  return subtitleTextCss(style, `${style.fontSize}cqh`, `${style.maxLineWidth}cqw`);
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
  const picture = useContainedPicture(hostRef);

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
