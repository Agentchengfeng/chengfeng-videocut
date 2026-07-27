import { useId } from "react";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";
import { SubtitleStyleSection } from "../subtitle/SubtitleStyleSection";

export interface CutInspectorProps {
  /** Omitted when there is no subtitle document to describe. */
  subtitles?: ProjectSubtitles;
}

/**
 * The properties column, grouped by what the parameters are *for*.
 *
 * 字幕 is the first group; 画面 and the storyboard join it as those surfaces
 * land, and none of them opens a column of its own — this is the one place that
 * answers "what are the settings for X".
 *
 * A group appears only when the thing it describes exists. Two groups were here
 * and are gone: playback, whose controls already sit under the video, and a
 * table of cut statistics, which answered a question nobody was asking. A
 * column that is mostly filler teaches people not to look at it.
 */
export function CutInspector({ subtitles }: CutInspectorProps) {
  const titleId = useId();

  return (
    <aside className="cf-cut-inspector" aria-labelledby={titleId} data-koubo-inspector="true">
      <header className="cf-cut-inspector__header">
        <h2 id={titleId}>参数</h2>
      </header>

      <div className="cf-cut-inspector__body">
        {subtitles?.document
          ? <SubtitleStyleSection subtitles={subtitles} />
          : <p className="cf-cut-inspector__status">还没有可调的参数。</p>}
      </div>
    </aside>
  );
}
