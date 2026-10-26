// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { createRoot } from "react-dom/client";
import {
  applyEditListOperation,
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_STYLE_PRESETS,
  type EditListDocument,
  type EditListOperation,
  type SubtitleDocument,
} from "@video-workbench/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The real transport hands React a ref it can also notice; a stub must be callable too. */
function stubVideoRef() {
  const attach = ((node: HTMLVideoElement | null) => {
    attach.current = node;
  }) as ((node: HTMLVideoElement | null) => void) & { current: HTMLVideoElement | null };
  attach.current = null;
  return attach;
}

const harness = vi.hoisted(() => ({
  cutPlayerProps: [] as Array<Record<string, unknown>>,
  cutTimelineProps: [] as Array<Record<string, unknown>>,
  transcriptProps: [] as Array<Record<string, unknown>>,
  patchOperation: vi.fn(),
  undoLastCutChange: vi.fn(),
  undoLastEditListChange: vi.fn(async () => undefined),
  useAssembledVideoTransport: vi.fn(),
  useKouboTranscript: vi.fn(),
  useProjectCutSelection: vi.fn(),
  usePreviewArtifact: vi.fn(),
  useProjectEditList: vi.fn(),
  useProjectSubtitles: vi.fn(),
  useProjectVisuals: vi.fn(),
}));

vi.mock("../components/useProjectEditList", () => ({
  useProjectEditList: harness.useProjectEditList,
}));

vi.mock("../components/useProjectCutSelection", () => ({
  useProjectCutSelection: harness.useProjectCutSelection,
}));

vi.mock("../components/useProjectSubtitles", () => ({
  useProjectSubtitles: harness.useProjectSubtitles,
}));

vi.mock("../components/useProjectWorkflow", () => ({
  useProjectWorkflow: () => ({ workflow: { project: { config: { aspectRatio: "4:3" } } } }),
}));

vi.mock("./visual/useProjectVisuals", () => ({
  useProjectVisuals: harness.useProjectVisuals,
}));

vi.mock("../extensions/koubo/useKouboTranscript", () => ({
  useKouboTranscript: harness.useKouboTranscript,
}));

vi.mock("./player/useAssembledVideoTransport", () => ({
  useAssembledVideoTransport: harness.useAssembledVideoTransport,
}));

vi.mock("./player/previewArtifact", () => ({
  previewArtifactUrl: () => "/preview/current.mp4",
  usePreviewArtifact: harness.usePreviewArtifact,
}));

vi.mock("./player/CutPlayer", () => ({
  CutPlayer: (props: Record<string, unknown>) => {
    harness.cutPlayerProps.push(props);
    return <section data-testid="cut-player" data-source-url={String(props.sourceUrl ?? "")}>
      <video data-testid="cut-media" />
      {props.notices as ReactNode}
    </section>;
  },
}));

vi.mock("./transcript/KouboTranscriptPane", () => ({
  KouboTranscriptPane: (props: Record<string, unknown>) => {
    harness.transcriptProps.push(props);
    return (
      <aside data-testid="koubo-transcript">
        <button type="button" data-testid="transcript-action">文稿操作</button>
        <textarea aria-label="文稿未保存草稿" defaultValue="原稿" />
      </aside>
    );
  },
}));

vi.mock("./timeline/CutTimeline", () => ({
  CutTimeline: (props: Record<string, unknown>) => {
    harness.cutTimelineProps.push(props);
    return <section data-testid="cut-timeline" />;
  },
}));

