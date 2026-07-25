// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditListDocument, EditListOperation } from "@video-workbench/core";
import type { TimelineElement } from "../player";
import { useTimelineEditing } from "./useTimelineEditing";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const revision = "a".repeat(64);
const editListDocument: EditListDocument = {
  schemaVersion: 1,
  projectId: "demo",
  sourceDuration: 20,
  baseCutsRevision: revision,
  baseTranscriptRevision: revision,
  mode: "manual",
  duration: 4,
  segments: [
    {
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 10,
      sourceEnd: 14,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

const managedElement: TimelineElement = {
  id: "a-roll-segment-a-roll-0001",
  domId: "a-roll-segment-a-roll-0001",
  tag: "video",
  start: 0,
  duration: 4,
  track: 1,
  playbackStart: 10,
  playbackRate: 1,
  edlSegmentId: "a-roll-0001",
  edlSourceStart: 10,
  edlSourceEnd: 14,
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useTimelineEditing EDL routing", () => {
  it("routes single move, trim and delete to the CAS EDL operation channel", async () => {
    const patchOperation = vi.fn(async (_operation: EditListOperation) => editListDocument);
    const showToast = vi.fn();
    let hook: ReturnType<typeof useTimelineEditing> | null = null;

    function Harness() {
      hook = useTimelineEditing({
        projectId: "demo",
        activeCompPath: "index.html",
        timelineElements: [managedElement],
        showToast,
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        previewIframeRef: { current: null },
        pendingTimelineEditPathRef: { current: new Set() },
        uploadProjectFiles: vi.fn(),
        editList: { document: editListDocument, patchOperation },
      });
      return null;
    }

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Harness />));

    await act(async () => {
      await hook!.handleTimelineElementMove(managedElement, { start: 2, track: 1 });
      await hook!.handleTimelineElementResize(managedElement, {
        start: 1,
        duration: 3,
        playbackStart: 11,
      });
      await hook!.handleTimelineElementDelete(managedElement);
    });

    expect(patchOperation.mock.calls.map(([operation]) => operation)).toEqual([
      { type: "move", clipId: "a-roll-0001", start: 2 },
      { type: "trim", clipId: "a-roll-0001", sourceStart: 11, sourceEnd: 14 },
      { type: "delete", clipId: "a-roll-0001" },
    ]);
    act(() => root.unmount());
  });

  it("blocks M1 group operations when a selection contains a managed segment", async () => {
    const patchOperation = vi.fn(async (_operation: EditListOperation) => editListDocument);
    const showToast = vi.fn();
    let hook: ReturnType<typeof useTimelineEditing> | null = null;

    function Harness() {
      hook = useTimelineEditing({
        projectId: "demo",
        activeCompPath: "index.html",
        timelineElements: [managedElement],
        showToast,
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        previewIframeRef: { current: null },
        pendingTimelineEditPathRef: { current: new Set() },
        uploadProjectFiles: vi.fn(),
        editList: { document: editListDocument, patchOperation },
      });
      return null;
    }

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Harness />));

    await act(async () => {
      await expect(
        hook!.handleTimelineGroupMove([{ element: managedElement, start: 2 }]),
      ).rejects.toThrow("M1 does not support moving managed clips as a group");
      await expect(hook!.handleTimelineGroupResize([
        { element: managedElement, start: 1, duration: 3, playbackStart: 11 },
      ])).rejects.toThrow("M1 does not support trimming managed clips as a group");
    });

    expect(patchOperation).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "口播主轨暂不支持多选移动，请逐个调整。",
      "info",
    );
    expect(showToast).toHaveBeenCalledWith(
      "口播主轨暂不支持多选剪裁，请逐个调整。",
      "info",
    );
    act(() => root.unmount());
  });
});
