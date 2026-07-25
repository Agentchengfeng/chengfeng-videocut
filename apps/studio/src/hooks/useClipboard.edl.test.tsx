// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore, type TimelineElement } from "../player";
import { isEditListManagedClipboardHtml, useClipboard } from "./useClipboard";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  usePlayerStore.getState().reset();
  document.body.replaceChildren();
});

describe("useClipboard managed A-roll guard", () => {
  it("blocks copy and cut before a managed segment can become a DOM payload", async () => {
    const managed: TimelineElement = {
      id: "managed",
      domId: "managed",
      tag: "video",
      start: 0,
      duration: 2,
      track: 0,
      edlSegmentId: "segment-1",
    };
    usePlayerStore.getState().setElements([managed]);
    usePlayerStore.getState().setSelectedElementId("managed");
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    if (!iframe.contentDocument) throw new Error("Expected iframe document");
    iframe.contentDocument.body.innerHTML = '<video id="managed"></video>';

    const captured: { current: ReturnType<typeof useClipboard> | null } = { current: null };
    const showToast = vi.fn();
    const handleTimelineElementDelete = vi.fn(async () => {});
    const handleDomEditElementDelete = vi.fn(async () => {});
    function Probe() {
      captured.current = useClipboard({
        projectId: "demo",
        activeCompPath: "index.html",
        domEditSelectionRef: { current: null },
        showToast,
        writeProjectFile: vi.fn(async () => {}),
        recordEdit: vi.fn(async () => {}),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        handleTimelineElementDelete,
        handleDomEditElementDelete,
        previewIframeRef: { current: iframe },
      });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Probe)));

    try {
      expect(captured.current?.handleCopy()).toBe(false);
      await act(async () => {
        expect(await captured.current?.handleCut()).toBe(false);
      });
      expect(handleTimelineElementDelete).not.toHaveBeenCalled();
      expect(handleDomEditElementDelete).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining("剪口播时间线管理"), "info");
    } finally {
      act(() => root.unmount());
    }
  });

  it("recognizes stale managed payloads so paste cannot duplicate A-roll", () => {
    expect(
      isEditListManagedClipboardHtml('<video data-edl-segment-id="segment-1"></video>'),
    ).toBe(true);
    expect(isEditListManagedClipboardHtml("<video></video>")).toBe(false);
  });
});
