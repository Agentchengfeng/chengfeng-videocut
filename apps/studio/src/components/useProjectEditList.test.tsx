// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditListDocument } from "@video-workbench/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectEditList, type ProjectEditListState } from "./useProjectEditList";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const revision = "a".repeat(64);
const document: EditListDocument = {
  schemaVersion: 1,
  projectId: "demo",
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

function resourceResponse(
  nextDocument: EditListDocument = document,
  nextRevision = revision,
): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      projectId: "demo",
      exists: true,
      revision: nextRevision,
      document: nextDocument,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status = 500): Response {
  return new Response(
    JSON.stringify({ error: { code: "failed", message: "temporary failure" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function conflictResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "revision_conflict",
        message: "edit-list changed",
        details: { currentRevision: revision },
      },
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function renderHook(): {
  getState: () => ProjectEditListState;
  root: Root;
  container: HTMLDivElement;
} {
  const captured: { current: ProjectEditListState | null } = { current: null };
  function Probe() {
    captured.current = useProjectEditList("demo");
    return null;
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  return {
    getState: () => {
      if (!captured.current) throw new Error("Expected hook state");
      return captured.current;
    },
    root,
    container,
  };
}

beforeEach(() => {
  const listeners = new Set<(event: Event) => void>();
  class StubEventSource {
    addEventListener(type: string, listener: (event: Event) => void) {
      if (type === "file-change") listeners.add(listener);
    }
    removeEventListener(type: string, listener: (event: Event) => void) {
      if (type === "file-change") listeners.delete(listener);
    }
    close() {
      listeners.clear();
    }
  }
  Reflect.set(globalThis, "__editListFileChangeListeners", listeners);
  vi.stubGlobal("EventSource", StubEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.document.body.replaceChildren();
});

describe("useProjectEditList reload recovery", () => {
  it("clears an old error after a successful reload", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse())
      .mockResolvedValueOnce(resourceResponse());
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook();

    try {
      await act(flushAsyncWork);
      expect(rendered.getState().saveState).toBe("error");

      await act(async () => {
        await rendered.getState().reload();
      });

      expect(rendered.getState()).toMatchObject({
        saveState: "idle",
        ready: true,
        loading: false,
      });
    } finally {
      act(() => rendered.root.unmount());
      rendered.container.remove();
    }
  });

  it("clears an old conflict after the user reloads the current resource", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(resourceResponse())
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(resourceResponse())
      .mockResolvedValueOnce(resourceResponse());
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook();

    try {
      await act(flushAsyncWork);
      let rejection: unknown;
      await act(async () => {
        try {
          await rendered.getState().patchOperation({
            type: "delete",
            clipId: "a-roll-0001",
          });
        } catch (error) {
          rejection = error;
        }
      });
      expect(rejection).toMatchObject({ message: "edit-list changed" });
      expect(rendered.getState().saveState).toBe("conflict");

      await act(async () => {
        await rendered.getState().reload();
      });
      expect(rendered.getState().saveState).toBe("idle");
    } finally {
      act(() => rendered.root.unmount());
      rendered.container.remove();
    }
  });

  it("patches the edit list without owning a local undo history", async () => {
    const trimmed: EditListDocument = {
      ...document,
      duration: 8,
      segments: [{ ...document.segments[0], sourceStart: 1, sourceEnd: 9 }],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(resourceResponse(document, "b".repeat(64)))
      .mockResolvedValueOnce(resourceResponse(trimmed, "c".repeat(64)));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook();

    try {
      await act(flushAsyncWork);
      expect(rendered.getState().canUndo).toBe(false);

      await act(async () => {
        await rendered.getState().patchOperation({
          type: "trim",
          clipId: "a-roll-0001",
          sourceStart: 1,
          sourceEnd: 9,
        });
      });

      await act(async () => {
        await rendered.getState().undoLastEditListChange();
      });

      expect(rendered.getState().canUndo).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      act(() => rendered.root.unmount());
      rendered.container.remove();
    }
  });
});