import { CutWorkspace, resolveTimelineAnchorForSourceTime, timelineTimeForSourceAnchor } from "./CutWorkspace";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const revision = "a".repeat(64);
const editListDocument = {
  schemaVersion: 1,
  projectId: "layout-contract",
  sourceDuration: 10,
  baseCutsRevision: revision,
  baseTranscriptRevision: revision,
  mode: "cuts-derived",
  duration: 10,
  segments: [
    {
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

const reorderableDocument: EditListDocument = {
  schemaVersion: 1,
  projectId: "layout-contract",
  sourceDuration: 12,
  baseCutsRevision: revision,
  baseTranscriptRevision: revision,
  mode: "cuts-derived",
  duration: 6,
  segments: [
    {
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 2,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
    {
      id: "a-roll-0002",
      source: "input/source.mp4",
      sourceStart: 4,
      sourceEnd: 8,
      timelineStart: 2,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

const splitDocument = {
  ...editListDocument,
  duration: 6,
  segments: [
    {
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 2,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
    {
      id: "a-roll-0002",
      source: "input/source.mp4",
      sourceStart: 5,
      sourceEnd: 9,
      timelineStart: 2,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

const reorderedContinuousDocument = {
  ...editListDocument,
  duration: 4,
  segments: [
    {
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 8,
      sourceEnd: 10,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
    {
      id: "a-roll-0002",
      source: "input/source.mp4",
      sourceStart: 2,
      sourceEnd: 4,
      timelineStart: 2,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

const halfOpenBoundaryDocument = {
  ...editListDocument,
  duration: 6,
  segments: [
    {
      id: "previous",
      source: "input/source.mp4",
      sourceStart: 10,
      sourceEnd: 12,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
    {
      id: "next",
      source: "input/source.mp4",
      sourceStart: 20,
      sourceEnd: 24,
      timelineStart: 2,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

beforeEach(() => {
  // Workspace seam markers are an independent read. Keep this component suite
  // isolated from any developer service listening on happy-dom's base URL.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).endsWith('/seams')) return new Response(JSON.stringify({ seams: [] }));
    throw new Error(`Unexpected workspace test request: ${String(input)}`);
  });
  harness.useProjectVisuals.mockReset();
  harness.useProjectVisuals.mockReturnValue({ document: null, timings: [], moduleUrl: vi.fn() });
  harness.cutPlayerProps = [];
  harness.cutTimelineProps = [];
  harness.transcriptProps = [];
  harness.patchOperation.mockReset();
  harness.undoLastCutChange.mockReset();
  harness.undoLastEditListChange.mockReset();
  harness.useProjectEditList.mockReset();
  harness.useKouboTranscript.mockReset();
  harness.useProjectCutSelection.mockReset();
  harness.useAssembledVideoTransport.mockReset();
  harness.usePreviewArtifact.mockReset();
  harness.useProjectSubtitles.mockReset();
  harness.useProjectSubtitles.mockReturnValue({
    projectId: "layout-contract",
    document: null,
    revision: "none",
    timings: [],
    stale: [],
    loading: false,
    ready: true,
    saveState: "idle",
    error: null,
    reload: vi.fn(async () => undefined),
    save: vi.fn(),
    setCueText: vi.fn(),
    setStyle: vi.fn(),
    setCueStyle: vi.fn(),
    mergeWithPrevious: vi.fn(),
    splitAt: vi.fn(),
  });
  harness.useProjectEditList.mockReturnValue({
    projectId: "layout-contract",
    document: editListDocument,
    revision,
    loading: false,
    ready: true,
    saveState: "idle",
    reload: vi.fn(async () => true),
    patchOperation: harness.patchOperation,
    canUndo: false,
    undoLastEditListChange: harness.undoLastEditListChange,
  });
  harness.useKouboTranscript.mockReturnValue({
    cues: [],
    loading: false,
    error: null,
  });
  harness.useProjectCutSelection.mockReturnValue({
    cutWordIds: new Set<string>(),
    saveState: "idle",
    selectionLoading: false,
    selectionReady: true,
    updateCutWordIds: vi.fn(),
    canUndo: false,
    undoLastCutChange: harness.undoLastCutChange,
  });
  harness.usePreviewArtifact.mockReturnValue({
    current: true,
    state: {
      phase: "current",
      editRevision: revision,
      artifactRevision: revision,
      source: "preview.mp4",
      error: null,
    },
    retry: vi.fn(),
  });
  harness.useAssembledVideoTransport.mockReturnValue({
    videoRef: stubVideoRef(),
    timelineTime: 2.5,
    duration: 10,
    isPlaying: false,
    desiredPlaying: false,
    isWaiting: false,
    isSeeking: false,
    playbackRate: 1,
    volume: 1,
    muted: false,
    loopEnabled: false,
    error: null,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    togglePlay: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setPlaybackRate: vi.fn(),
    setVolume: vi.fn(),
    toggleMuted: vi.fn(),
    toggleLoop: vi.fn(),
    restoreIntent: vi.fn(async () => undefined),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

interface TimelinePropsSnapshot {
  editList: { patchOperation: (operation: EditListOperation) => Promise<EditListDocument> };
  canUndo: boolean;
  onUndo: () => Promise<void>;
}

interface TranscriptPropsSnapshot {
  editList: { patchOperation: (operation: EditListOperation) => Promise<EditListDocument> };
  onSeek: (time: number, options?: { keepPlaying?: boolean }) => void;
  cutSelection: {
    updateCutWordIds: (
      next: ReadonlySet<string>,
      options?: { recordUndo?: boolean },
    ) => Promise<boolean>;
  };
}

function latestTimelineProps(): TimelinePropsSnapshot {
  const props = harness.cutTimelineProps.at(-1);
  if (!props) throw new Error("Expected CutTimeline props");
  return props as TimelinePropsSnapshot;
}

function latestTranscriptProps(): TranscriptPropsSnapshot {
  const props = harness.transcriptProps.at(-1);
  if (!props) throw new Error("Expected KouboTranscriptPane props");
  return props as TranscriptPropsSnapshot;
}

describe("CutWorkspace single-page layout contract", () => {
  it("keeps content and preview mounted together while feature tabs preserve their nodes", () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={2.5} onTimelineTimeCommit={vi.fn()} />));
      const player = host.querySelector('[data-testid="cut-player"]');
      const timeline = host.querySelector('[data-testid="cut-timeline"]');
      const transcript = host.querySelector('[data-testid="koubo-transcript"]');
      const video = host.querySelector<HTMLVideoElement>('[data-testid="cut-media"]')!;
      const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="文稿未保存草稿"]')!;
      const transcriptPanel = transcript!.closest<HTMLElement>('[role="tabpanel"]')!;
      video.currentTime = 6.25;
      draft.value = '未保存修改';
      transcriptPanel.scrollTop = 191;
      expect(host.querySelector('.cf-cut-compact-switcher')).toBeNull();
      expect(host.querySelector('.cf-cut-workspace')?.hasAttribute('data-compact-view')).toBe(false);
      expect(host.querySelector('.cf-cut-feature-panel')?.parentElement).toBe(player?.parentElement);
      const subtitleTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === '字幕')!;
      const cutTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === '剪口播')!;
      act(() => subtitleTab.click());
      expect(subtitleTab.getAttribute('aria-selected')).toBe('true');
      act(() => cutTab.click());
      expect(cutTab.getAttribute('aria-selected')).toBe('true');
      act(() => cutTab.click());
      expect(host.querySelector('.cf-cut-workspace')?.getAttribute('data-feature-collapsed')).toBe('true');
      expect(host.querySelector<HTMLElement>('.cf-cut-feature-body')!.hidden).toBe(true);
      act(() => cutTab.click());
      expect(host.querySelector('.cf-cut-workspace')?.getAttribute('data-feature-collapsed')).toBe('false');
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起功能面板"]')!.click());
      expect(host.querySelector<HTMLElement>('.cf-cut-feature-body')!.hidden).toBe(true);
      act(() => subtitleTab.click());
      expect(host.querySelector<HTMLElement>('.cf-cut-feature-body')!.hidden).toBe(false);
      act(() => cutTab.click());
      expect(host.querySelector('[data-testid="cut-player"]')).toBe(player);
      expect(host.querySelector('[data-testid="cut-timeline"]')).toBe(timeline);
      expect(host.querySelector('[data-testid="koubo-transcript"]')).toBe(transcript);
      expect(host.querySelector('[data-testid="cut-media"]')).toBe(video);
      expect(video.currentTime).toBe(6.25);
      expect(host.querySelector('[aria-label="文稿未保存草稿"]')).toBe(draft);
      expect(draft.value).toBe('未保存修改');
      expect(transcriptPanel.scrollTop).toBe(191);
      const transport = harness.useAssembledVideoTransport.mock.results.at(-1)?.value;
      expect(transport.play).not.toHaveBeenCalled();
      expect(transport.pause).not.toHaveBeenCalled();
      expect(transport.seek).not.toHaveBeenCalled();
      expect(harness.patchOperation).not.toHaveBeenCalled();
      expect(harness.useProjectCutSelection.mock.results.at(-1)?.value.updateCutWordIds).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); host.remove(); }
  });

  it("keeps a single player transport owner through viewport changes", () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const commit = vi.fn();
    const render = () => act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={2.5} onTimelineTimeCommit={commit} />));
    try {
      render();
      const transport = harness.useAssembledVideoTransport.mock.results.at(-1)?.value;
      const player = host.querySelector('[data-testid="cut-player"]');
      const originalWidth = window.innerWidth;
      try {
        for (const width of [678, 320, 1280]) {
          Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
          act(() => window.dispatchEvent(new Event('resize')));
          render();
          expect(host.querySelectorAll('[data-testid="cut-player"]')).toHaveLength(1);
          expect(host.querySelector('[data-testid="cut-player"]')).toBe(player);
          expect(harness.cutPlayerProps.at(-1)?.transport).toBe(transport);
          expect(host.querySelector('.cf-cut-compact-switcher__play-button')).toBeNull();
        }
      } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); }
      expect(transport.play).not.toHaveBeenCalled();
      expect(transport.pause).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(harness.patchOperation).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); host.remove(); }
  });

  it("anchors the timeline below side-by-side content and preview at narrow widths", () => {
    const css = readFileSync('src/cut/cut.css', 'utf8');
    const shell = css.match(/\.cf-cut-workspace \{([^}]+)\}/)?.[1] ?? '';
    expect(shell).toContain('grid-template-rows: minmax(0, 1fr) var(--cf-cut-timeline-height)');
    expect(shell).toContain('overflow: hidden');
    const narrow = css.slice(css.indexOf('@media (width < 960px)'), css.indexOf('@media (height < 480px)'));
    expect(narrow).toContain('grid-template-columns: clamp(200px, 42vw, 320px) minmax(0, 1fr)');
    expect(narrow).toMatch(/\.cf-cut-workspace\[data-feature-collapsed="true"\]\s*\{[^}]*grid-template-columns:\s*var\(--cf-cut-rail-width\) minmax\(0, 1fr\)/);
    expect(narrow).toMatch(/\.cf-cut-workspace > \.cf-cut-feature-panel\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/);
    expect(narrow).toMatch(/\.cf-cut-workspace > \.cf-cut-player\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/);
    expect(narrow).toMatch(/\.cf-cut-workspace > \.cf-cut-timeline\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*2;/);
    expect(css).not.toContain('data-compact-view');
    expect(css).not.toContain('cf-cut-compact-switcher');
    expect(css).not.toContain('clamp(140px, 24dvh, 220px)');
  });

  it("keeps the feature rail vertical and scrollable with a smaller width on narrow screens", () => {
    const css = readFileSync('src/cut/cut.css', 'utf8');
    const compactTabs = css.slice(css.indexOf('@media (width < 480px)'), css.indexOf('@media (height < 480px)'));
    const strip = css.match(/\.cf-cut-feature-tabs\s*\{([^}]+)\}/)?.[1] ?? '';
    const tab = css.match(/\.cf-cut-feature-tab\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(strip).toContain('flex-direction: column');
    expect(strip).toContain('flex: 0 0 var(--cf-cut-rail-width, 64px)');
    expect(strip).toContain('overflow-y: auto');
    expect(strip).not.toContain('flex-wrap: wrap');
    expect(tab).toContain('min-width: 0');
    expect(compactTabs).toContain('--cf-cut-rail-width: 56px');
    expect(compactTabs).toMatch(/\.cf-cut-player-controls\s*\{[^}]*padding:\s*4px;[^}]*gap:\s*4px;/);
    expect(compactTabs).toMatch(/\.cf-cut-tools-button\s*\{[^}]*height:\s*26px;/);
    expect(compactTabs).toMatch(/\.cf-cut-time-readout\s*\{[^}]*width:\s*70px;[^}]*flex-basis:\s*70px;/);
    expect(compactTabs).toMatch(/\.cf-cut-volume-control\s*\{[^}]*width:\s*60px;[^}]*height:\s*26px;/);
    expect(css).toMatch(/\.cf-cut-workspace\[data-feature-collapsed="true"\]\s*\{[^}]*grid-template-columns:\s*var\(--cf-cut-rail-width\) 0 minmax\(0, 1fr\)/);
  });

  it("owns canvas settings in the left pane and preserves the ratio draft without reloading on reopening", async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      projectRevision: revision, config: { aspectRatio: '4:3' },
    })));
    const canvasRequests = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith('/project-config'));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={2.5} onTimelineTimeCommit={vi.fn()} />));
      const player = host.querySelector('[data-testid="cut-player"]');
      const canvas = host.querySelector<HTMLElement>('[aria-label="项目画布设置"]')!;
      const canvasTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === '画布')!;
      const cutTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === '剪口播')!;
      expect(canvas.closest('[data-testid="cut-feature-panel"]')).not.toBeNull();
      expect(player?.contains(canvas)).toBe(false);
      expect(harness.cutPlayerProps.at(-1)).not.toHaveProperty('canvasSettings');
      expect(canvasRequests()).toHaveLength(0);
      await act(async () => canvasTab.click());
      expect(canvasRequests()).toHaveLength(1);
      const input = canvas.querySelector<HTMLInputElement>('[aria-label="自定义画布比例"]')!;
      expect(input.value).toBe('4:3');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '9:16');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const pane = canvas.closest<HTMLElement>('[role="tabpanel"]')!;
      pane.scrollTop = 123;
      act(() => canvasTab.click());
      expect(pane.hidden).toBe(true);
      act(() => cutTab.click());
      await act(async () => canvasTab.click());
      expect(pane.hidden).toBe(false);
      expect(host.querySelector('[aria-label="项目画布设置"]')).toBe(canvas);
      expect(canvas.querySelector('[aria-label="自定义画布比例"]')).toBe(input);
      expect(input.value).toBe('9:16');
      expect(pane.scrollTop).toBe(123);
      expect(canvasRequests()).toHaveLength(1);
      expect(canvasRequests()[0]?.[1]).toMatchObject({ method: 'GET' });
      expect(host.querySelector('[data-testid="cut-player"]')).toBe(player);
      expect(harness.patchOperation).not.toHaveBeenCalled();
      expect(harness.cutPlayerProps.at(-1)?.canvasAspectRatio).toBe(4 / 3);
    } finally { act(() => root.unmount()); host.remove(); }
  });

  it("contains orphan notices in the player without activating or deleting the animation", () => {
    const documentValue = { layers: [{ id: "removed-scene", wordIds: ["w1"], module: "modules/user-edited.html" }] };
    const before = JSON.stringify(documentValue);
    harness.useProjectVisuals.mockReturnValue({ document: documentValue, moduleUrl: vi.fn(), timings: [
      { layerId: "removed-scene", start: 0, end: 0, duration: 0, orphaned: true,
        animation: { clock: "local0", authoredDuration: 2, canvas: "project", issues: ["orphaned"], wordCues: [] } },
    ] });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
      expect(Array.from(host.querySelectorAll('[role="status"]')).some(node => node.textContent?.includes("整句已删除"))).toBe(true);
      expect(host.textContent).toContain("源码与用户修改保留");
      expect(host.querySelector('[data-testid="cut-player"] [role="status"]')?.textContent).toContain("整句已删除");
      expect(host.querySelector('.cf-cut-workspace > [role="status"]')).toBeNull();
      expect(harness.cutPlayerProps.at(-1)?.visualLayers).toEqual([]);
      expect(JSON.stringify(documentValue)).toBe(before);
      expect(harness.patchOperation).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); host.remove(); }
  });
  it("forwards the saved project aspect ratio to the audio canvas", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    expect(harness.cutPlayerProps.at(-1)?.canvasAspectRatio).toBe(4 / 3);
    act(() => root.unmount());
  });
  it("uses one ordered history for timeline then transcript commands", async () => {
    let currentDocument = reorderableDocument;
    let cutWordIds = new Set<string>();
    const updateCutWordIds = vi.fn(async (next: ReadonlySet<string>) => {
      cutWordIds = new Set(next);
      return true;
    });
    harness.patchOperation.mockImplementation(async (operation: EditListOperation) => {
      currentDocument = applyEditListOperation(currentDocument, operation);
      return currentDocument;
    });
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.useProjectCutSelection.mockImplementation(() => ({
      cutWordIds,
      saveState: "idle",
      selectionLoading: false,
      selectionReady: true,
      updateCutWordIds,
      canUndo: false,
      undoLastCutChange: harness.undoLastCutChange,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    await act(async () => {
      await latestTimelineProps().editList.patchOperation({ type: "move", clipId: "a-roll-0002", start: 0 });
    });
    await act(async () => {
      await latestTranscriptProps().cutSelection.updateCutWordIds(new Set(["w1"]));
    });
    expect(latestTimelineProps().canUndo).toBe(true);

    await act(async () => {
      await latestTimelineProps().onUndo();
    });
    expect(updateCutWordIds).toHaveBeenLastCalledWith(new Set(), { recordUndo: false });
    expect(harness.patchOperation).toHaveBeenCalledTimes(1);

    await act(async () => {
      await latestTimelineProps().onUndo();
    });
    expect(harness.patchOperation).toHaveBeenLastCalledWith({
      type: "move",
      clipId: "a-roll-0002",
      start: 2,
    });

    act(() => root.unmount());
  });

  it("uses one ordered history for transcript then timeline commands", async () => {
    let currentDocument = reorderableDocument;
    let cutWordIds = new Set<string>();
    const updateCutWordIds = vi.fn(async (next: ReadonlySet<string>) => {
      cutWordIds = new Set(next);
      return true;
    });
    harness.patchOperation.mockImplementation(async (operation: EditListOperation) => {
      currentDocument = applyEditListOperation(currentDocument, operation);
      return currentDocument;
    });
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.useProjectCutSelection.mockImplementation(() => ({
      cutWordIds,
      saveState: "idle",
      selectionLoading: false,
      selectionReady: true,
      updateCutWordIds,
      canUndo: false,
      undoLastCutChange: harness.undoLastCutChange,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    await act(async () => {
      await latestTranscriptProps().cutSelection.updateCutWordIds(new Set(["w1"]));
    });
    await act(async () => {
      await latestTimelineProps().editList.patchOperation({ type: "move", clipId: "a-roll-0002", start: 0 });
    });
    expect(latestTimelineProps().canUndo).toBe(true);

    await act(async () => {
      await latestTimelineProps().onUndo();
    });
    expect(harness.patchOperation).toHaveBeenLastCalledWith({
      type: "move",
      clipId: "a-roll-0002",
      start: 2,
    });

    await act(async () => {
      await latestTimelineProps().onUndo();
    });
    expect(updateCutWordIds).toHaveBeenLastCalledWith(new Set(), { recordUndo: false });

    act(() => root.unmount());
  });

  it("registers a transcript restore in the same history and undoes it by deleting the inserted segment", async () => {
    let currentDocument: EditListDocument = reorderableDocument;
    harness.patchOperation.mockImplementation(async (operation: EditListOperation) => {
      currentDocument = applyEditListOperation(currentDocument, operation);
      return currentDocument;
    });
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    await act(async () => {
      await latestTranscriptProps().editList.patchOperation({
        type: "restore",
        sourceStart: 2,
        sourceEnd: 4,
        previousSegmentId: "a-roll-0001",
        nextSegmentId: "a-roll-0002",
      });
    });
    expect(latestTimelineProps().canUndo).toBe(true);

    await act(async () => {
      await latestTimelineProps().onUndo();
    });
    expect(harness.patchOperation).toHaveBeenNthCalledWith(2, {
      type: "delete",
      clipId: "a-roll-restore-2000000-4000000",
    });

    act(() => root.unmount());
  });

  it("registers transcript delete-range in global history and undoes its exact snapshot inverse", async () => {
    const before: EditListDocument = applyEditListOperation(reorderableDocument, {
      type: "move",
      clipId: "a-roll-0002",
      start: 0,
    });
    let currentDocument = before;
    harness.patchOperation.mockImplementation(async (operation: EditListOperation) => {
      currentDocument = applyEditListOperation(currentDocument, operation);
      return currentDocument;
    });
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));

    const command: EditListOperation = {
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 4,
      sourceEnd: 6,
    };
    await act(async () => {
      await latestTranscriptProps().editList.patchOperation(command);
    });
    const deleted = currentDocument;
    expect(deleted).not.toEqual(before);
    expect(latestTimelineProps().canUndo).toBe(true);

    await act(async () => {
      await latestTimelineProps().onUndo();
    });
    expect(harness.patchOperation).toHaveBeenNthCalledWith(2, {
      type: "restore-snapshot",
      expectedSegments: deleted.segments,
      beforeSegments: before.segments,
      beforeMode: before.mode,
      inverse: command,
    });
    expect(currentDocument).toEqual(before);

    act(() => root.unmount());
  });

  it("registers timeline split as a reversible global command", async () => {
    let currentDocument = reorderableDocument;
    harness.patchOperation.mockImplementation(async (operation: EditListOperation) => {
      currentDocument = applyEditListOperation(currentDocument, operation);
      return currentDocument;
    });
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    await act(async () => {
      await latestTimelineProps().editList.patchOperation({
        type: "split",
        clipId: "a-roll-0002",
        offset: 2,
      });
    });
    expect(latestTimelineProps().canUndo).toBe(true);

    const splitSnapshot = structuredClone(currentDocument);
    await act(async () => {
      await latestTimelineProps().onUndo();
    });

    expect(harness.patchOperation).toHaveBeenNthCalledWith(2, {
      type: "restore-snapshot",
      expectedSegments: splitSnapshot.segments,
      beforeSegments: reorderableDocument.segments,
      beforeMode: reorderableDocument.mode,
      inverse: { type: "split", clipId: "a-roll-0002", offset: 2 },
    });
    expect(harness.patchOperation).toHaveBeenCalledTimes(2);
    expect(currentDocument).toEqual(reorderableDocument);
    expect(latestTimelineProps().canUndo).toBe(false);

    // The current global history exposes Undo only. Re-applying the same split
    // verifies redo geometry without inventing an unsupported redo command.
    await act(async () => {
      await latestTimelineProps().editList.patchOperation({ type: "split", clipId: "a-roll-0002", offset: 2 });
    });
    expect(currentDocument).toEqual(splitSnapshot);

    act(() => root.unmount());
  });

  for (const failure of ["persistence", "external-edit"] as const) {
    it(`retains split undo history and current document after ${failure} rejection`, async () => {
      let currentDocument = structuredClone(reorderableDocument);
      let rejectRestore = false;
      harness.patchOperation.mockImplementation(async (operation: EditListOperation) => {
        if (rejectRestore && operation.type === "restore-snapshot") throw new Error("persistence failed");
        currentDocument = applyEditListOperation(currentDocument, operation);
        return currentDocument;
      });
      harness.useProjectEditList.mockImplementation(() => ({
        projectId: "layout-contract", document: currentDocument, revision, loading: false,
        ready: true, saveState: "idle", reload: vi.fn(async () => true),
        patchOperation: harness.patchOperation, canUndo: false,
        undoLastEditListChange: harness.undoLastEditListChange,
      }));
      const host = document.createElement("div"); document.body.append(host);
      const root = createRoot(host);
      act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
      try {
        await act(async () => {
          await latestTimelineProps().editList.patchOperation({ type: "split", clipId: "a-roll-0002", offset: 2 });
        });
        if (failure === "persistence") rejectRestore = true;
        else currentDocument = applyEditListOperation(currentDocument, { type: "move", clipId: "a-roll-0001", start: 6 });
        const beforeAttempt = structuredClone(currentDocument);
        await act(async () => {
          await expect(latestTimelineProps().onUndo()).rejects.toThrow(failure === "persistence" ? "persistence failed" : "no longer matches");
        });
        expect(currentDocument).toEqual(beforeAttempt);
        expect(latestTimelineProps().canUndo).toBe(true);
        expect(harness.patchOperation).toHaveBeenCalledTimes(2);
        if (failure === "persistence") {
          rejectRestore = false;
          await act(async () => { await latestTimelineProps().onUndo(); });
          expect(currentDocument).toEqual(reorderableDocument);
          expect(latestTimelineProps().canUndo).toBe(false);
        }
      } finally { act(() => root.unmount()); }
    });
  }

  for (const operation of [{ type: "split" as const, clipId: "a-roll-0002", offset: 2 }, { type: "delete" as const, clipId: "a-roll-0002" }]) {
    it(`does not expose unsafe v2 ${operation.type} undo`, async () => {
      let currentDocument: EditListDocument = {
        ...structuredClone(reorderableDocument), schemaVersion: 2,
        sources: [{path:"input/source.mp4",sha256:revision,duration:12,mediaKind:"audio"}],
        segments: reorderableDocument.segments.map(s=>({...s,instanceId:"original"})),
      };
      harness.patchOperation.mockImplementation(async (op: EditListOperation) => {
        currentDocument=applyEditListOperation(currentDocument,op);return currentDocument;
      });
      harness.useProjectEditList.mockImplementation(()=>({
        projectId:"layout-contract",document:currentDocument,revision,loading:false,ready:true,
        saveState:"idle",reload:vi.fn(async()=>true),patchOperation:harness.patchOperation,
        canUndo:false,undoLastEditListChange:harness.undoLastEditListChange,
      }));
      const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
      act(()=>root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
      try {
        await act(async()=>{await latestTimelineProps().editList.patchOperation({type:"move",clipId:"a-roll-0002",start:0});});
        expect(latestTimelineProps().canUndo).toBe(true);
        await act(async()=>{await latestTimelineProps().editList.patchOperation(operation);});
        expect(latestTimelineProps().canUndo).toBe(false);
      } finally {act(()=>root.unmount());}
    });
  }

  it("preserves source instance when mapping multi-source workspace anchors", () => {
    const multi = {
      schemaVersion: 2 as const, projectId: "multi", sourceDuration: 2, duration: 4, mode: "manual" as const,
      baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "a".repeat(64),
      sources: ["input/a.wav", "input/b.wav"].map(path => ({ path, sha256: "a".repeat(64), duration: 2, mediaKind: "audio" as const })),
      segments: ["input/a.wav", "input/b.wav"].map((source, index) => ({ id: `s${index}`, source, instanceId: `i${index}`,
        sourceStart: 0, sourceEnd: 2, timelineStart: index * 2, trackId: "a-roll", playbackRate: 1 })),
    };
    expect(resolveTimelineAnchorForSourceTime(multi, 0.5, { source: "input/b.wav", instanceId: "i1" }))
      .toMatchObject({ timelineTime: 2.5, segmentId: "s1", reason: "retained" });
    expect(resolveTimelineAnchorForSourceTime(multi, 0.5)).toMatchObject({ timelineTime: 4, reason: "end" });
  });

  it("maps source anchors to retained content and falls to the next retained segment when the anchor was deleted", () => {
    expect(timelineTimeForSourceAnchor(splitDocument, 6)).toBeCloseTo(3, 3);
    expect(resolveTimelineAnchorForSourceTime(reorderedContinuousDocument, 5)).toMatchObject({
      timelineTime: 0,
      sourceTime: 8,
      segmentId: "a-roll-0001",
      reason: "next-retained",
    });
    expect(timelineTimeForSourceAnchor(splitDocument, 10)).toBeCloseTo(6, 3);
    expect(timelineTimeForSourceAnchor(reorderedContinuousDocument, -1)).toBeCloseTo(2, 3);
  });

  it("treats segment ends as half-open and jumps end-plus-epsilon to the next retained source", () => {
    const retained = resolveTimelineAnchorForSourceTime(halfOpenBoundaryDocument, 11.999);
    expect(retained).toMatchObject({
      sourceTime: 11.999,
      segmentId: "previous",
      reason: "retained",
    });
    expect(retained.timelineTime).toBeCloseTo(1.999, 6);
    expect(resolveTimelineAnchorForSourceTime(halfOpenBoundaryDocument, 12.0005)).toMatchObject({
      timelineTime: 2,
      sourceTime: 20,
      segmentId: "next",
      reason: "next-retained",
    });
    expect(resolveTimelineAnchorForSourceTime(halfOpenBoundaryDocument, 24.0005)).toMatchObject({
      timelineTime: 6,
      sourceTime: 24,
      segmentId: "next",
      reason: "end",
    });
  });

  it("keeps a prior verified artifact visible while the next revision generates", () => {
    harness.usePreviewArtifact.mockReturnValue({
      current: false,
      state: {
        phase: "generating",
        editRevision: revision,
        artifactRevision: "old",
        source: "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutWorkspace
        projectId="layout-contract"
        initialTimelineTime={2.5}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    expect(harness.useAssembledVideoTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceUrl: "/preview/current.mp4",
    }));
    expect(harness.cutPlayerProps.at(-1)?.sourceUrl).toBe("/preview/current.mp4");

    act(() => root.unmount());
  });

  it("queues only the newest seek while preview generates, then sends it to the current transport", () => {
    let current = false;
    const seek = vi.fn(async () => undefined);
    harness.usePreviewArtifact.mockImplementation(() => ({
      current,
      state: {
        phase: current ? "current" : "generating",
        editRevision: revision,
        artifactRevision: current ? revision : "old",
        source: current ? "current-preview.mp4" : "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(), timelineTime: 1, duration: 10, isPlaying: false, desiredPlaying: false,
      isWaiting: false, isSeeking: false, playbackRate: 1, volume: 1, muted: false, loopEnabled: false, error: null,
      play: vi.fn(async () => undefined), pause: vi.fn(), togglePlay: vi.fn(async () => undefined), seek,
      setPlaybackRate: vi.fn(), setVolume: vi.fn(), toggleMuted: vi.fn(), toggleLoop: vi.fn(), restoreIntent: vi.fn(async () => undefined),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    (harness.transcriptProps.at(-1)?.onSeek as (time: number, options?: { keepPlaying?: boolean }) => void)(2, {
      keepPlaying: true,
    });
    (harness.cutTimelineProps.at(-1)?.onSeek as (time: number) => void)(3);
    expect(seek).not.toHaveBeenCalled();

    current = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(3);
    act(() => root.unmount());
  });

  it("drops a queued seek when a later EDL revision supersedes it", () => {
    let current = false;
    let currentRevision = revision;
    const nextRevision = "z".repeat(64);
    const seek = vi.fn(async () => undefined);
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: editListDocument,
      revision: currentRevision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.usePreviewArtifact.mockImplementation(() => ({
      current,
      state: {
        phase: current ? "current" : "generating",
        editRevision: currentRevision,
        artifactRevision: current ? currentRevision : revision,
        source: current ? "current-preview.mp4" : "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(), timelineTime: 1, duration: 10, isPlaying: false, desiredPlaying: false,
      isWaiting: false, isSeeking: false, playbackRate: 1, volume: 1, muted: false, loopEnabled: false, error: null,
      play: vi.fn(async () => undefined), pause: vi.fn(), togglePlay: vi.fn(async () => undefined), seek,
      setPlaybackRate: vi.fn(), setVolume: vi.fn(), toggleMuted: vi.fn(), toggleLoop: vi.fn(), restoreIntent: vi.fn(async () => undefined),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    (harness.transcriptProps.at(-1)?.onSeek as (time: number, options?: { keepPlaying?: boolean }) => void)(2, {
      keepPlaying: true,
    });
    currentRevision = nextRevision;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    current = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));

    expect(seek).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("forwards a transcript playback request to the current EDL transport", () => {
    const seek = vi.fn(async () => undefined);
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(), timelineTime: 1, duration: 10, isPlaying: false, desiredPlaying: false,
      isWaiting: false, isSeeking: false, playbackRate: 1, volume: 1, muted: false, loopEnabled: false, error: null,
      play: vi.fn(async () => undefined), pause: vi.fn(), togglePlay: vi.fn(async () => undefined), seek,
      setPlaybackRate: vi.fn(), setVolume: vi.fn(), toggleMuted: vi.fn(), toggleLoop: vi.fn(), restoreIntent: vi.fn(async () => undefined),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={vi.fn()} />));
    latestTranscriptProps().onSeek(2, { keepPlaying: true });

    expect(seek).toHaveBeenCalledWith(2, { keepPlaying: true });
    act(() => root.unmount());
  });

  it("keeps the transcript seek callback stable while the transport wrapper advances", () => {
    const transportSeek = vi.fn(async () => undefined);
    let timelineTime = 1;
    harness.useAssembledVideoTransport.mockImplementation(() => ({
      videoRef: stubVideoRef(), timelineTime, duration: 10, isPlaying: true, desiredPlaying: true,
      isWaiting: false, isSeeking: false, playbackRate: 1, volume: 1, muted: false, loopEnabled: false, error: null,
      play: vi.fn(async () => undefined), pause: vi.fn(), togglePlay: vi.fn(async () => undefined), seek: transportSeek,
      setPlaybackRate: vi.fn(), setVolume: vi.fn(), toggleMuted: vi.fn(), toggleLoop: vi.fn(), restoreIntent: vi.fn(async () => undefined),
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onTimelineTimeCommit = vi.fn();

    act(() => root.render(
      <CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={onTimelineTimeCommit} />,
    ));
    const initialOnSeek = latestTranscriptProps().onSeek;
    const initialTranscriptRenderCount = harness.transcriptProps.length;
    expect(harness.transcriptProps.at(-1)).not.toHaveProperty("timelineTime");
    timelineTime = 1.1;
    act(() => root.render(
      <CutWorkspace projectId="layout-contract" initialTimelineTime={1} onTimelineTimeCommit={onTimelineTimeCommit} />,
    ));

    expect(latestTranscriptProps().onSeek).toBe(initialOnSeek);
    expect(harness.transcriptProps).toHaveLength(initialTranscriptRenderCount);
    act(() => root.unmount());
  });

  it("restores playing intent to the next retained content after a revision refresh", () => {
    const restoreIntent = vi.fn(async () => undefined);
    let currentDocument = editListDocument;
    let currentRevision = revision;
    let artifactCurrent = true;
    const nextRevision = "b".repeat(64);
    const onTimelineTimeCommit = vi.fn();
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision: currentRevision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.usePreviewArtifact.mockImplementation(() => ({
      current: artifactCurrent,
      state: {
        phase: artifactCurrent ? "current" : "generating",
        editRevision: currentRevision,
        artifactRevision: artifactCurrent ? currentRevision : revision,
        source: artifactCurrent ? "preview.mp4" : "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(),
      timelineTime: 3,
      duration: 10,
      isPlaying: true,
      desiredPlaying: true,
      isWaiting: false,
      isSeeking: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loopEnabled: false,
      error: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      togglePlay: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      toggleMuted: vi.fn(),
      toggleLoop: vi.fn(),
      restoreIntent,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={onTimelineTimeCommit} />,
    ));
    currentDocument = splitDocument;
    currentRevision = nextRevision;
    artifactCurrent = false;
    act(() => root.render(
      <CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={onTimelineTimeCommit} />,
    ));
    expect(restoreIntent).not.toHaveBeenCalled();
    expect(harness.cutPlayerProps.at(-1)?.sourceUrl).toBe("/preview/current.mp4");

    artifactCurrent = true;
    act(() => root.render(
      <CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={onTimelineTimeCommit} />,
    ));
    expect(restoreIntent).toHaveBeenCalledWith(2, true);
    expect(onTimelineTimeCommit).toHaveBeenCalledWith(2);

    act(() => root.unmount());
  });

  it("keeps paused intent after a revision refresh", () => {
    const restoreIntent = vi.fn(async () => undefined);
    let currentRevision = revision;
    let artifactCurrent = true;
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentRevision === revision ? editListDocument : splitDocument,
      revision: currentRevision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.usePreviewArtifact.mockImplementation(() => ({
      current: artifactCurrent,
      state: {
        phase: artifactCurrent ? "current" : "failed",
        editRevision: currentRevision,
        artifactRevision: artifactCurrent ? currentRevision : revision,
        source: artifactCurrent ? "preview.mp4" : "old-preview.mp4",
        error: artifactCurrent ? null : "failed",
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(),
      timelineTime: 6,
      duration: 10,
      isPlaying: false,
      desiredPlaying: false,
      isWaiting: false,
      isSeeking: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loopEnabled: false,
      error: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      togglePlay: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      toggleMuted: vi.fn(),
      toggleLoop: vi.fn(),
      restoreIntent,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={6} onTimelineTimeCommit={vi.fn()} />));
    currentRevision = "c".repeat(64);
    artifactCurrent = false;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={6} onTimelineTimeCommit={vi.fn()} />));
    expect(restoreIntent).not.toHaveBeenCalled();
    expect(harness.cutPlayerProps.at(-1)?.sourceUrl).toBe("/preview/current.mp4");

    artifactCurrent = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={6} onTimelineTimeCommit={vi.fn()} />));
    expect(restoreIntent).toHaveBeenCalledWith(3, false);

    act(() => root.unmount());
  });

  it("uses explicit desired playback intent when play and revision replacement race", () => {
    const restoreIntent = vi.fn(async () => undefined);
    let currentDocument = editListDocument;
    let currentRevision = revision;
    let artifactCurrent = true;
    const nextRevision = "d".repeat(64);
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision: currentRevision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.usePreviewArtifact.mockImplementation(() => ({
      current: artifactCurrent,
      state: {
        phase: artifactCurrent ? "current" : "generating",
        editRevision: currentRevision,
        artifactRevision: artifactCurrent ? currentRevision : revision,
        source: artifactCurrent ? "preview.mp4" : "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(),
      timelineTime: 3,
      duration: 10,
      isPlaying: false,
      desiredPlaying: true,
      isWaiting: false,
      isSeeking: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loopEnabled: false,
      error: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      togglePlay: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      toggleMuted: vi.fn(),
      toggleLoop: vi.fn(),
      restoreIntent,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    currentDocument = splitDocument;
    currentRevision = nextRevision;
    artifactCurrent = false;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    artifactCurrent = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));

    expect(restoreIntent).toHaveBeenCalledWith(2, true);

    act(() => root.unmount());
  });

  it("keeps a user pause made while the new artifact is generating", () => {
    const restoreIntent = vi.fn(async () => undefined);
    let currentDocument = editListDocument;
    let currentRevision = revision;
    let artifactCurrent = true;
    let desiredPlaying = true;
    const nextRevision = "e".repeat(64);
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision: currentRevision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.usePreviewArtifact.mockImplementation(() => ({
      current: artifactCurrent,
      state: {
        phase: artifactCurrent ? "current" : "generating",
        editRevision: currentRevision,
        artifactRevision: artifactCurrent ? currentRevision : revision,
        source: artifactCurrent ? "preview.mp4" : "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockImplementation(() => ({
      videoRef: stubVideoRef(),
      timelineTime: 3,
      duration: 10,
      isPlaying: desiredPlaying,
      desiredPlaying,
      isWaiting: false,
      isSeeking: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loopEnabled: false,
      error: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      togglePlay: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      toggleMuted: vi.fn(),
      toggleLoop: vi.fn(),
      restoreIntent,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    currentDocument = splitDocument;
    currentRevision = nextRevision;
    artifactCurrent = false;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    desiredPlaying = false;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    artifactCurrent = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));

    expect(restoreIntent).toHaveBeenCalledWith(2, false);

    act(() => root.unmount());
  });

  it("keeps a user play intent made while the new artifact is generating", () => {
    const restoreIntent = vi.fn(async () => undefined);
    let currentDocument = editListDocument;
    let currentRevision = revision;
    let artifactCurrent = true;
    let desiredPlaying = false;
    const nextRevision = "f".repeat(64);
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision: currentRevision,
      loading: false,
      ready: true,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.usePreviewArtifact.mockImplementation(() => ({
      current: artifactCurrent,
      state: {
        phase: artifactCurrent ? "current" : "generating",
        editRevision: currentRevision,
        artifactRevision: artifactCurrent ? currentRevision : revision,
        source: artifactCurrent ? "preview.mp4" : "old-preview.mp4",
        error: null,
      },
      retry: vi.fn(),
    }));
    harness.useAssembledVideoTransport.mockImplementation(() => ({
      videoRef: stubVideoRef(),
      timelineTime: 3,
      duration: 10,
      isPlaying: desiredPlaying,
      desiredPlaying,
      isWaiting: false,
      isSeeking: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loopEnabled: false,
      error: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      togglePlay: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      toggleMuted: vi.fn(),
      toggleLoop: vi.fn(),
      restoreIntent,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    currentDocument = splitDocument;
    currentRevision = nextRevision;
    artifactCurrent = false;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    desiredPlaying = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));
    artifactCurrent = true;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={3} onTimelineTimeCommit={vi.fn()} />));

    expect(restoreIntent).toHaveBeenCalledWith(2, true);

    act(() => root.unmount());
  });

  it("does not reinterpret the initial deep-link timeline time as a source anchor", () => {
    const restoreIntent = vi.fn(async () => undefined);
    let currentDocument = null as typeof editListDocument | null;
    let currentRevision = "loading";
    harness.useProjectEditList.mockImplementation(() => ({
      projectId: "layout-contract",
      document: currentDocument,
      revision: currentRevision,
      loading: currentDocument == null,
      ready: currentDocument != null,
      saveState: "idle",
      reload: vi.fn(async () => true),
      patchOperation: harness.patchOperation,
      canUndo: false,
      undoLastEditListChange: harness.undoLastEditListChange,
    }));
    harness.useAssembledVideoTransport.mockReturnValue({
      videoRef: stubVideoRef(),
      timelineTime: 6,
      duration: 10,
      isPlaying: false,
      desiredPlaying: false,
      isWaiting: false,
      isSeeking: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loopEnabled: false,
      error: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      togglePlay: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      toggleMuted: vi.fn(),
      toggleLoop: vi.fn(),
      restoreIntent,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={6} onTimelineTimeCommit={vi.fn()} />));
    currentDocument = splitDocument;
    currentRevision = revision;
    act(() => root.render(<CutWorkspace projectId="layout-contract" initialTimelineTime={6} onTimelineTimeCommit={vi.fn()} />));

    expect(restoreIntent).not.toHaveBeenCalled();
    expect(harness.useAssembledVideoTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      initialTimelineTime: 6,
    }));

    act(() => root.unmount());
  });

  it("keeps transcript, Player, and full-width Timeline under one owner", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutWorkspace
        projectId="layout-contract"
        initialTimelineTime={2.5}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const workspace = host.querySelector<HTMLElement>('[data-koubo-layout="single-page"]');
    expect(workspace).not.toBeNull();
    expect(Array.from(workspace?.children ?? []).map((child) => child.getAttribute("data-testid"))).toEqual([
      "cut-feature-panel",
      "transcript-width-resizer",
      "cut-player",
      "cut-timeline",
    ]);
    expect(workspace?.querySelector("[data-testid='transcript-width-resizer']")?.getAttribute("role")).toBe(
      "separator",
    );
    expect(workspace?.querySelector(".cf-cut-inspector")).toBeNull();
    expect(workspace?.querySelector(".cf-cut-program")).toBeNull();
    // Renamed from 文稿: this pane decides what survives, and the tab beside it
    // is also a script.
    // With no subtitle document, the style surface must not advertise an empty
    // place to go; the document-present case is covered by the next test.
    expect(
      Array.from(workspace?.querySelectorAll('.cf-cut-feature-panel [role="tab"]') ?? [])
        .map((tab) => tab.textContent),
    ).toEqual(["剪口播", "字幕", "画布", "音频"]);
    expect(workspace?.querySelector('[role="tabpanel"] [data-testid="koubo-transcript"]')).not.toBeNull();
    expect(harness.patchOperation).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(harness.patchOperation).not.toHaveBeenCalled();
  });

  it("keeps the resizer desktop-only while Timeline remains a full-width row", () => {
    const css = readFileSync("src/cut/cut.css", "utf8");
    expect(css).toContain("var(--cf-cut-transcript-width, 320px)");
    expect(css.replace(/\s+/g, " ")).toContain("var(--cf-cut-transcript-width, 320px) 3px minmax(0, 1fr)");
    // The resizer already clamps this preference; another CSS cap makes
    // the visible width disagree with pointer/keyboard and ARIA values.
    expect(css).not.toContain("min(var(--cf-cut-transcript-width");
    expect(css).not.toContain("minmax(420px, 1fr)");
    expect(css).not.toContain("cf-cut-inspector-width");
    expect(css).not.toContain(".cf-cut-inspector");
    expect(css).toContain("column-gap: 0;");
    expect(css).toContain("row-gap: 3px;");
    expect(css).toContain(".cf-cut-workspace > .cf-cut-timeline");
    expect(css).toContain("grid-column: 1 / -1");
    expect(css).toContain("@media (width < 960px)");
    expect(css).toContain(".cf-cut-transcript-resizer {\n    display: none;");
  });

  it("switches left feature modes without remounting Player or Timeline", () => {
    const setStyle = vi.fn();
    harness.useProjectSubtitles.mockReturnValue({
      projectId: "layout-contract",
      document: {
        schemaVersion: 1,
        projectId: "layout-contract",
        baseTranscriptRevision: revision,
        style: DEFAULT_SUBTITLE_STYLE,
        cues: [],
      },
      revision,
      timings: [],
      stale: [],
      loading: false,
      ready: true,
      saveState: "idle",
      error: null,
      reload: vi.fn(async () => undefined),
      save: vi.fn(),
      setCueText: vi.fn(),
      setStyle,
      mergeWithPrevious: vi.fn(),
      splitAt: vi.fn(),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutWorkspace
        projectId="layout-contract"
        initialTimelineTime={2.5}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const playerBefore = host.querySelector('[data-testid="cut-player"]');
    const timelineBefore = host.querySelector('[data-testid="cut-timeline"]');
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('.cf-cut-feature-panel [role="tab"]'));
    expect(tabs.map(tab => tab.textContent)).toEqual(["剪口播", "字幕", "字幕样式", "画布", "音频"]);
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical');
    const subtitleStyleTab = tabs.find((tab) => tab.textContent === "字幕样式");
    if (!playerBefore || !timelineBefore || !subtitleStyleTab) {
      throw new Error("Expected the stable player, timeline, and 字幕样式 tab");
    }

    act(() => subtitleStyleTab.click());

    expect(subtitleStyleTab.getAttribute("aria-selected")).toBe("true");
    const secondLook = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))[1];
    act(() => secondLook?.click());
    expect(setStyle).toHaveBeenCalledWith(SUBTITLE_STYLE_PRESETS[1]?.style);
    expect(host.querySelector('[data-testid="cut-player"]')).toBe(playerBefore);
    expect(host.querySelector('[data-testid="cut-timeline"]')).toBe(timelineBefore);

    act(() => root.unmount());
  });

  it("drops the style tab and lands on 字幕 when the subtitle document disappears", () => {
    let subtitleDocument: SubtitleDocument | null = {
      schemaVersion: 1,
      projectId: "layout-contract",
      baseTranscriptRevision: revision,
      style: DEFAULT_SUBTITLE_STYLE,
      cues: [],
    };
    harness.useProjectSubtitles.mockImplementation(() => ({
      projectId: "layout-contract",
      document: subtitleDocument,
      revision: subtitleDocument ? revision : "none",
      timings: [],
      stale: [],
      loading: false,
      ready: true,
      saveState: "idle",
      error: null,
      reload: vi.fn(async () => undefined),
      save: vi.fn(),
      setCueText: vi.fn(),
      setStyle: vi.fn(),
      mergeWithPrevious: vi.fn(),
      splitAt: vi.fn(),
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutWorkspace
        projectId="layout-contract"
        initialTimelineTime={2.5}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const playerBefore = host.querySelector('[data-testid="cut-player"]');
    const timelineBefore = host.querySelector('[data-testid="cut-timeline"]');
    const styleTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "字幕样式");
    if (!playerBefore || !timelineBefore || !styleTab) {
      throw new Error("Expected the stable player, timeline, and available 字幕样式 tab");
    }
    act(() => styleTab.click());
    expect(styleTab.getAttribute("aria-selected")).toBe("true");

    subtitleDocument = null;
    act(() => root.render(
      <CutWorkspace
        projectId="layout-contract"
        initialTimelineTime={2.5}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["剪口播", "字幕", "画布", "音频"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(host.querySelector(".cf-cut-feature-content--subtitle-style")).toBeNull();
    expect(host.querySelector('[data-testid="cut-player"]')).toBe(playerBefore);
    expect(host.querySelector('[data-testid="cut-timeline"]')).toBe(timelineBefore);

    act(() => root.unmount());
  });

  it("does not keep a second playback-shortcut owner in the workspace", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutWorkspace
        projectId="layout-contract"
        initialTimelineTime={2.5}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const transport = harness.useAssembledVideoTransport.mock.results.at(-1)?.value;
    const button = host.querySelector<HTMLButtonElement>('[role="tab"]');
    if (!button) throw new Error("Expected the local feature tab");
    const buttonSpace = new KeyboardEvent("keydown", {
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    act(() => button.dispatchEvent(buttonSpace));

    expect(buttonSpace.defaultPrevented).toBe(false);
    expect(transport.play).not.toHaveBeenCalled();

    const canvasSpace = new KeyboardEvent("keydown", {
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(canvasSpace));

    expect(canvasSpace.defaultPrevented).toBe(false);
    expect(transport.play).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
