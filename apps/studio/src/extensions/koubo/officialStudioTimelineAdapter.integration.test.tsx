// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StudioTimelineEditingAdapter,
} from "../../hooks/timelineEditingExtension";
import type { TimelineElement } from "../../player";
import { useTimelineEditing } from "../../hooks/useTimelineEditing";
import { persistTimelineMoveEditsAtomically } from "../../hooks/timelineMoveAdapter";
import { usePlayerStore } from "../../player";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const managed: TimelineElement = {
  id: "segment-dom",
  key: "segment-dom",
  domId: "segment-dom",
  tag: "div",
  start: 0,
  duration: 4,
  track: 1,
  playbackStart: 2,
  playbackRate: 1,
  edlSegmentId: "segment-1",
  edlSourceStart: 2,
  edlSourceEnd: 6,
};

const managedCompanion: TimelineElement = {
  ...managed,
  id: "segment-dom-2",
  key: "segment-dom-2",
  domId: "segment-dom-2",
  start: 4,
  playbackStart: 6,
  edlSegmentId: "segment-2",
  edlSourceStart: 6,
  edlSourceEnd: 10,
};

const unmanagedCompanion: TimelineElement = {
  ...managedCompanion,
  id: "title-card",
  key: "title-card",
  domId: "title-card",
  tag: "div",
  edlSegmentId: undefined,
  edlSourceStart: undefined,
  edlSourceEnd: undefined,
};

afterEach(() => {
  document.body.replaceChildren();
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
});

describe("official Studio timeline adapter seam", () => {
  it("routes the production group-move path plus trim, split and delete through the adapter", async () => {
    const adapter: StudioTimelineEditingAdapter = {
      handles: (element) => element.edlSegmentId === "segment-1",
      move: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      split: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      blockClipboard: true,
    };
    const reloadPreview = vi.fn();
    const forceReloadSdkSession = vi.fn();
    let hook: ReturnType<typeof useTimelineEditing> | null = null;

    function Probe() {
      hook = useTimelineEditing({
        projectId: "demo",
        activeCompPath: "index.html",
        timelineElements: [managed],
        showToast: vi.fn(),
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview,
        previewIframeRef: { current: null },
        pendingTimelineEditPathRef: { current: new Set() },
        uploadProjectFiles: vi.fn(),
        forceReloadSdkSession,
        timelineEditingAdapter: adapter,
      });
      return null;
    }

    usePlayerStore.getState().setElements([managed]);
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Probe />));

    await act(async () => {
      await hook!.handleTimelineGroupMove([{ element: managed, start: 1.5 }]);
      await hook!.handleTimelineElementResize(managed, {
        start: 1,
        duration: 3,
        playbackStart: 3,
      });
      await hook!.handleRazorSplit(managed, 2);
      await hook!.handleTimelineElementDelete(managed);
    });

    expect(adapter.move).toHaveBeenCalledWith(managed, { start: 1.5, track: 1 });
    expect(adapter.resize).toHaveBeenCalledWith(managed, {
      start: 1,
      duration: 3,
      playbackStart: 3,
    });
    expect(adapter.split).toHaveBeenCalledWith(managed, 2);
    expect(adapter.delete).toHaveBeenCalledWith(managed);
    expect(reloadPreview).toHaveBeenCalledTimes(4);
    expect(forceReloadSdkSession).toHaveBeenCalledTimes(4);

    act(() => root.unmount());
  });

  it("accepts the native single-drag track-insert batch and ignores track-only A-roll companions", async () => {
    const adapter: StudioTimelineEditingAdapter = {
      handles: (element) => Boolean(element.edlSegmentId),
      move: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      split: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    let hook: ReturnType<typeof useTimelineEditing> | null = null;

    function Probe() {
      hook = useTimelineEditing({
        projectId: "demo",
        activeCompPath: "index.html",
        timelineElements: [managed, managedCompanion],
        showToast: vi.fn(),
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        previewIframeRef: { current: null },
        pendingTimelineEditPathRef: { current: new Set() },
        uploadProjectFiles: vi.fn(),
        timelineEditingAdapter: adapter,
      });
      return null;
    }

    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Probe />));

    // This is the real native track-insert payload shape: the grabbed clip has
    // a new start/track, while adjacent clips are included only because their
    // authored track numbers must be compacted by generic HyperFrames.
    await act(async () => {
      await persistTimelineMoveEditsAtomically(
        [
          { element: managed, updates: { start: 5, track: 2 } },
          { element: managedCompanion, updates: { start: 4, track: 3 } },
        ],
        "clip-lane-move:browser-e2e",
        "track-insert",
        { handleTimelineGroupMove: hook!.handleTimelineGroupMove },
        undefined,
        { primaryElementKey: managed.key!, multiSelection: false },
      );
    });

    expect(adapter.move).toHaveBeenCalledTimes(1);
    expect(adapter.move).toHaveBeenCalledWith(managed, { start: 5, track: 2 });
    act(() => root.unmount());
  });

  it("keeps mixed batches, true multi-moves and multi-resizes fail-closed", async () => {
    const adapter: StudioTimelineEditingAdapter = {
      handles: (element) => Boolean(element.edlSegmentId),
      move: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      split: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const showToast = vi.fn();
    let hook: ReturnType<typeof useTimelineEditing> | null = null;

    function Probe() {
      hook = useTimelineEditing({
        projectId: "demo",
        activeCompPath: "index.html",
        timelineElements: [managed, managedCompanion, unmanagedCompanion],
        showToast,
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        previewIframeRef: { current: null },
        pendingTimelineEditPathRef: { current: new Set() },
        uploadProjectFiles: vi.fn(),
        timelineEditingAdapter: adapter,
      });
      return null;
    }

    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Probe />));

    await act(async () => {
      await expect(
        persistTimelineMoveEditsAtomically(
          [
            { element: managed, updates: { start: 5, track: 2 } },
            { element: unmanagedCompanion, updates: { start: 4, track: 3 } },
          ],
          "clip-lane-move:mixed",
          "track-insert",
          { handleTimelineGroupMove: hook!.handleTimelineGroupMove },
          undefined,
          { primaryElementKey: managed.key!, multiSelection: false },
        ),
      ).rejects.toThrow("Managed A-roll clips must be moved one at a time");

      await expect(
        persistTimelineMoveEditsAtomically(
          [
            { element: managed, updates: { start: 5, track: 2 } },
            { element: managedCompanion, updates: { start: 9, track: 3 } },
          ],
          "clip-lane-move:multi",
          "track-insert",
          { handleTimelineGroupMove: hook!.handleTimelineGroupMove },
          undefined,
          { primaryElementKey: managed.key!, multiSelection: true },
        ),
      ).rejects.toThrow("Managed A-roll clips must be moved one at a time");

      await expect(
        hook!.handleTimelineGroupResize(
          [
            { element: managed, start: 1, duration: 3, playbackStart: 3 },
            { element: managedCompanion, start: 5, duration: 3, playbackStart: 7 },
          ],
          { primaryElementKey: managed.key!, multiSelection: true },
        ),
      ).rejects.toThrow("Managed A-roll clips must be resized one at a time");
    });

    expect(adapter.move).not.toHaveBeenCalled();
    expect(adapter.resize).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "Managed A-roll clips must be moved one at a time",
      "error",
    );
    expect(showToast).toHaveBeenCalledWith(
      "Managed A-roll clips must be resized one at a time",
      "error",
    );
    act(() => root.unmount());
  });
});
