import type { CSSProperties } from "react";
import {
  matchSubtitleStylePreset,
  SUBTITLE_STYLE_PRESETS,
  type SubtitleStyle,
} from "@video-workbench/core";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";
import { subtitleTextCss } from "./subtitleCss";

export interface SubtitleStyleSectionProps {
  subtitles: ProjectSubtitles;
}

/**
 * A miniature of the look, drawn with the look itself.
 *
 * Same generator as the frame, so the swatch cannot drift from what picking it
 * produces — which it had: the swatch carried its own plate padding and a 3px
 * radius while the frame drew 0.1em, and the capsule you chose arrived square.
 * Only the unit differs: `px` here, `cqh` of the picture there.
 */
function previewStyle(style: SubtitleStyle): CSSProperties {
  return subtitleTextCss(style, `${(style.fontSize * 2.1).toFixed(1)}px`);
}

/**
 * The contents of the left workspace's 字幕样式 tab.
 *
 * Six looks, one of them on. Not eight sliders: eight decisions to reach one
 * result, seven of which only ever moved together. And not a per-screen
 * override either — one document, one look, so there is no second place for the
 * same setting to disagree with itself and no way back to build.
 *
 * Each tile is drawn in the look it names, because the label is not the choice.
 */
export function SubtitleStyleSection({ subtitles }: SubtitleStyleSectionProps) {
  const document = subtitles.document;
  if (!document) return null;

  const active = matchSubtitleStylePreset(document.style);

  return (
    <div className="cf-cut-subtitle-style-section">
      <div className="cf-cut-subtitle-style-section__presets" role="radiogroup" aria-label="字幕样式">
        {SUBTITLE_STYLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            className="cf-cut-subtitle-style-section__preset"
            aria-checked={active?.id === preset.id}
            onClick={() => subtitles.setStyle(preset.style)}
          >
            <span
              className="cf-cut-subtitle-style-section__preset-sample"
              style={previewStyle(preset.style)}
              aria-hidden="true"
            >
              字幕
            </span>
            <span className="cf-cut-subtitle-style-section__preset-label">{preset.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
