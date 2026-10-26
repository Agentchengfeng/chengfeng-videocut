import { memo, useId, useRef, type ReactNode } from "react";
import {
  KouboTranscriptPane,
  type KouboTranscriptPaneProps,
} from "../transcript/KouboTranscriptPane";

export type CutFeatureTab = "koubo" | "subtitle" | "subtitle-style" | "canvas" | "audio";

export interface CutFeaturePanelProps extends KouboTranscriptPaneProps {
  activeTab: CutFeatureTab;
  onTabChange: (tab: CutFeatureTab) => void;
  /** Rendered in place of the transcript when the 字幕 tab is active. */
  subtitleContent: ReactNode;
  /** Rendered when the 字幕样式 tab is active. */
  subtitleStyleContent: ReactNode;
  /** A style is only meaningful after the project has a subtitle document. */
  subtitleStyleAvailable: boolean;
  /** Number of screens the cut broke, shown on the 字幕 tab. Zero shows nothing. */
  subtitleProblemCount: number;
  canvasContent?: ReactNode;
  audioContent?: ReactNode;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
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
  { id: "subtitle-style", label: "字幕样式" },
  { id: "canvas", label: "画布" },
  { id: "audio", label: "音频" },
];

const ICON_PATHS: Record<CutFeatureTab, string> = {
  koubo: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
  subtitle: "M3 5h18v14H3z M6 10h5 M6 14h5 M14 10h4 M14 14h4",
  "subtitle-style": "M4 5h16 M12 5v15 M8 20h8 M4 3v4 M20 3v4",
  canvas: "M3 7h18v12H3z M7 3h10 M7 23h10",
  audio: "M10 17V5l9-2v12 M10 7l9-2 M10 17c0 4-6 4-6 1s6-4 6-1 M19 15c0 4-6 4-6 1s6-4 6-1",
};

/**
 * Local feature navigation for the talking-head editor.
 *
 * 剪口播 and 字幕 work on the same words at different grain and for different
 * reasons: one decides word by word what survives, the other decides screen by
 * screen what is written. 字幕样式 is the document-wide look for those screens.
 * A persistent vertical rail keeps these modes, canvas and audio in one place.
 * Clicking the selected mode collapses only its body, never the navigation.
 *
 * Switching tabs must not disturb playback. That falls out of only swapping
 * this column's visibility — the player is a sibling and never unmounts.
 *
 * This component owns presentation only. Transcript selection, persistence, and
 * EditList writes remain inside their existing business owners.
 */
export const CutFeaturePanel = memo(function CutFeaturePanel({
  activeTab,
  onTabChange,
  subtitleContent,
  subtitleStyleContent,
  subtitleStyleAvailable,
  subtitleProblemCount,
  canvasContent,
  audioContent,
  collapsed = false,
  onCollapsedChange,
  ...transcriptProps
}: CutFeaturePanelProps) {
  const id = useId();
  const buttons = useRef<Partial<Record<CutFeatureTab, HTMLButtonElement | null>>>({});
  // Do not leave an active, empty panel behind during a subtitle reload. The
  // workspace persists this fallback too; deriving it here makes this present
  // render safe before React runs that effect.
  const displayedTab = activeTab === "subtitle-style" && !subtitleStyleAvailable
    ? "subtitle"
    : activeTab;
  const visibleTabs = TABS.filter((tab) => (
    (tab.id !== "subtitle-style" || subtitleStyleAvailable)
    && (tab.id !== "canvas" || canvasContent !== undefined)
    && (tab.id !== "audio" || audioContent !== undefined)
  ));
  const tabId = (tab: CutFeatureTab) => `cut-feature-${tab}-tab-${id}`;
  const panelId = (tab: CutFeatureTab) => `cut-feature-${tab}-panel-${id}`;

  return (
    <aside
      className="cf-cut-feature-panel"
      data-testid="cut-feature-panel"
      data-active-tab={displayedTab}
      data-collapsed={collapsed}
      aria-label="功能区"
    >
      <div className="cf-cut-feature-tabs" role="tablist" aria-label="剪辑功能" aria-orientation="vertical">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            ref={(node) => { buttons.current[tab.id] = node; }}
            id={tabId(tab.id)}
            className="cf-cut-feature-tab"
            type="button"
            role="tab"
            aria-selected={displayedTab === tab.id}
            aria-expanded={!collapsed && displayedTab === tab.id}
            aria-controls={panelId(tab.id)}
            tabIndex={displayedTab === tab.id ? 0 : -1}
            onClick={() => {
              onTabChange(tab.id);
              onCollapsedChange?.(tab.id === displayedTab ? !collapsed : false);
            }}
            onKeyDown={(event) => {
              const index = visibleTabs.findIndex((entry) => entry.id === tab.id);
              const next = event.key === "ArrowDown" ? (index + 1) % visibleTabs.length
                : event.key === "ArrowUp" ? (index - 1 + visibleTabs.length) % visibleTabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              const target = visibleTabs[next]!.id;
              onTabChange(target);
              onCollapsedChange?.(false);
              buttons.current[target]?.focus();
            }}
          >
            <svg viewBox="0 0 24 26" aria-hidden="true"><path d={ICON_PATHS[tab.id]} /></svg>
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

      <div className="cf-cut-feature-body" hidden={collapsed}>
        <header className="cf-cut-feature-heading">
          <strong>{visibleTabs.find((tab) => tab.id === displayedTab)?.label}</strong>
          {onCollapsedChange && <button type="button" aria-label="收起功能面板" title="收起功能面板" onClick={() => {
            onCollapsedChange(true);
            buttons.current[displayedTab]?.focus();
          }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>}
        </header>

      {/*
        Available panels stay mounted while tabs switch; only the inactive one
        is hidden. The style panel is removed only when its subtitle document
        no longer exists. Unmounting the transcript would throw away its scroll
        position, and a person flipping between the tabs to compare a line or
        adjust its look would land back at the top of an 800-line document.
      */}
      <section
        id={panelId("koubo")}
        className="cf-cut-feature-content"
        role="tabpanel"
        aria-labelledby={tabId("koubo")}
        hidden={collapsed || displayedTab !== "koubo"}
        tabIndex={0}
      >
        <KouboTranscriptTabPanel {...transcriptProps} />
      </section>

      <section
        id={panelId("subtitle")}
        className="cf-cut-feature-content"
        role="tabpanel"
        aria-labelledby={tabId("subtitle")}
        hidden={collapsed || displayedTab !== "subtitle"}
        tabIndex={0}
      >
        {subtitleContent}
      </section>

      {subtitleStyleAvailable && (
        <section
          id={panelId("subtitle-style")}
          className="cf-cut-feature-content cf-cut-feature-content--subtitle-style"
          role="tabpanel"
          aria-labelledby={tabId("subtitle-style")}
          hidden={collapsed || displayedTab !== "subtitle-style"}
          tabIndex={0}
        >
          <div className="cf-cut-subtitle-style-panel">
            {subtitleStyleContent}
          </div>
        </section>
      )}
      {canvasContent !== undefined && <section id={panelId("canvas")} className="cf-cut-feature-content cf-cut-feature-content--settings" role="tabpanel" aria-labelledby={tabId("canvas")} hidden={collapsed || displayedTab !== "canvas"} tabIndex={0}>{canvasContent}</section>}
      {audioContent !== undefined && <section id={panelId("audio")} className="cf-cut-feature-content cf-cut-feature-content--settings" role="tabpanel" aria-labelledby={tabId("audio")} hidden={collapsed || displayedTab !== "audio"} tabIndex={0}>{audioContent}</section>}
      </div>
    </aside>
  );
});
