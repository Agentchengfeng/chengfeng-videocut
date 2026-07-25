// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectCutSelection: vi.fn(),
  putProjectCutSelection: vi.fn(),
  fileChangeHandlers: [] as Array<(payload: unknown) => void>,
  subscribeProjectFileChanges: vi.fn((handler: (payload: unknown) => void) => {
    mocks.fileChangeHandlers.push(handler);
    return () => undefined;
  }),
}));

vi.mock("./cutSelectionApi", () => ({
  CutSelectionApiError: class CutSelectionApiError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;

    constructor(
      message: string,
      options: { status: number; code?: string; details?: Record<string, unknown> },
    ) {
      super(message);
      this.name = "CutSelectionApiError";
      this.status = options.status;
      this.code = options.code ?? "cuts_api_error";
      this.details = options.details;
    }
  },
  getProjectCutSelection: mocks.getProjectCutSelection,
  putProjectCutSelection: mocks.putProjectCutSelection,
}));

vi.mock("../product/projectEvents", () => ({
  subscribeProjectFileChanges: mocks.subscribeProjectFileChanges,
}));

import {
  shouldSyncCutSelectionAfterFileChange,
  useProjectCutSelection,
} from "./useProjectCutSelection";
import type { TranscriptCue } from "./kouboTranscript";

const OWN_CUT_CHANGE = {
  data: JSON.stringify({ projectId: "demo", path: "cut-selection.json" }),
};

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const cues: TranscriptCue[] = [{
  id: "cue-1",
  start: 0,
  end: 2,
  words: [
    { id: "w1", text: "一", start: 0, end: 1, isGap: false },
    { id: "w2", text: "二", start: 1, end: 2, isGap: false },
  ],
}];

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.replaceChildren();
  mocks.getProjectCutSelection.mockReset();
  mocks.putProjectCutSelection.mockReset();
  mocks.subscribeProjectFileChanges.mockClear();
  mocks.fileChangeHandlers = [];
});

describe("shouldSyncCutSelectionAfterFileChange", () => {
  it("ignores the file watcher event emitted by an in-flight optimistic save", () => {
    expect(
      shouldSyncCutSelectionAfterFileChange(OWN_CUT_CHANGE, "demo", 1),
    ).toBe(false);
  });

  it("silently syncs a late or external cut-selection change", () => {
    expect(
      shouldSyncCutSelectionAfterFileChange(OWN_CUT_CHANGE, "demo", 0),
    ).toBe(true);
  });

  it("ignores changes from another project or another file", () => {
    expect(
      shouldSyncCutSelectionAfterFileChange(OWN_CUT_CHANGE, "other", 0),
    ).toBe(false);
    expect(
      shouldSyncCutSelectionAfterFileChange(
        { data: JSON.stringify({ projectId: "demo", path: "transcript.json" }) },
        "demo",
        0,
      ),
    ).toBe(false);
  });
});

describe("useProjectCutSelection save ownership", () => {
  it("saves cut selection changes without owning a local undo history", async () => {
    let rendered: ReturnType<typeof useProjectCutSelection> | null = null;
    mocks.getProjectCutSelection
      .mockResolvedValueOnce({
        schemaVersion: 1,
        projectId: "demo",
        exists: true,
        revision: "r0",
        document: { cutWordIds: [] },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        projectId: "demo",
        exists: true,
        revision: "r1",
        document: { cutWordIds: ["w1"] },
      });
    mocks.putProjectCutSelection
      .mockResolvedValueOnce({
        schemaVersion: 1,
        projectId: "demo",
        exists: true,
        revision: "r1",
        document: { cutWordIds: ["w1"] },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        projectId: "demo",
        exists: true,
        revision: "r2",
        document: { cutWordIds: [] },
      });

    function Harness() {
      rendered = useProjectCutSelection("demo", cues);
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Harness));
      await flushAsync();
    });

    expect(rendered?.selectionReady).toBe(true);
    expect(rendered?.canUndo).toBe(false);

    await act(async () => {
      await rendered?.updateCutWordIds(new Set(["w1"]));
    });

    expect(mocks.putProjectCutSelection).toHaveBeenNthCalledWith(1, "demo", "r0", ["w1"]);
    expect([...rendered?.cutWordIds ?? []]).toEqual(["w1"]);
    expect(rendered?.canUndo).toBe(false);

    await act(async () => {
      mocks.fileChangeHandlers.at(-1)?.(OWN_CUT_CHANGE);
      await flushAsync();
    });
    expect(rendered?.canUndo).toBe(false);

    await act(async () => {
      rendered?.undoLastCutChange();
    });

    expect(mocks.putProjectCutSelection).toHaveBeenCalledTimes(1);
    expect([...rendered?.cutWordIds ?? []]).toEqual(["w1"]);
    expect(rendered?.canUndo).toBe(false);

    act(() => root.unmount());
  });
});
