// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditListDocument } from "@video-workbench/core";
import { useContinuousVideoTransport } from "./useContinuousVideoTransport";
import type { EdlVideoTransport } from "./useEdlVideoTransport";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const documentFixture: EditListDocument = {
  schemaVersion: 1,
  projectId: "continuous-transport-fixture",
  sourceDuration: 20,
  baseCutsRevision: "a".repeat(64),
  baseTranscriptRevision: "b".repeat(64),
  mode: "manual",
  duration: 20,
  segments: [
    {
      id: "whole",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 20,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

function Harness({
  document = documentFixture,
  sourceUrl = "/preview-edited.mp4",
  onValue,
}: {
  document?: EditListDocument | null;
  sourceUrl?: string | null;
  onValue: (value: EdlVideoTransport) => void;
}) {
  const value = useContinuousVideoTransport({
    document,
    revision: "c".repeat(64),
    sourceUrl,
    initialTimelineTime: 9.996,
  });
  useEffect(() => onValue(value), [onValue, value]);
  return sourceUrl ? <video key={sourceUrl} ref={value.videoRef} src={sourceUrl} /> : null;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useContinuousVideoTransport ownership", () => {
  it("owns the initial media seek, exact pause snapshot, and loop state", () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness onValue={(value) => { transport = value; }} />));
    const video = host.querySelector("video")!;
    let currentTime = 0;
    let paused = true;
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      play: { configurable: true, value: vi.fn(async () => { paused = false; }) },
    });

    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(currentTime).toBeCloseTo(9.996, 3);
    expect(transport!.timelineTime).toBeCloseTo(9.996, 3);

    currentTime = 12.25;
    paused = false;
    act(() => transport!.pause());
    expect(transport!.timelineTime).toBeCloseTo(12.25, 3);
    expect(paused).toBe(true);

    act(() => transport!.toggleLoop());
    expect(transport!.loopEnabled).toBe(true);
    expect(video.loop).toBe(true);

    act(() => root.unmount());
  });

  it("does not erase a deep-link target when media becomes ready before the EditList", () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onValue = (value: EdlVideoTransport) => { transport = value; };

    act(() => root.render(<Harness document={null} onValue={onValue} />));
    const video = host.querySelector("video")!;
    let currentTime = 0;
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => true },
      pause: { configurable: true, value: vi.fn() },
      play: { configurable: true, value: vi.fn(async () => undefined) },
    });

    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(currentTime).toBe(0);
    expect(transport!.timelineTime).toBeCloseTo(9.996, 3);

    act(() => root.render(<Harness document={documentFixture} onValue={onValue} />));
    expect(currentTime).toBeCloseTo(9.996, 3);
    expect(transport!.timelineTime).toBeCloseTo(9.996, 3);

    act(() => root.unmount());
  });

  it("waits for remounted media readiness before restoring play intent", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness sourceUrl={null} onValue={(value) => { transport = value; }} />));
    await act(async () => { await transport!.restoreIntent(7, true); });

    act(() => root.render(<Harness sourceUrl="/next-preview.mp4" onValue={(value) => { transport = value; }} />));
    const video = host.querySelector("video")!;
    let currentTime = 0;
    let paused = true;
    let readyState = 0;
    const play = vi.fn(async () => { paused = false; });
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => readyState },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      play: { configurable: true, value: play },
    });

    expect(currentTime).toBe(0);
    expect(play).not.toHaveBeenCalled();

    readyState = 1;
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("seeked"));
      await Promise.resolve();
    });

    expect(currentTime).toBeCloseTo(7, 3);
    expect(play).toHaveBeenCalledTimes(1);
    expect(paused).toBe(false);

    act(() => root.unmount());
  });

  it("toggles desired play intent without a mounted video during preview generation", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness sourceUrl={null} onValue={(value) => { transport = value; }} />));

    await act(async () => { await transport!.togglePlay(); });
    expect(transport!.desiredPlaying).toBe(true);
    expect(transport!.isPlaying).toBe(false);

    await act(async () => { await transport!.togglePlay(); });
    expect(transport!.desiredPlaying).toBe(false);
    expect(transport!.isPlaying).toBe(false);

    await act(async () => { await transport!.togglePlay(); });
    expect(transport!.desiredPlaying).toBe(true);

    act(() => root.unmount());
  });

  it("keeps paused restore intent and replays media controls after source replacement", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onValue = (value: EdlVideoTransport) => { transport = value; };

    act(() => root.render(<Harness sourceUrl="/one.mp4" onValue={onValue} />));
    let first = host.querySelector("video")!;
    Object.defineProperties(first, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: { configurable: true, get: () => 0, set: () => undefined },
      paused: { configurable: true, get: () => true },
      pause: { configurable: true, value: vi.fn() },
      play: { configurable: true, value: vi.fn(async () => undefined) },
    });
    act(() => {
      transport!.setPlaybackRate(1.5);
      transport!.setVolume(0.4);
      transport!.toggleMuted();
      transport!.toggleLoop();
    });

    act(() => root.render(<Harness sourceUrl={null} onValue={onValue} />));
    await act(async () => { await transport!.restoreIntent(4, false); });
    act(() => root.render(<Harness sourceUrl="/two.mp4" onValue={onValue} />));
    const second = host.querySelector("video")!;
    let currentTime = 0;
    let paused = true;
    const pause = vi.fn(() => { paused = true; });
    const play = vi.fn(async () => { paused = false; });
    Object.defineProperties(second, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: pause },
      play: { configurable: true, value: play },
    });

    await act(async () => {
      second.dispatchEvent(new Event("loadedmetadata"));
      second.dispatchEvent(new Event("seeked"));
      await Promise.resolve();
    });

    expect(second.playbackRate).toBe(1.5);
    expect(second.volume).toBeCloseTo(0.4, 3);
    expect(second.muted).toBe(true);
    expect(second.loop).toBe(true);
    expect(currentTime).toBeCloseTo(4, 3);
    expect(play).not.toHaveBeenCalled();
    expect(paused).toBe(true);

    act(() => root.unmount());
  });

  it("does not pause playback when changing playback controls", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onValue = (value: EdlVideoTransport) => { transport = value; };

    act(() => root.render(<Harness sourceUrl="/controls.mp4" onValue={onValue} />));
    const video = host.querySelector("video")!;
    let currentTime = 3;
    let paused = false;
    const pause = vi.fn(() => { paused = true; });
    const play = vi.fn(async () => { paused = false; });
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: pause },
      play: { configurable: true, value: play },
    });
    act(() => video.dispatchEvent(new Event("loadedmetadata")));

    act(() => {
      transport!.setPlaybackRate(1.5);
      transport!.setVolume(0.5);
      transport!.toggleMuted();
      transport!.toggleLoop();
    });

    expect(paused).toBe(false);
    expect(pause).not.toHaveBeenCalled();
    expect(video.playbackRate).toBe(1.5);
    expect(video.volume).toBeCloseTo(0.5, 3);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);

    act(() => root.unmount());
  });

  it("consumes pending restore once when loadedmetadata and canplay both fire", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness sourceUrl={null} onValue={(value) => { transport = value; }} />));
    await act(async () => { await transport!.restoreIntent(8, true); });
    act(() => root.render(<Harness sourceUrl="/double-ready.mp4" onValue={(value) => { transport = value; }} />));
    const video = host.querySelector("video")!;
    let currentTime = 0;
    let paused = true;
    const play = vi.fn(async () => { paused = false; });
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      play: { configurable: true, value: play },
    });

    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("canplay"));
      video.dispatchEvent(new Event("seeked"));
      await Promise.resolve();
    });

    expect(currentTime).toBeCloseTo(8, 3);
    expect(play).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("captures play rejection during pending restore without retrying forever", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness sourceUrl="/reject.mp4" onValue={(value) => { transport = value; }} />));
    const video = host.querySelector("video")!;
    let currentTime = 0;
    const play = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); });
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => true },
      pause: { configurable: true, value: vi.fn() },
      play: { configurable: true, value: play },
    });

    await act(async () => {
      await transport!.restoreIntent(5, true);
      video.dispatchEvent(new Event("seeked"));
      await Promise.resolve();
    });

    expect(currentTime).toBeCloseTo(5, 3);
    expect(play).toHaveBeenCalledTimes(1);
    expect(transport!.error).toBe("媒体播放失败");

    await act(async () => {
      video.dispatchEvent(new Event("canplay"));
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("resumes only the latest click after its matching seeked event", async () => {
    let transport: EdlVideoTransport | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness onValue={(value) => { transport = value; }} />));
    const video = host.querySelector("video")!;
    let currentTime = 0;
    let paused = true;
    const play = vi.fn(async () => { paused = false; });
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 1 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      play: { configurable: true, value: play },
    });

    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    await act(async () => {
      await transport!.seek(4, { keepPlaying: true });
      await transport!.seek(9, { keepPlaying: true });
    });

    expect(currentTime).toBeCloseTo(9, 3);
    expect(play).not.toHaveBeenCalled();

    currentTime = 4;
    await act(async () => {
      video.dispatchEvent(new Event("seeked"));
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();

    currentTime = 9;
    await act(async () => {
      video.dispatchEvent(new Event("seeked"));
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(paused).toBe(false);

    act(() => root.unmount());
  });
});
