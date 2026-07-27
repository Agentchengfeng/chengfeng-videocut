import { memo, useId, type ReactNode } from "react";
import {
  KouboTranscriptPane,
  type KouboTranscriptPaneProps,
} from "../transcript/KouboTranscriptPane";

export type CutFeatureTab = "koubo" | "subtitle";

export interface CutFeaturePanelProps extends KouboTranscriptPaneProps {
  activeTab: CutFeatureTab;
  onTabChange: (tab: CutFeatureTab) => void;
  /** Rendered in place of the transcript when the 字幕 tab is active. */
  subtitleContent: ReactNode;
  /** Number of screens the cut broke, shown on the 字幕 tab. Zero shows nothing. */
  subtitleProblemCount: number;
}

/**
 * The transcript, memoized on its own props.
 *
 * `memo` on the panel is not enough: the panel is handed the subtitle tab's
 * element, and an element is a fresh object every render, so the panel's own
 * memo can never bail out. Its props are individually stable, though — so a
 * shallow comparison one level down does bail out, and the 3000-word transcript
 * stops re-rendering every time the playhead ticks.
 */
const KouboTranscriptTabPanel = memo(function KouboTranscriptTabPanel(
  props: KouboTranscriptPaneProps,
) {
  return <KouboTranscriptPane {...props} />;
});

const TABS: Array<{ id: CutFeatureTab; label: string }> = [
  // "文稿" was the old name and it described the wrong thing: this pane decides
  // what to keep and what to drop, and the subtitle pane next to it is also a
  // script. Naming it after the job removes the ambiguity.
  { id: "koubo", label: "剪口播" },
  { id: "subtitle", label: "字幕" },
];

/**
 * Local feature navigation for the talking-head editor.
 *
 * Both tabs work on the same words, at different grain and for different
 * reasons: one decides word by word what survives, the other decides screen by
 * screen what is written. Putting them in one column under a tab strip is the
 * admission that they are two modes of the same place.
 *
 * Switching tabs must not disturb playback. That falls out of only swapping
 * this column's contents — the player is a sibling and never unmounts.
 *
 * This component owns presentation only. Transcript selection, persistence, and
 * EditList writes remain inside their existing business owners.
 */
export const CutFeaturePanel = memo(function CutFeaturePanel({
  activeTab,
  onTabChange,
  subtitleContent,
  subtitleProblemCount,
  ...transcriptProps
}: CutFeaturePanelProps) {
  const id = useId();
  const tabId = (tab: CutFeatureTab) => `cut-feature-${tab}-tab-${id}`;
  const panelId = (tab: CutFeatureTab) => `cut-feature-${tab}-panel-${id}`;

  return (
    <aside
      className="cf-cut-feature-panel"
      data-testid="cut-feature-panel"
      data-active-tab={activeTab}
      aria-label="功能区"
    >
      <div className="cf-cut-feature-tabs" role="tablist" aria-label="剪辑功能">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={tabId(tab.id)}
            className="cf-cut-feature-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={panelId(tab.id)}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {tab.id === "subtitle" && subtitleProblemCount > 0 && (
              <span
                className="cf-cut-feature-tab__badge"
                aria-label={`${subtitleProblemCount} 屏字幕被剪辑改动`}
              >
                {subtitleProblemCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/*
        Both panels stay mounted; only the inactive one is hidden. Unmounting
        the transcript would throw away its scroll position, and a person
        flipping between the two tabs to compare a line would land back at the
        top of an 800-line document every time.
      */}
      <section
        id={panelId("koubo")}
        className="cf-cut-feature-content"
        role="tabpanel"
        aria-labelledby={tabId("koubo")}
        hidden={activeTab !== "koubo"}
        tabIndex={0}
      >
        <KouboTranscriptTabPanel {...transcriptProps} />
      </section>

      <section
        id={panelId("subtitle")}
        className="cf-cut-feature-content"
        role="tabpanel"
        aria-labelledby={tabId("subtitle")}
        hidden={activeTab !== "subtitle"}
        tabIndex={0}
      >
        {subtitleContent}
      </section>
    </aside>
  );
});
