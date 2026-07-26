import { memo, useId } from "react";
import {
  KouboTranscriptPane,
  type KouboTranscriptPaneProps,
} from "../transcript/KouboTranscriptPane";

export type CutFeaturePanelProps = KouboTranscriptPaneProps;

/**
 * Local feature navigation for the talking-head editor.
 *
 * This component deliberately owns presentation only. Transcript selection,
 * persistence, and EditList writes remain inside their existing business
 * owners.
 */
export const CutFeaturePanel = memo(function CutFeaturePanel(props: CutFeaturePanelProps) {
  const id = useId();
  const transcriptTabId = `cut-feature-transcript-tab-${id}`;
  const transcriptPanelId = `cut-feature-transcript-panel-${id}`;

  return (
    <aside
      className="cf-cut-feature-panel"
      data-testid="cut-feature-panel"
      aria-label="功能区"
    >
      <div
        className="cf-cut-feature-tabs"
        role="tablist"
        aria-label="剪辑功能"
      >
        <button
          id={transcriptTabId}
          className="cf-cut-feature-tab"
          type="button"
          role="tab"
          aria-selected="true"
          aria-controls={transcriptPanelId}
          tabIndex={0}
        >
          文稿
        </button>
      </div>

      <section
        id={transcriptPanelId}
        className="cf-cut-feature-content"
        role="tabpanel"
        aria-labelledby={transcriptTabId}
        tabIndex={0}
      >
        <KouboTranscriptPane {...props} />
      </section>
    </aside>
  );
});
