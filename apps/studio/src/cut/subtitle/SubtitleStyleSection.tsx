import { useId } from "react";
import {
  matchSubtitleStylePreset,
  SUBTITLE_STYLE_PRESETS,
  type SubtitleStyle,
} from "@video-workbench/core";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";

export interface SubtitleStyleSectionProps {
  subtitles: ProjectSubtitles;
}

/** A miniature of the look, drawn with the look itself. */
function previewStyle(style: SubtitleStyle) {
  const stroke = style.strokeWidth > 0
    ? `${(style.strokeWidth / 100).toFixed(2)}em ${style.strokeColor}`
    : undefined;
  return {
    color: style.color,
    fontWeight: style.fontWeight,
    fontSize: `${(style.fontSize * 2.1).toFixed(1)}px`,
    background: style.backgroundColor || "transparent",
    ...(stroke ? { WebkitTextStroke: stroke, paintOrder: "stroke fill" } : {}),
  } as const;
}

/**
 * The subtitle group of the properties column.
 *
 * Four looks, one of them on. Not eight sliders: eight decisions to reach one
 * result, seven of which only ever moved together. And not a per-screen
 * override either — one document, one look, so there is no second place for the
 * same setting to disagree with itself and no way back to build.
 *
 * Each tile is drawn in the look it names, because the label is not the choice.
 */
export function SubtitleStyleSection({ subtitles }: SubtitleStyleSectionProps) {
  const id = useId();
  const document = subtitles.document;
  if (!document) return null;

  const active = matchSubtitleStylePreset(document.style);

  return (
    <div className="cf-cut-inspector__group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="cf-cut-inspector__group-title">字幕</h3>

      <div className="cf-cut-inspector__presets" role="radiogroup" aria-label="字幕样式">
        {SUBTITLE_STYLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            className="cf-cut-inspector__preset"
            aria-checked={active?.id === preset.id}
            onClick={() => subtitles.setStyle(preset.style)}
          >
            <span
              className="cf-cut-inspector__preset-sample"
              style={previewStyle(preset.style)}
              aria-hidden="true"
            >
              字幕
            </span>
            <span className="cf-cut-inspector__preset-label">{preset.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
