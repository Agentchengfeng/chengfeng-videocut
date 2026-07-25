// @vitest-environment happy-dom

import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTimelinePlayer } from "./useTimelinePlayer";
import { liveTime, usePlayerStore } from "../store/playerStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function resetPlayerStore() {
  usePlayerStore.getState().reset();
  usePlayerStore.setState({ requestedSeekTime: null });
}

function TimelinePlayerHarness({
  onValue,
}: {
  onValue: (value: ReturnType<typeof useTimelinePlayer>) => void;
}) {
  const value = useTimelinePlayer();
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

function renderTimelinePlayerHarness() {
  let api: ReturnType<typeof useTimelinePlayer> | null = null;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(React.createElement(TimelinePlayerHarness, { onValue: (value) => (api = value) }));
  });

  if (!api) throw new Error("useTimelinePlayer did not mount");
  return { api, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  resetPlayerStore();
});

function attachIframeAdapter(
  api: ReturnType<typeof useTimelinePlayer>,
  options: {
    postMessage?: (message: unknown, targetOrigin: string) => void;
    timelines?: Record<string, unknown>;
    duration?: number;
  } = {},
) {
  const iframe = document.createElement("iframe");
  let currentTime = 0;
  let playing = false;
  const adapter = {
    play: vi.fn(() => {
      playing = true;
    }),
    pause: vi.fn(() => {
      playing = false;
    }),
    seek: vi.fn((time: number) => {
      currentTime = time;
    }),
    getTime: () => currentTime,
    getDuration: () => options.duration ?? 30,
    isPlaying: () => playing,
  };
  Object.defineProperty(iframe, "contentWindow", {
    value: {
      __player: adapter,
      __timelines: options.timelines,
      postMessage: options.postMessage ?? (() => {}),
      scrollTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    configurable: true,
  });
  Object.defineProperty(iframe, "contentDocument", {
    value: document.implementation.createHTMLDocument("preview"),
    configurable: true,
  });
  act(() => {
    api.iframeRef.current = iframe;
    api.onIframeLoad();
  });
  return adapter;
}

function replaceIframeDocument(api: ReturnType<typeof useTimelinePlayer>) {
  Object.defineProperty(api.iframeRef.current!, "contentDocument", {
    value: document.implementation.createHTMLDocument("refreshed-preview"),
    configurable: true,
  });
}

function renderAttachedTimelinePlayer() {
  const { api, root } = renderTimelinePlayerHarness();
  const adapter = attachIframeAdapter(api);
  return { api, root, adapter };
}

function setStorePlaying() {
  act(() => {
    usePlayerStore.setState({ isPlaying: true });
  });
}

function seekWithAct(
  api: ReturnType<typeof useTimelinePlayer>,
  time: number,
  options?: { keepPlaying?: boolean },
) {
  act(() => {
    api.seek(time, options);
  });
}

function unmountWithAct(root: ReturnType<typeof createRoot>) {
  act(() => {
    root.unmount();
  });
}

function expectStorePlaybackState(
  root: ReturnType<typeof createRoot>,
  expected: { isPlaying: boolean; currentTime: number },
) {
  expect(usePlayerStore.getState().isPlaying).toBe(expected.isPlaying);
  expect(usePlayerStore.getState().currentTime).toBe(expected.currentTime);
  unmountWithAct(root);
}

describe("useTimelinePlayer seek hydration", () => {
  it("starts product EDL audio in the parent Play call stack", async () => {
    const { api, root } = renderAttachedTimelinePlayer();
    const audio = document.createElement("audio");
    const playAudio = vi.fn(() => Promise.resolve());
    audio.play = playAudio;
    audio.id = "videocut-edl-audio-success";
    document.body.append(audio);
    api.iframeRef.current!.setAttribute("data-videocut-edl-audio-id", audio.id);

    act(() => {
      api.play();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(playAudio).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    unmountWithAct(root);
  });

  it("fails the Studio transport closed when parent EDL audio cannot start", async () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    const audio = document.createElement("audio");
    audio.play = vi.fn(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
    audio.id = "videocut-edl-audio-blocked";
    document.body.append(audio);
    api.iframeRef.current!.setAttribute("data-videocut-edl-audio-id", audio.id);

    act(() => {
      api.play();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(adapter.pause).toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it.each([
    "videocut-audio-gesture-required",
    "videocut-media-play-error",
  ])("returns Studio transport to Play when %s fails closed", (type) => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();

    act(() => {
      api.play();
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    const source = api.iframeRef.current?.contentWindow ?? null;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: "chengfeng-videocut", type },
        source,
      }));
    });

    expect(adapter.pause).toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it("keeps an external seek request until the iframe adapter is ready", () => {
    const observedTimes: number[] = [];
    const unsubscribe = liveTime.subscribe((time) => {
      observedTimes.push(time);
    });
    const { api, root } = renderTimelinePlayerHarness();

    act(() => {
      usePlayerStore.getState().requestSeek(4.2);
    });

    expect(usePlayerStore.getState().currentTime).toBe(0);
    expect(usePlayerStore.getState().requestedSeekTime).toBeNull();

    const adapter = attachIframeAdapter(api);

    expect(adapter.getTime()).toBe(4.2);
    expect(usePlayerStore.getState().currentTime).toBe(4.2);
    expect(usePlayerStore.getState().timelineReady).toBe(true);
    expect(observedTimes).toContain(4.2);

    unmountWithAct(root);
    unsubscribe();
  });

  it("does not turn a paused transport into playback when keepPlaying waits for an adapter", () => {
    const { api, root } = renderTimelinePlayerHarness();

    act(() => {
      usePlayerStore.getState().requestSeek(4.2, { keepPlaying: true });
    });
    const adapter = attachIframeAdapter(api);

    expect(adapter.getTime()).toBe(4.2);
    expect(adapter.play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it("consumes a same-time external request when only its options changed", () => {
    const { root, adapter } = renderAttachedTimelinePlayer();

    act(() => {
      usePlayerStore.getState().requestSeek(4.2);
      usePlayerStore.getState().requestSeek(4.2, { keepPlaying: true });
    });

    expect(adapter.seek).toHaveBeenCalledTimes(4);
    expect(usePlayerStore.getState().requestedSeekTime).toBeNull();
    unmountWithAct(root);
  });

  it("prefers an explicit Studio extension transport over document duration reconciliation", () => {
    const { api, root } = renderTimelinePlayerHarness();
    const iframe = document.createElement("iframe");
    const baseAdapter = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 659.711,
      isPlaying: () => false,
    };
    const extensionAdapter = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 242.94,
      isPlaying: () => false,
    };
    Object.defineProperty(iframe, "contentWindow", {
      value: {
        __player: baseAdapter,
        __studioPlaybackAdapter: extensionAdapter,
        postMessage: vi.fn(),
        scrollTo: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    const previewDocument = document.implementation.createHTMLDocument("preview");
    const composition = previewDocument.createElement("main");
    composition.setAttribute("data-composition-id", "root");
    composition.setAttribute("data-duration", "659.711");
    previewDocument.body.append(composition);
    Object.defineProperty(iframe, "contentDocument", {
      value: previewDocument,
      configurable: true,
    });

    act(() => {
      api.iframeRef.current = iframe;
      api.onIframeLoad();
      api.play();
    });

    expect(extensionAdapter.play).toHaveBeenCalledTimes(1);
    expect(baseAdapter.play).not.toHaveBeenCalled();
    unmountWithAct(root);
  });

  it("does not settle from an unsupported runtime protocol message", () => {
    const { api, root } = renderTimelinePlayerHarness();
    const iframe = document.createElement("iframe");
    const iframeWindow = {
      postMessage: vi.fn(),
      scrollTo: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as Record<string, unknown>;
    Object.defineProperty(iframe, "contentWindow", {
      value: iframeWindow,
      configurable: true,
    });
    Object.defineProperty(iframe, "contentDocument", {
      value: document.implementation.createHTMLDocument("preview"),
      configurable: true,
    });

    act(() => {
      api.iframeRef.current = iframe;
      api.onIframeLoad();
    });
    expect(usePlayerStore.getState().timelineReady).toBe(false);

    iframeWindow.__player = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 30,
      isPlaying: () => false,
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow as unknown as Window,
          data: { source: "hf-preview", type: "state", protocolVersion: 999 },
        }),
      );
    });
    expect(usePlayerStore.getState().timelineReady).toBe(false);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow as unknown as Window,
          data: { source: "hf-preview", type: "state" },
        }),
      );
    });
    expect(usePlayerStore.getState().timelineReady).toBe(true);

    unmountWithAct(root);
  });
});

