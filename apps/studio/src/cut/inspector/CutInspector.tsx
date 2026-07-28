import { useId, useState, type ReactNode } from "react";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";
import { SubtitleStyleSection } from "../subtitle/SubtitleStyleSection";

export interface CutInspectorProps {
  /** Omitted when there is no subtitle document to describe. */
  subtitles?: ProjectSubtitles;
}

interface InspectorFeature {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * The properties column: one strip of features, the selected one's parameters
 * below it.
 *
 * It carries the same tab strip as the feature column on the left, down to the
 * class names, because it is the same kind of thing — a column you navigate by
 * feature. 字幕 is the only feature with parameters today; 声音 and the
 * storyboard join the strip as those surfaces land, and none of them opens a
 * column of its own. Naming the column 参数 and then stacking every feature's
 * settings in it unlabelled is what made it read as one undifferentiated blob.
 *
 * The 参数 heading that used to sit above the strip is gone: the strip names
 * the feature, the column on the left has no heading either, and a title whose
 * only job is to label the thing directly under it costs a row of the column's
 * height. It survives as the column's accessible name.
 *
 * A feature appears only when the thing it describes exists — with none, the
 * strip is gone entirely rather than standing empty. Two groups were here and
 * are gone: playback, whose controls already sit under the video, and a table of
 * cut statistics, which answered a question nobody was asking. A column that is
 * mostly filler teaches people not to look at it.
 */
export function CutInspector({ subtitles }: CutInspectorProps) {
  const id = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const features: InspectorFeature[] = [];
  if (subtitles?.document) {
    features.push({
      id: "subtitle",
      label: "字幕",
      content: <SubtitleStyleSection subtitles={subtitles} />,
    });
  }

  const active = features.find((feature) => feature.id === selectedId) ?? features[0] ?? null;
  const tabId = (feature: string) => `cut-inspector-${feature}-tab-${id}`;
  const panelId = (feature: string) => `cut-inspector-${feature}-panel-${id}`;

  return (
    <aside className="cf-cut-inspector" aria-label="参数" data-koubo-inspector="true">
      {features.length > 0 && (
        <div
          className="cf-cut-feature-tabs cf-cut-inspector__tabs"
          role="tablist"
          aria-label="参数功能"
        >
          {features.map((feature) => (
            <button
              key={feature.id}
              id={tabId(feature.id)}
              className="cf-cut-feature-tab"
              type="button"
              role="tab"
              aria-selected={active?.id === feature.id}
              aria-controls={panelId(feature.id)}
              tabIndex={active?.id === feature.id ? 0 : -1}
              onClick={() => setSelectedId(feature.id)}
            >
              {feature.label}
            </button>
          ))}
        </div>
      )}

      {/*
        Only the selected feature is mounted here. The left column keeps both of
        its panels alive to preserve an 800-line document's scroll position;
        these panels are a screenful of controls reading from saved state, so
        there is nothing to preserve and nothing to gain.
      */}
      <div
        className="cf-cut-inspector__body"
        {...(active
          ? { role: "tabpanel", id: panelId(active.id), "aria-labelledby": tabId(active.id), tabIndex: 0 }
          : {})}
      >
        {active
          ? active.content
          : <p className="cf-cut-inspector__status">还没有可调的参数。</p>}
      </div>
    </aside>
  );
}
