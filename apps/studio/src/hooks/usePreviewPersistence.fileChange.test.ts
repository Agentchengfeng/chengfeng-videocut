import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStudioFileReloadScheduler,
  shouldReloadForStudioFileChange,
} from "./usePreviewPersistence";

afterEach(() => {
  vi.useRealTimers();
});

function refs(input: {
  pending?: string[];
  lastStudioSaveAt?: number;
} = {}) {
  return {
    pending: { current: new Set(input.pending ?? []) },
    save: { current: input.lastStudioSaveAt ?? 0 },
  };
}

function fileChange(projectId: string, path: string): MessageEvent {
  return new MessageEvent("file-change", {
    data: JSON.stringify({ projectId, path }),
  });
}

describe("shouldReloadForStudioFileChange", () => {
  it("reloads the materialized composition for the active project", () => {
    const state = refs();
    expect(shouldReloadForStudioFileChange(
      fileChange("project-a", "/tmp/project-a/index.html"),
      state.pending,
      state.save,
      "project-a",
    )).toBe(true);
  });

  it.each(["cut-selection.json", "edit-list.json"])(
    "ignores product metadata %s because index.html carries the visual change",
    (path) => {
      const state = refs();
      expect(shouldReloadForStudioFileChange(
        fileChange("project-a", `/tmp/project-a/${path}`),
        state.pending,
        state.save,
        "project-a",
      )).toBe(false);
    },
  );

  it("ignores file changes from another project", () => {
    const state = refs();
    expect(shouldReloadForStudioFileChange(
      fileChange("project-b", "/tmp/project-b/index.html"),
      state.pending,
      state.save,
      "project-a",
    )).toBe(false);
  });

  it("still suppresses Studio's own pending write echo", () => {
    const path = "index.html";
    const state = refs({ pending: [path] });
    expect(shouldReloadForStudioFileChange(
      fileChange("project-a", path),
      state.pending,
      state.save,
      "project-a",
    )).toBe(false);
    expect(state.pending.current.has(path)).toBe(false);
  });

  it("still suppresses changes during the Studio self-save window", () => {
    const state = refs({ lastStudioSaveAt: Date.now() });
    expect(shouldReloadForStudioFileChange(
      fileChange("project-a", "/tmp/project-a/index.html"),
      state.pending,
      state.save,
      "project-a",
    )).toBe(false);
  });
});

describe("createStudioFileReloadScheduler", () => {
  it("turns one Cuts write burst into one materialized-composition reload", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T08:00:00Z"));
    const reload = vi.fn();
    const scheduler = createStudioFileReloadScheduler(reload, 120);
    const state = refs();
    const report = (path: string) => {
      if (
        shouldReloadForStudioFileChange(
          fileChange("project-a", `/tmp/project-a/${path}`),
          state.pending,
          state.save,
          "project-a",
        )
      ) {
        scheduler.schedule();
      }
    };

    // A Cuts PUT writes both product documents, then index.html is reported by
    // the product API and the native watcher. Only the final rendering artifact
    // is reload-worthy, and its duplicate reports must collapse to one refresh.
    report("cut-selection.json");
    report("edit-list.json");
    report("index.html");
    vi.advanceTimersByTime(20);
    report("index.html");

    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate watcher events into one reload", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const scheduler = createStudioFileReloadScheduler(reload, 120);

    scheduler.schedule();
    vi.advanceTimersByTime(60);
    scheduler.schedule();
    vi.advanceTimersByTime(119);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest rapid edit by moving the reload to the trailing edge", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const scheduler = createStudioFileReloadScheduler(reload, 120);

    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    vi.advanceTimersByTime(120);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
