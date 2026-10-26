// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEditListState } from "../../components/useProjectEditList";

const harness = vi.hoisted(() => ({
  transcriptProps: vi.fn(),
}));

vi.mock("../transcript/KouboTranscriptPane", () => ({
  KouboTranscriptPane: (props: unknown) => {
    harness.transcriptProps(props);
    return <div data-testid="koubo-transcript" />;
  },
}));

import { CutFeaturePanel, type CutFeatureTab } from "./CutFeaturePanel";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const revision = "a".repeat(64);
const editList = {
  projectId: "feature-panel-contract",
  document: {
    schemaVersion: 1,
    projectId: "feature-panel-contract",
    sourceDuration: 10,
    baseCutsRevision: revision,
    baseTranscriptRevision: revision,
    mode: "cuts-derived",
    duration: 10,
    segments: [],
  },
  revision,
  loading: false,
  ready: true,
  saveState: "idle",
  reload: vi.fn(async () => true),
  patchOperation: vi.fn(),
  canUndo: false,
  undoLastEditListChange: vi.fn(async () => undefined),
} satisfies ProjectEditListState;

const transcript = {
  cues: [],
  loading: false,
  error: null,
};

const cutSelection = {
  cutWordIds: new Set<string>(),
  saveState: "idle" as const,
  selectionLoading: false,
  selectionReady: true,
  updateCutWordIds: vi.fn(),
  canUndo: false,
  undoLastCutChange: vi.fn(),
};

afterEach(() => {
  document.body.replaceChildren();
  harness.transcriptProps.mockReset();
});

function renderPanel(
  onSeek = vi.fn(),
  overrides: Partial<{
    activeTab: CutFeatureTab;
    onTabChange: (tab: CutFeatureTab) => void;
    subtitleProblemCount: number;
    subtitleStyleAvailable: boolean;
    collapsed: boolean;
    controlled: boolean;
  }> = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onTabChange = overrides.onTabChange ?? vi.fn();
  const onCollapsedChange = vi.fn();

  function Harness() {
    const [activeTab, setActiveTab] = useState<CutFeatureTab>(overrides.activeTab ?? "koubo");
    const [collapsed, setCollapsed] = useState(overrides.collapsed ?? false);
    return <CutFeaturePanel
      projectId="feature-panel-contract"
      editList={editList}
      transcript={transcript}
      cutSelection={cutSelection}
      onSeek={onSeek}
      activeTab={activeTab}
      onTabChange={(tab) => { onTabChange(tab); if (overrides.controlled) setActiveTab(tab); }}
      collapsed={collapsed}
      onCollapsedChange={(next) => { onCollapsedChange(next); if (overrides.controlled) setCollapsed(next); }}
      subtitleProblemCount={overrides.subtitleProblemCount ?? 0}
      subtitleContent={<div data-testid="subtitle-pane"><textarea aria-label="字幕草稿" defaultValue="原始字幕" /></div>}
      subtitleStyleContent={<div data-testid="subtitle-style-pane" />}
      subtitleStyleAvailable={overrides.subtitleStyleAvailable ?? true}
      canvasContent={<div data-testid="canvas-pane" />}
      audioContent={<div data-testid="audio-pane" />}
    />;
  }
  act(() => root.render(<Harness />));

  return { host, root, onSeek, onTabChange, onCollapsedChange };
}

