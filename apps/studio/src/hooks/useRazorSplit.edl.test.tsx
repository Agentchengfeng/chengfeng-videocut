// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditListDocument, EditListOperation } from "@video-workbench/core";
import { usePlayerStore, type TimelineElement } from "../player";
import { useRazorSplit } from "./useRazorSplit";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const revision = "a".repeat(64);
const editListDocument: EditListDocument = {
  schemaVersion: 1,
  projectId: "demo",
  sourceDuration: 10,
  baseCutsRevision: revision,
  baseTranscriptRevision: revision,
  mode: "manual",
  duration: 4,
  segments: [{
    id: "segment-1",
    source: "input/source.mp4",
    sourceStart: 2,
    sourceEnd: 6,
    timelineStart: 0,
    trackId: "a-roll",
    playbackRate: 1,
  }],
};

const managed: TimelineElement = {
  id: "segment-1-dom",
  domId: "segment-1-dom",
  tag: "video",
  start: 0,
  duration: 4,
  track: 1,
  edlSegmentId: "segment-1",
  edlSourceStart: 2,
  edlSourceEnd: 6,
};

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
});

describe("useRazorSplit EDL routing", () => {
  it("routes a single split and blocks split-all in M1", async () => {
    const patchOperation = vi.fn(async (_operation: EditListOperation) => editListDocument);
    const showToast = vi.fn();
    let hook: ReturnType<typeof useRazorSplit> | null = null;

    function Harness() {
      hook = useRazorSplit({
        projectId: "demo",
        activeCompPath: "index.html",
        showToast,
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        editList: { document: editListDocument, patchOperation },
      });
      return null;
    }

    usePlayerStore.getState().setElements([managed]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Harness />));

    await act(async () => {
      await hook!.handleRazorSplit(managed, 1.5);
      await hook!.handleRazorSplitAll(1.5);
    });

    expect(patchOperation).toHaveBeenCalledOnce();
    expect(patchOperation).toHaveBeenCalledWith({
      type: "split",
      clipId: "segment-1",
      offset: 1.5,
    });
    expect(showToast).toHaveBeenCalledWith(
      "口播主轨暂不支持批量拆分，请逐个拆分。",
      "info",
    );
    act(() => root.unmount());
  });
});
