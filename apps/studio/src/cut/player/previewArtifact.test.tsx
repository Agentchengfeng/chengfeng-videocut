// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreviewArtifact, type PreviewArtifactState } from "./previewArtifact";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function Harness({
  editRevision,
  onValue,
}: {
  editRevision: string;
  onValue: (value: ReturnType<typeof usePreviewArtifact>) => void;
}) {
  const value = usePreviewArtifact("project-a", editRevision);
  useEffect(() => onValue(value), [onValue, value]);
  return (
    <button type="button" onClick={value.retry}>
      retry
    </button>
  );
}

function response(state: PreviewArtifactState): Response {
  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePreviewArtifact", () => {
  it("does not hot retry failed states and keeps retry POST one-shot", async () => {
    vi.useFakeTimers();
    const methods: string[] = [];
    const states: PreviewArtifactState[] = [
      { phase: "failed", editRevision: "r1", artifactRevision: null, source: null, error: "bad" },
      { phase: "generating", editRevision: "r1", artifactRevision: null, source: null, error: null },
      { phase: "current", editRevision: "r1", artifactRevision: "r1", source: "preview.mp4", error: null },
      { phase: "current", editRevision: "r2", artifactRevision: "r2", source: "preview-2.mp4", error: null },
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? "GET"));
      return response(states.shift()!);
    });
    vi.stubGlobal("fetch", fetchMock);
    let hook: ReturnType<typeof usePreviewArtifact> | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onValue = (value: ReturnType<typeof usePreviewArtifact>) => { hook = value; };

    await act(async () => root.render(<Harness editRevision="r1" onValue={onValue} />));
    await act(async () => { await Promise.resolve(); });
    expect(methods).toEqual(["GET"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(methods).toEqual(["GET"]);

    await act(async () => { hook!.retry(); });
    await act(async () => { await Promise.resolve(); });
    expect(methods).toEqual(["GET", "POST"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(methods).toEqual(["GET", "POST", "GET"]);

    await act(async () => root.render(<Harness editRevision="r2" onValue={onValue} />));
    await act(async () => { await Promise.resolve(); });
    expect(methods).toEqual(["GET", "POST", "GET", "GET"]);

    act(() => root.unmount());
  });

  it("drops a retry token when the edit revision changes in the same batch", async () => {
    const methods: string[] = [];
    const states: PreviewArtifactState[] = [
      { phase: "failed", editRevision: "r1", artifactRevision: null, source: null, error: "bad" },
      { phase: "current", editRevision: "r2", artifactRevision: "r2", source: "preview-2.mp4", error: null },
      { phase: "current", editRevision: "r1", artifactRevision: "r1", source: "preview-1.mp4", error: null },
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? "GET"));
      return response(states.shift()!);
    }));
    let hook: ReturnType<typeof usePreviewArtifact> | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onValue = (value: ReturnType<typeof usePreviewArtifact>) => { hook = value; };

    await act(async () => root.render(<Harness editRevision="r1" onValue={onValue} />));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      hook!.retry();
      root.render(<Harness editRevision="r2" onValue={onValue} />);
    });
    await act(async () => { await Promise.resolve(); });

    expect(methods).toEqual(["GET", "GET"]);
    await act(async () => root.render(<Harness editRevision="r1" onValue={onValue} />));
    await act(async () => { await Promise.resolve(); });

    expect(methods).toEqual(["GET", "GET", "GET"]);
    act(() => root.unmount());
  });
  it("recovers on its own when a request fails and the next one succeeds", async () => {
    // A 58ms blip right after an edit used to disable the player until the page was
    // reloaded: the request threw, the hook reported failure and stopped asking, and
    // the service — which had already recovered — was never asked again.
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return response({
        phase: "current", editRevision: "r1", artifactRevision: "r1",
        source: "preview.mp4", error: null,
      });
    }));
    let hook: ReturnType<typeof usePreviewArtifact> | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(
      <Harness editRevision="r1" onValue={(value) => { hook = value; }} />,
    ));
    await act(async () => { await Promise.resolve(); });
    // One failure is a blip, not a verdict: nothing is reported to the player yet.
    expect(hook!.state.phase).not.toBe("failed");

    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(calls).toBeGreaterThan(1);
    expect(hook!.state.phase).toBe("current");
    expect(hook!.current).toBe(true);

    root.unmount();
    host.remove();
    vi.useRealTimers();
  });

});

