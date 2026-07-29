import type { CSSProperties } from "react";
import type { SubtitleStyle } from "@video-workbench/core";
import { subtitleTextCss as coreSubtitleTextCss } from "@video-workbench/core";

/**
 * The preview's view of the one place a subtitle style becomes CSS.
 *
 * The rule itself lives in core, because the export draws the same document
 * and a second implementation would be a drift waiting to happen. This wrapper
 * exists only to give React its own type back.
 */
export function subtitleTextCss(
  style: SubtitleStyle,
  fontSize: string,
  maxWidth?: string,
): CSSProperties {
  return coreSubtitleTextCss(style, fontSize, maxWidth) as CSSProperties;
}
