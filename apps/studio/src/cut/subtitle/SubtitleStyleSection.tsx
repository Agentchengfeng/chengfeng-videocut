import { useId } from "react";
import {
  matchSubtitleStylePreset,
  SUBTITLE_STYLE_PRESETS,
  type SubtitleStyle,
} from "@video-workbench/core";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";

export interface SubtitleStyleSectionProps {
  subtitles: ProjectSubtitles;
  /** Null sets the style for every screen; a cue id sets it for that one. */
  selectedCueId: string | null;
}

/** A miniature of what the preset looks like, drawn from the preset itself. */
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
 * The subtitle half of the properties column.
 *
 * It offers whole looks, not the fields a look is made of. Eight sliders was
 * eight decisions to reach one result, and seven of them only ever moved
 * together — so the choice on offer is the result.
 *
 * With nothing selected it sets every screen. With a screen selected it sets
 * that screen alone, and offers a way back to following the rest. That is the
 * only reason the style is stored in two places, and it is worth keeping: one
 * emphasised line is a real thing to want.
 */
export function SubtitleStyleSection({ subtitles, selectedCueId }: SubtitleStyleSectionProps) {
  const id = useId();
  const document = subtitles.document;
  if (!document) return null;

  const cue = selectedCueId
    ? document.cues.find((candidate) => candidate.id === selectedCueId) ?? null
    : null;
  const cueIndex = cue ? document.cues.findIndex((candidate) => candidate.id === cue.id) : -1;
  const overridden = Boolean(cue?.style);
  const effective: SubtitleStyle = { ...document.style, ...(cue?.style ?? {}) };
  const active = matchSubtitleStylePreset(effective);

  const choose = (style: SubtitleStyle) => {
    if (cue) subtitles.setCueStyle(cue.id, style);
    else subtitles.setStyle(style);
  };

  return (
    <div className="cf-cut-inspector__group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="cf-cut-inspector__group-title">字幕</h3>

      <p className="cf-cut-inspector__help">
        {cue
          ? `只改第 ${cueIndex + 1} 屏${overridden ? "" : "，其余屏不动"}`
          : "所有屏"}
      </p>

      <div className="cf-cut-inspector__presets" role="radiogroup" aria-label="字幕样式">
        {SUBTITLE_STYLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            className="cf-cut-inspector__preset"
            aria-checked={active?.id === preset.id}
            onClick={() => choose(preset.style)}
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

      {active === null && (
        <p className="cf-cut-inspector__help" role="status">
          当前是改过的样式，点上面任意一个会覆盖掉。
        </p>
      )}

      {cue && overridden && (
        <button
          type="button"
          className="cf-cut-inspector__reset"
          onClick={() => subtitles.setCueStyle(cue.id, null)}
        >
          这一屏改回跟其余一样
        </button>
      )}
    </div>
  );
}
