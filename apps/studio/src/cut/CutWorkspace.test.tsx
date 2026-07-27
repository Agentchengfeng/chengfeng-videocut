// @vitest-environment happy-dom

import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot } from "react-dom/client";
import { applyEditListOperation, type EditListDocument, type EditListOperation } from "@video-workbench/core";
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
    return <section data-testid="cut-player" data-source-url={String(props.sourceUrl ?? "")} />;
  },
}));

vi.mock("./transcript/KouboTranscriptPane", () => ({
  KouboTranscriptPane: (props: Record<string, unknown>) => {
    harness.transcriptProps.push(props);
    return (
      <aside data-testid="koubo-transcript">
        <button type="button" data-testid="transcript-action">文稿操作</button>
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

    await act(async () => {
      await latestTimelineProps().onUndo();
    });

    expect(harness.patchOperation).toHaveBeenNthCalledWith(2, {
      type: "trim",
      clipId: "a-roll-0002",
      sourceStart: 4,
      sourceEnd: 8,
    });
    expect(harness.patchOperation).toHaveBeenNthCalledWith(3, {
      type: "delete",
      clipId: "a-roll-0002__split_6000",
    });

    act(() => root.unmount());
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

  it("keeps transcript, Player, properties column, and full-width Timeline under one owner", () => {
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
      // One column for "the properties of whatever is selected". Subtitle style
      // lives here, and so will storyboard and animation parameters; none of
      // them opens a column of its own.
      null,
      "cut-timeline",
    ]);
    expect(workspace?.querySelector("[data-testid='transcript-width-resizer']")?.getAttribute("role")).toBe(
      "separator",
    );
    expect(workspace?.querySelector(".cf-cut-inspector")).not.toBeNull();
    expect(workspace?.querySelector(".cf-cut-program")).toBeNull();
    // Renamed from 文稿: this pane decides what survives, and the tab beside it
    // is also a script.
    expect(
      Array.from(workspace?.querySelectorAll('[role="tab"]') ?? []).map((tab) => tab.textContent),
    ).toEqual(["剪口播", "字幕"]);
    expect(workspace?.querySelector('[role="tabpanel"] [data-testid="koubo-transcript"]')).not.toBeNull();
    expect(harness.patchOperation).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(harness.patchOperation).not.toHaveBeenCalled();
  });

  it("keeps the resizer desktop-only while Timeline remains a full-width row", () => {
    const css = readFileSync("src/cut/cut.css", "utf8");
    expect(css).toContain("var(--cf-cut-transcript-width, 320px)");
    expect(css).toContain("minmax(420px, 1fr)");
    expect(css).toContain("var(--cf-cut-inspector-width, 264px)");
    expect(css).toContain("column-gap: 0;");
    expect(css).toContain("row-gap: 3px;");
    expect(css).toContain(".cf-cut-workspace > .cf-cut-timeline");
    expect(css).toContain("grid-column: 1 / -1");
    expect(css).toContain("@media (width < 960px)");
    expect(css).toContain(".cf-cut-transcript-resizer {\n    display: none;");
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