describe("CutFeaturePanel", () => {
  it("exposes five real local features in a vertical rail with bidirectional APG relationships", () => {
    const { host, root } = renderPanel();

    const tablist = host.querySelector<HTMLElement>('[role="tablist"]');
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

    expect(tablist?.getAttribute("aria-label")).toBe("剪辑功能");
    expect(tablist?.getAttribute("aria-orientation")).toBe("vertical");
    expect(tabs).toHaveLength(5);
    expect(tabs.every((tab) => tab.tagName === "BUTTON" && tab.type === "button")).toBe(true);
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["剪口播", "字幕", "字幕样式", "画布", "音频"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-expanded"))).toEqual(["true", "false", "false", "false", "false"]);
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(tabs.map((tab) => tab.getAttribute("aria-controls")))
      .toEqual(panels.map((panel) => panel.id));
    expect(panels.map((panel) => panel.getAttribute("aria-labelledby")))
      .toEqual(tabs.map((tab) => tab.id));
    expect(panels[0]?.contains(host.querySelector('[data-testid="koubo-transcript"]'))).toBe(true);
    expect(panels[1]?.contains(host.querySelector('[data-testid="subtitle-pane"]'))).toBe(true);
    expect(panels[2]?.contains(host.querySelector('[data-testid="subtitle-style-pane"]'))).toBe(true);
    expect(panels[3]?.contains(host.querySelector('[data-testid="canvas-pane"]'))).toBe(true);
    expect(panels[4]?.contains(host.querySelector('[data-testid="audio-pane"]'))).toBe(true);
    // All panes stay mounted so switching tabs does not reset their state or scroll position.
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true, true, true, true]);
    expect(host.textContent).not.toMatch(/素材|特效|贴纸/);

    act(() => root.unmount());
  });

  it("toggles the current feature and heading closed, and opens a different feature", () => {
    const { host, root } = renderPanel(vi.fn(), { controlled: true });
    try {
      const [cut, subtitle] = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const body = host.querySelector<HTMLElement>(".cf-cut-feature-body")!;
      const headingClose = host.querySelector<HTMLButtonElement>('[aria-label="收起功能面板"]')!;
      act(() => cut!.click());
      expect(body.hidden).toBe(true);
      expect(cut!.getAttribute("aria-selected")).toBe("true");
      expect(cut!.getAttribute("aria-expanded")).toBe("false");
      expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5);
      act(() => cut!.click());
      expect(body.hidden).toBe(false);
      expect(cut!.getAttribute("aria-expanded")).toBe("true");
      act(() => headingClose.click());
      expect(body.hidden).toBe(true);
      expect(document.activeElement).toBe(cut);
      act(() => subtitle!.click());
      expect(body.hidden).toBe(false);
      expect(subtitle!.getAttribute("aria-expanded")).toBe("true");
      expect(cut!.getAttribute("aria-selected")).toBe("false");
      expect(host.querySelector(".cf-cut-feature-heading strong")?.textContent).toBe("字幕");
    } finally { act(() => root.unmount()); }
  });

  it("supports vertical ArrowUp/ArrowDown wrapping and Home/End, opening the focused feature", () => {
    const { host, root } = renderPanel(vi.fn(), { controlled: true, collapsed: true });
    try {
      const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const press = (index: number, key: string, expected: number) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        act(() => tabs[index]!.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(tabs[expected]);
        expect(tabs[expected]!.getAttribute("aria-expanded")).toBe("true");
        expect(tabs.map((tab) => tab.tabIndex)).toEqual(tabs.map((_, i) => i === expected ? 0 : -1));
      };
      press(0, "ArrowUp", 4);
      press(4, "ArrowDown", 0);
      press(0, "ArrowDown", 1);
      press(1, "End", 4);
      press(4, "Home", 0);
      const unrelated = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      act(() => tabs[0]!.dispatchEvent(unrelated));
      expect(unrelated.defaultPrevented).toBe(false);
    } finally { act(() => root.unmount()); }
  });

  it("retains each mounted pane, unsaved DOM draft, and scroll position across switches and collapse", () => {
    const { host, root } = renderPanel(vi.fn(), { controlled: true, activeTab: "subtitle" });
    try {
      const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const panes = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
      const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="字幕草稿"]')!;
      draft.value = "尚未保存的字幕";
      panes[1]!.scrollTop = 173;
      act(() => tabs[1]!.click());
      expect(panes[1]!.hidden).toBe(true);
      act(() => tabs[4]!.click());
      expect(panes[4]!.hidden).toBe(false);
      act(() => tabs[1]!.click());
      expect(panes[1]!.hidden).toBe(false);
      expect(Array.from(host.querySelectorAll('[role="tabpanel"]'))).toEqual(panes);
      expect(host.querySelector('[aria-label="字幕草稿"]')).toBe(draft);
      expect(draft.value).toBe("尚未保存的字幕");
      expect(panes[1]!.scrollTop).toBe(173);
    } finally { act(() => root.unmount()); }
  });

  it("reports a tab click without switching on its own", () => {
    const onTabChange = vi.fn();
    const { host, root } = renderPanel(vi.fn(), { onTabChange });

    const subtitleStyleTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))[2];
    act(() => {
      subtitleStyleTab?.click();
    });

    expect(onTabChange).toHaveBeenCalledWith("subtitle-style");
    // The panel owns presentation only; which tab is active belongs to the
    // workspace, alongside playback state that must survive the switch.
    expect(subtitleStyleTab?.getAttribute("aria-selected")).toBe("false");

    act(() => root.unmount());
  });

  it("puts the count of broken screens on the 字幕 tab, never a vague warning", () => {
    const { host, root } = renderPanel(vi.fn(), { subtitleProblemCount: 3 });

    const badge = host.querySelector<HTMLElement>(".cf-cut-feature-tab__badge");
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("aria-label")).toBe("3 屏字幕被剪辑改动");
    expect(host.textContent).not.toMatch(/可能|过期/);

    act(() => root.unmount());
  });

  it("removes the 字幕样式 tab and pane when no subtitle document exists", () => {
    const { host, root } = renderPanel(vi.fn(), {
      activeTab: "subtitle-style",
      subtitleStyleAvailable: false,
    });
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["剪口播", "字幕", "画布", "音频"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(host.querySelector(".cf-cut-feature-content--subtitle-style")).toBeNull();
    expect(host.querySelector('[data-testid="subtitle-style-pane"]')).toBeNull();

    act(() => root.unmount());
  });

  it("only forwards the transcript contract and performs no business write", () => {
    const onSeek = vi.fn();
    const { root } = renderPanel(onSeek);

    expect(harness.transcriptProps).toHaveBeenCalledWith({
      projectId: "feature-panel-contract",
      editList,
      transcript,
      cutSelection,
      onSeek,
    });
    expect(editList.patchOperation).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(editList.patchOperation).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
  });
});
