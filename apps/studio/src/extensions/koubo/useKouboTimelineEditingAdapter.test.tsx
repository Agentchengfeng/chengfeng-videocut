// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditListDocument, EditListOperation } from "@video-workbench/core";
import type { TimelineElement } from "../../player";

const patchOperation = vi.hoisted(() =>
  vi.fn(async (_operation: EditListOperation): Promise<EditListDocument> => ({
    schemaVersion: 1,
    projectId: "demo",
    sourceDuration: 10,
    baseCutsRevision: "a".repeat(64),
    baseTranscriptRevision: "b".repeat(64),
    mode: "manual",
    duration: 4,
    segments: [],
  })),
);

vi.mock("../../components/useProjectEditList", () => ({
  useProjectEditList: () => ({ patchOperation }),
}));

import { useKouboTimelineEditingAdapter } from "./useKouboTimelineEditingAdapter";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const managed: TimelineElement = {
  id: "segment-dom",
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

afterEach(() => {
  document.body.replaceChildren();
  patchOperation.mockClear();
});

describe("useKouboTimelineEditingAdapter", () => {
  it("translates official Studio gestures into the four CAS EDL operations", async () => {
    let adapter: ReturnType<typeof useKouboTimelineEditingAdapter> = null;
    function Probe() {
      adapter = useKouboTimelineEditingAdapter("demo");
      return null;
    }

    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Probe />));

    await act(async () => {
      await adapter!.move(managed, { start: 1.5, track: 1 });
      await adapter!.resize(managed, { start: 1, duration: 3, playbackStart: 3 });
      await adapter!.split(managed, 2);
      await adapter!.delete(managed);
    });

    expect(patchOperation.mock.calls.map(([operation]) => operation)).toEqual([
      { type: "move", clipId: "segment-1", start: 1.5 },
      { type: "trim", clipId: "segment-1", sourceStart: 3, sourceEnd: 6 },
      { type: "split", clipId: "segment-1", offset: 2 },
      { type: "delete", clipId: "segment-1" },
    ]);
    expect(adapter!.blockClipboard).toBe(true);

    act(() => root.unmount());
  });
});