describe("useTimelinePlayer audio controls (#835)", () => {
  it("applies playback-rate changes immediately without muting preview audio", () => {
    const { api, root } = renderTimelinePlayerHarness();
    const postMessage = vi.fn();
    const timeScale = vi.fn();

    attachIframeAdapter(api, {
      postMessage,
      timelines: {
        root: { timeScale },
      },
    });
    postMessage.mockClear();
    timeScale.mockClear();

    act(() => {
      usePlayerStore.getState().setAudioMuted(false);
      usePlayerStore.getState().setPlaybackRate(2);
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "hf-parent",
        type: "control",
        action: "set-playback-rate",
        playbackRate: 2,
      }),
      "*",
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "hf-parent",
        type: "control",
        action: "set-muted",
        muted: false,
      }),
      "*",
    );
    expect(timeScale).toHaveBeenCalledWith(2);

    postMessage.mockClear();

    act(() => {
      usePlayerStore.getState().setPlaybackRate(1);
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set-muted",
        muted: false,
      }),
      "*",
    );

    unmountWithAct(root);
  });

  it("keeps explicit Studio mute active at 1x", () => {
    const { api, root } = renderTimelinePlayerHarness();
    const postMessage = vi.fn();

    attachIframeAdapter(api, { postMessage });
    postMessage.mockClear();

    act(() => {
      usePlayerStore.getState().setPlaybackRate(1);
      usePlayerStore.getState().setAudioMuted(true);
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set-muted",
        muted: true,
      }),
      "*",
    );

    unmountWithAct(root);
  });
});

