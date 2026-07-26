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

function renderPanel(onSeek = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  act(() => root.render(
    <CutFeaturePanel
      projectId="feature-panel-contract"
      editList={editList}
      transcript={transcript}
      cutSelection={cutSelection}
      onSeek={onSeek}
    />,
  ));

  return { host, root, onSeek };
}

describe("CutFeaturePanel", () => {
  it("exposes one real local feature tab with bidirectional APG relationships", () => {
    const { host, root } = renderPanel();

    const tablist = host.querySelector<HTMLElement>('[role="tablist"]');
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]');

    expect(tablist?.getAttribute("aria-label")).toBe("剪辑功能");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.tagName).toBe("BUTTON");
    expect(tabs[0]?.type).toBe("button");
    expect(tabs[0]?.textContent?.trim()).toBe("文稿");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.tabIndex).toBe(0);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    expect(panel?.contains(host.querySelector('[data-testid="koubo-transcript"]'))).toBe(true);
    expect(host.textContent).not.toMatch(/素材|字幕|特效|贴纸/);

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
