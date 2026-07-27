// @vitest-environment happy-dom

import { act } from "react";
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

import { CutFeaturePanel } from "./CutFeaturePanel";

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
    activeTab: "koubo" | "subtitle";
    onTabChange: (tab: "koubo" | "subtitle") => void;
    subtitleProblemCount: number;
  }> = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onTabChange = overrides.onTabChange ?? vi.fn();

  act(() => root.render(
    <CutFeaturePanel
      projectId="feature-panel-contract"
      editList={editList}
      transcript={transcript}
      cutSelection={cutSelection}
      onSeek={onSeek}
      activeTab={overrides.activeTab ?? "koubo"}
      onTabChange={onTabChange}
      subtitleProblemCount={overrides.subtitleProblemCount ?? 0}
      subtitleContent={<div data-testid="subtitle-pane" />}
    />,
  ));

  return { host, root, onSeek, onTabChange };
}

describe("CutFeaturePanel", () => {
  it("exposes two real local feature tabs with bidirectional APG relationships", () => {
    const { host, root } = renderPanel();

    const tablist = host.querySelector<HTMLElement>('[role="tablist"]');
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

    expect(tablist?.getAttribute("aria-label")).toBe("剪辑功能");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(tabs.map((tab) => tab.type)).toEqual(["button", "button"]);
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["剪口播", "字幕"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
    expect(tabs.map((tab) => tab.getAttribute("aria-controls")))
      .toEqual(panels.map((panel) => panel.id));
    expect(panels.map((panel) => panel.getAttribute("aria-labelledby")))
      .toEqual(tabs.map((tab) => tab.id));
    expect(panels[0]?.contains(host.querySelector('[data-testid="koubo-transcript"]'))).toBe(true);
    expect(panels[1]?.contains(host.querySelector('[data-testid="subtitle-pane"]'))).toBe(true);
    // Both stay mounted so switching tabs does not reset either scroll position.
    expect(panels[0]?.hidden).toBe(false);
    expect(panels[1]?.hidden).toBe(true);
    expect(host.textContent).not.toMatch(/素材|特效|贴纸/);

    act(() => root.unmount());
  });

  it("reports a tab click without switching on its own", () => {
    const onTabChange = vi.fn();
    const { host, root } = renderPanel(vi.fn(), { onTabChange });

    const subtitleTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))[1];
    act(() => {
      subtitleTab?.click();
    });

    expect(onTabChange).toHaveBeenCalledWith("subtitle");
    // The panel owns presentation only; which tab is active belongs to the
    // workspace, alongside playback state that must survive the switch.
    expect(subtitleTab?.getAttribute("aria-selected")).toBe("false");

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