describe("useTimelinePlayer seek keepPlaying option (#834)", () => {
  it("default seek() clears isPlaying when the store reports playing", () => {
    const { api, root } = renderAttachedTimelinePlayer();
    setStorePlaying();

    seekWithAct(api, 5);

    expectStorePlaybackState(root, { isPlaying: false, currentTime: 5 });
  });

  it("seek(time, { keepPlaying: true }) preserves isPlaying=true so A/E shortcuts don't pause the timeline", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    setStorePlaying();

    seekWithAct(api, 5, { keepPlaying: true });

    expect(adapter.play).toHaveBeenCalledTimes(1);
    expectStorePlaybackState(root, { isPlaying: true, currentTime: 5 });
  });

  it("seek(time, { keepPlaying: true }) from paused state stays paused (no spurious resume)", () => {
    const { api, root } = renderAttachedTimelinePlayer();

    expect(usePlayerStore.getState().isPlaying).toBe(false);

    seekWithAct(api, 5, { keepPlaying: true });

    expectStorePlaybackState(root, { isPlaying: false, currentTime: 5 });
  });

  it("seek(time, { keepPlaying: true }) restarts playback when the iframe adapter was paused", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    setStorePlaying();

    expect(adapter.isPlaying()).toBe(false);

    seekWithAct(api, 0, { keepPlaying: true });

    expect(adapter.play).toHaveBeenCalledTimes(1);
    expect(adapter.isPlaying()).toBe(true);
    expectStorePlaybackState(root, { isPlaying: true, currentTime: 0 });
  });
});

