import type { CSSProperties } from "react";
import type { SubtitleStyle } from "@video-workbench/core";

/**
 * How many copies of the glyph make up one outline.
 *
 * The outline is drawn by stamping the text once per direction and letting the
 * union of those copies stand outside the letter. Too few and the ring is a
 * polygon with visible flats on a round stroke; past sixteen the copies overlap
 * so heavily that nothing changes. Sixteen is where the flats stop showing at
 * subtitle sizes.
 */
const OUTLINE_STEPS = 16;

/**
 * The outline, as a list of shadows.
 *
 * `-webkit-text-stroke` would be one declaration instead of sixteen, and it is
 * what this used to use — but it centres the stroke on the glyph edge. Half of
 * every width lands inside the letter, so a nominal 6% showed 3% of outline and
 * filled in the counters of 口 and 日 from the inside. ASS grows its outline
 * outward, so the centred version could not have matched an export either.
 */
function outlineShadows(widthPercent: number, color: string): string[] {
  const radius = widthPercent / 100;
  const shadows: string[] = [];
  for (let step = 0; step < OUTLINE_STEPS; step += 1) {
    const angle = (step / OUTLINE_STEPS) * Math.PI * 2;
    shadows.push(
      `${(Math.cos(angle) * radius).toFixed(4)}em ${(Math.sin(angle) * radius).toFixed(4)}em 0 ${color}`,
    );
  }
  return shadows;
}

/**
 * Turn a stored style into the CSS that draws it.
 *
 * Every length is a percentage: of frame height for the type and its position,
 * of font size for everything attached to the type — outline, shadow, plate,
 * tracking. So the caller decides what one percent means (`cqh` against the
 * picture in the frame, `em` in a swatch the size of a button) and the same
 * numbers produce the same shape at both sizes.
 *
 * This is the only place that decision is made. The overlay and the preset
 * swatch drew themselves separately before, and had drifted: the swatch put a
 * 3px radius on its plate while the frame put 0.1em on the same style, so the
 * look you picked was not the look you had been shown.
 */
export function subtitleTextCss(
  style: SubtitleStyle,
  fontSize: string,
  maxWidth?: string,
): CSSProperties {
  const shadows: string[] = [];
  if (style.strokeWidth > 0) shadows.push(...outlineShadows(style.strokeWidth, style.strokeColor));
  if (style.shadowColor) {
    shadows.push([
      `${(style.shadowOffsetX / 100).toFixed(3)}em`,
      `${(style.shadowOffsetY / 100).toFixed(3)}em`,
      `${(style.shadowBlur / 100).toFixed(3)}em`,
      style.shadowColor,
    ].join(" "));
  }

  return {
    fontFamily: style.fontFamily,
    fontSize,
    fontWeight: style.fontWeight,
    color: style.color,
    lineHeight: style.lineHeight,
    letterSpacing: `${(style.letterSpacing / 100).toFixed(4)}em`,
    background: style.backgroundColor || "transparent",
    padding: `${(style.backgroundPaddingY / 100).toFixed(3)}em ${(style.backgroundPaddingX / 100).toFixed(3)}em`,
    borderRadius: `${(style.backgroundRadius / 100).toFixed(3)}em`,
    ...(maxWidth ? { maxWidth } : {}),
    ...(shadows.length ? { textShadow: shadows.join(", ") } : {}),
  };
}