describe("useTimelinePlayer refresh playback continuity", () => {
  it("keeps playing across the actual iframe refresh used by a materialized Cuts index", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(6);
      api.refreshPlayer();
    });

    // The public store is paused only while the old document is being replaced.
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    act(() => {
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(6);
    expect(adapter.play).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    unmountWithAct(root);
  });

  it("uses a keep-playing seek requested while refresh is in flight", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(8);
      api.saveSeekPosition();
      usePlayerStore.getState().requestSeek(3, { keepPlaying: true });
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(3);
    expect(adapter.play).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    unmountWithAct(root);
  });

  it("resumes a running transport after the refreshed iframe is ready", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(6);
      api.saveSeekPosition();
      adapter.pause();
      replaceIframeDocument(api);
    });

    expect(usePlayerStore.getState().isPlaying).toBe(false);

    act(() => {
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(6);
    expect(adapter.play).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    unmountWithAct(root);
  });

  it("does not start a paused transport after refresh", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      adapter.seek(4);
      api.saveSeekPosition();
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(4);
    expect(adapter.play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it("does not treat keepPlaying during refresh as permission to start a paused transport", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      adapter.seek(4);
      api.saveSeekPosition();
      usePlayerStore.getState().requestSeek(3, { keepPlaying: true });
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(3);
    expect(adapter.play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it("keeps the original resume intent across overlapping refreshes", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(8);
      api.saveSeekPosition();
      adapter.pause();
      api.saveSeekPosition();
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(8);
    expect(adapter.play).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    unmountWithAct(root);
  });

  it("initializes a refreshed document only once when load fires twice", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(8);
      api.saveSeekPosition();
      adapter.pause();
      replaceIframeDocument(api);
      api.onIframeLoad();
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(8);
    expect(adapter.play).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    unmountWithAct(root);
  });

  it("does not resume when the restored playhead is at the new end", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(30);
      api.saveSeekPosition();
      adapter.pause();
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(30);
    expect(adapter.play).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it("clears a pending resume and seek when the player resets for another project", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    act(() => {
      api.play();
      adapter.seek(8);
      api.saveSeekPosition();
      api.resetPlayer();
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(0);
    expect(adapter.play).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    unmountWithAct(root);
  });

  it("does not resume in the background when the page hides during refresh", () => {
    const { api, root, adapter } = renderAttachedTimelinePlayer();
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    act(() => {
      api.play();
      adapter.seek(8);
      api.saveSeekPosition();
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      replaceIframeDocument(api);
      api.onIframeLoad();
    });

    expect(adapter.getTime()).toBe(8);
    expect(adapter.play).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    unmountWithAct(root);
  });
});

describe("useTimelinePlayer RAF loop wrap-around", () => {
  type SeekCall = { time: number; options?: { keepPlaying?: boolean } };

  function attachInstrumentedAdapter(api: ReturnType<typeof useTimelinePlayer>, duration = 30) {
    const iframe = document.createElement("iframe");
    let currentTime = 0;
    let playing = false;
    const seekCalls: SeekCall[] = [];
    const adapter = {
      play: vi.fn(() => {
        playing = true;
      }),
      pause: vi.fn(() => {
        playing = false;
      }),
      seek: vi.fn((time: number, options?: { keepPlaying?: boolean }) => {
        currentTime = time;
        seekCalls.push({ time, options });
      }),
      getTime: () => currentTime,
      getDuration: () => duration,
      isPlaying: () => playing,
      setTime: (t: number) => {
        currentTime = t;
      },
    };
    Object.defineProperty(iframe, "contentWindow", {
      value: {
        __player: adapter,
        postMessage: () => {},
        scrollTo: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
    });
    Object.defineProperty(iframe, "contentDocument", {
      value: document.implementation.createHTMLDocument("preview"),
      configurable: true,
    });
    act(() => {
      api.iframeRef.current = iframe;
      api.onIframeLoad();
    });
    return { adapter, seekCalls };
  }

  function installRafCapture(): {
    flushOne: () => boolean;
    restore: () => void;
  } {
    const callbacks: FrameRequestCallback[] = [];
    const originalRAF = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    return {
      flushOne: () => {
        const next = callbacks.shift();
        if (!next) return false;
        next(performance.now());
        return true;
      },
      restore: () => {
        globalThis.requestAnimationFrame = originalRAF;
        globalThis.cancelAnimationFrame = originalCancel;
      },
    };
  }

  it("passes { keepPlaying: true } when forward playback wraps around loopEnd", () => {
    const raf = installRafCapture();
    try {
      const { api, root } = renderTimelinePlayerHarness();
      const { adapter, seekCalls } = attachInstrumentedAdapter(api);

      act(() => {
        usePlayerStore.getState().setInPoint(2);
        usePlayerStore.getState().setOutPoint(5);
      });
      expect(usePlayerStore.getState().loopEnabled).toBe(true);

      act(() => {
        api.play();
      });
      adapter.seek.mockClear();
      seekCalls.length = 0;

      adapter.setTime(6); // past outPoint=5
      act(() => {
        raf.flushOne();
      });

      const wrapSeek = seekCalls.find((call) => call.time === 2);
      expect(wrapSeek).toBeDefined();
      expect(wrapSeek?.options).toEqual({ keepPlaying: true });
      expect(adapter.play).toHaveBeenCalled();
      expect(usePlayerStore.getState().isPlaying).toBe(true);

      unmountWithAct(root);
    } finally {
      raf.restore();
    }
  });

  it("does not seek and pauses cleanly when forward playback reaches the end without loop", () => {
    const raf = installRafCapture();
    try {
      const { api, root } = renderTimelinePlayerHarness();
      const { adapter, seekCalls } = attachInstrumentedAdapter(api);

      act(() => {
        usePlayerStore.getState().setLoopEnabled(false);
      });

      act(() => {
        api.play();
      });
      adapter.seek.mockClear();
      seekCalls.length = 0;
      adapter.play.mockClear();
      adapter.pause.mockClear();

      adapter.setTime(adapter.getDuration() + 1); // past end
      act(() => {
        raf.flushOne();
      });

      expect(seekCalls).toHaveLength(0);
      expect(adapter.pause).toHaveBeenCalled();
      expect(usePlayerStore.getState().isPlaying).toBe(false);

      unmountWithAct(root);
    } finally {
      raf.restore();
    }
  });
});
