import { describe, expect, it } from "bun:test";
import {
  buildEdlPreviewSegments,
  renderEdlPreviewPayload,
  renderEdlPreviewRuntime,
  resolveEdlPreviewPosition,
} from "./edlPreviewRuntime";

const document = {
  schemaVersion: 1 as const,
  projectId: "demo",
  sourceDuration: 12,
  baseCutsRevision: "a".repeat(64),
  baseTranscriptRevision: "b".repeat(64),
  mode: "cuts-derived" as const,
  duration: 8,
  segments: [
    {
      id: "a",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 4,
      timelineStart: 0,
      trackId: "a-roll" as const,
      playbackRate: 1,
    },
    {
      id: "b",
      source: "input/source.mp4",
      sourceStart: 8,
      sourceEnd: 12,
      timelineStart: 4,
      trackId: "a-roll" as const,
      playbackRate: 1,
    },
  ],
};

type PlayOutcome = { kind: "resolve" } | { kind: "reject"; name: string };

interface RuntimeHarnessOptions {
  editList?: typeof document;
  videoReadyState?: number;
}

async function flushPromiseQueue(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

async function withRuntimeHarness(
  outcomes: PlayOutcome[],
  run: (harness: {
    adapter: {
      getTime(): number;
      play(): void;
      pause(): void;
      isPlaying(): boolean;
      seek(time: number, options?: { keepPlaying?: boolean }): void;
      setPlaybackRate(rate: number): void;
    };
    audio: {
      currentTime: number;
      currentTimeWrites: Array<{ muted: boolean; time: number }>;
      emit(type: string): void;
      paused: boolean;
      seeking: boolean;
      muted: boolean;
      playbackRate: number;
      playCalls: number;
    };
    dataset: Record<string, string>;
    flushFrame(): void;
    getBaseTimelineTime(): number;
    messages: unknown[];
    setTimelineTime(time: number): void;
    setMuted(muted: boolean): void;
    video: {
      currentTime: number;
      currentTimeWrites: Array<{ muted: boolean; time: number }>;
      loadCalls: number;
      paused: boolean;
      muted: boolean;
      playbackRate: number;
      playCalls: number;
      readyState: number;
    };
  }) => Promise<void>,
  options: RuntimeHarnessOptions = {},
): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  const keys = ["document", "window", "HTMLVideoElement", "requestAnimationFrame", "cancelAnimationFrame"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const frames = new Map<number, (time: number) => void>();
  const messages: unknown[] = [];
  let frameId = 0;
  let playing = false;
  let timelineTime = 0;
  let playbackRate = 1;
  const runtimeDocument = options.editList ?? document;

  class FakeMedia {
    private mediaCurrentTime = 0;
    private readonly eventListeners = new Map<
      string,
      Array<{ listener: () => void; once: boolean }>
    >();
    dataset: Record<string, string> = {};
    loadCalls = 0;
    muted = false;
    paused = true;
    seeking = false;
    playbackRate = 1;
    playCalls = 0;
    currentTimeWrites: Array<{ muted: boolean; time: number }> = [];
    preload = "";
    id = "";
    src = "";
    style: Record<string, string> = {};
    volume = 1;
    readyState = 4;

    constructor(private readonly playOutcomes: PlayOutcome[]) {}

    get currentTime(): number {
      return this.mediaCurrentTime;
    }
    set currentTime(time: number) {
      this.mediaCurrentTime = time;
      this.seeking = true;
      this.currentTimeWrites.push({ muted: this.muted, time });
    }
    addEventListener(
      type: string,
      listener: () => void,
      options?: { once?: boolean },
    ): void {
      const listeners = this.eventListeners.get(type) ?? [];
      listeners.push({ listener, once: options?.once === true });
      this.eventListeners.set(type, listeners);
    }
    emit(type: string): void {
      if (type === "seeked") this.seeking = false;
      const listeners = this.eventListeners.get(type) ?? [];
      const retained = listeners.filter(({ once }) => !once);
      if (retained.length > 0) this.eventListeners.set(type, retained);
      else this.eventListeners.delete(type);
      for (const { listener } of listeners) listener();
    }
    removeEventListener(type: string, listener: () => void): void {
      const listeners = this.eventListeners.get(type) ?? [];
      const retained = listeners.filter((entry) => entry.listener !== listener);
      if (retained.length > 0) this.eventListeners.set(type, retained);
      else this.eventListeners.delete(type);
    }
    load(): void {
      this.loadCalls += 1;
    }
    pause(): void {
      this.paused = true;
    }
    play(): Promise<void> {
      this.playCalls += 1;
      const outcome = this.playOutcomes.shift() ?? { kind: "resolve" as const };
      if (outcome.kind === "reject") {
        this.paused = true;
        return Promise.reject({ name: outcome.name });
      }
      this.paused = false;
      return Promise.resolve();
    }
    remove(): void {}
    removeAttribute(name: string): void {
      if (name === "src") this.src = "";
    }
    setAttribute(name: string, value: string): void {
      if (name === "src") this.src = value;
    }
  }

  class FakeVideo extends FakeMedia {}
  class FakeAudio extends FakeMedia {}

  const video = new FakeVideo([]);
  video.readyState = options.videoReadyState ?? 4;
  video.dataset.edlSource = "input/source.mp4";
  video.src = "input/source.mp4";
  const audio = new FakeAudio(outcomes);
  const playerHost = { muted: false, playbackRate: 1, volume: 1 };
  const parentDocument = {
    body: { dataset: {} as Record<string, string>, appendChild: () => {} },
    getElementById: (id: string) => (audio.id === id ? audio : null),
    createElement: (tagName: string) => {
      if (tagName !== "audio") throw new Error(`unexpected element: ${tagName}`);
      return audio;
    },
  };
  const frameElement = {
    ownerDocument: parentDocument,
    getRootNode: () => ({ host: playerHost }),
    attributes: {} as Record<string, string>,
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name: string) {
      delete this.attributes[name];
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
  };
  const dataset: Record<string, string> = {};
  const windowObject: Record<string, unknown> = {
    frameElement,
    __player: {
      play: () => {
        playing = true;
      },
      pause: () => {
        playing = false;
      },
      seek: (time: number) => {
        timelineTime = time;
      },
      getTime: () => timelineTime,
      getDuration: () => runtimeDocument.duration,
      isPlaying: () => playing,
      getPlaybackRate: () => playbackRate,
      setPlaybackRate: (rate: number) => {
        playbackRate = rate;
        playerHost.playbackRate = rate;
      },
    },
    parent: {
      postMessage: (message: unknown) => messages.push(message),
    },
    addEventListener: () => {},
  };

  Object.defineProperties(globals, {
    document: {
      configurable: true,
      value: {
        readyState: "complete",
        baseURI: "http://127.0.0.1:5190/api/projects/demo/preview/",
        documentElement: { dataset },
        getElementById: () => video,
        querySelector: () => ({ textContent: renderEdlPreviewPayload(runtimeDocument) }),
      },
    },
    window: { configurable: true, value: windowObject },
    HTMLVideoElement: { configurable: true, value: FakeVideo },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frameId += 1;
        frames.set(frameId, callback);
        return frameId;
      },
    },
    cancelAnimationFrame: {
      configurable: true,
      value: (id: number) => frames.delete(id),
    },
  });

  try {
    Function(renderEdlPreviewRuntime(runtimeDocument))();
    const adapter = windowObject.__studioPlaybackAdapter as {
      getTime(): number;
      play(): void;
      pause(): void;
      isPlaying(): boolean;
      seek(time: number, options?: { keepPlaying?: boolean }): void;
      setPlaybackRate(rate: number): void;
    };
    expect(adapter).toBeDefined();
    await run({
      adapter,
      audio,
      dataset,
      flushFrame: () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      },
      getBaseTimelineTime: () => timelineTime,
      messages,
      setTimelineTime: (time: number) => {
        timelineTime = time;
      },
      setMuted: (muted: boolean) => {
        playerHost.muted = muted;
      },
      video,
    });
  } finally {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
    }
  }
}

describe("EDL preview runtime", () => {
  const segments = buildEdlPreviewSegments(document);

  it("maps timeline time to source time and jumps across a deleted range", () => {
    expect(resolveEdlPreviewPosition(segments, 3.5)).toMatchObject({
      index: 0,
      sourceTime: 3.5,
    });
    expect(resolveEdlPreviewPosition(segments, 4)).toMatchObject({
      index: 1,
      sourceTime: 8,
    });
    expect(resolveEdlPreviewPosition(segments, 5.25)).toMatchObject({
      index: 1,
      sourceTime: 9.25,
    });
  });

  it("clamps the first and final frame deterministically", () => {
    expect(resolveEdlPreviewPosition(segments, -10)?.sourceTime).toBe(0);
    expect(resolveEdlPreviewPosition(segments, 99)?.sourceTime).toBe(12);
  });

  it("registers a Studio-only adapter without replacing HyperFrames __player", () => {
    const script = renderEdlPreviewRuntime(document);
    expect(script).toContain('Reflect.get(window, "__player")');
    expect(script).toContain("chengfeng-videocut:edl-preview-runtime-v5");
    expect(script).toContain('document.querySelector(\'script[data-chengfeng-videocut-edl-payload="1"]\')');
    expect(script).not.toContain('"source":"input/source.mp4"');
    expect(script).toContain('Reflect.set(window, "__studioPlaybackAdapter", adapter)');
    expect(script.match(/video\.removeAttribute\("data-start"\)/g)).toHaveLength(2);
    expect(script.match(/video\.removeAttribute\("data-hf-auto-start"\)/g)).toHaveLength(2);
    expect(script.indexOf('Reflect.set(window, "__studioPlaybackAdapter", adapter)')).toBeLessThan(
      script.indexOf('dataset.videocutEdlAdapter = "ready"'),
    );
    expect(script).toContain("const baseGetTime = base.getTime.bind(base)");
    expect(script).not.toContain("base.getTime()");
    expect(script).not.toContain("Object.create(base)");
    expect(script).not.toContain("window.__player =");
    expect(script).not.toContain('source: "hf-preview"');
    expect(script).not.toContain('type: "media-autoplay-blocked"');
    expect(script).toContain('parentDocument.createElement("audio")');
    expect(script).toContain('frameElement.setAttribute("data-videocut-edl-audio-id"');
    expect(script).toContain('frameElement?.getAttribute("data-videocut-edl-audio-play")');
    expect(script).toContain("audioBoundaryGateIndex >= 0");
    expect(script).toContain('parentPlayState === "retry-muted"');
    expect(script).toContain("let transportPlaybackRate");
    expect(script).toContain('dataset.videocutEdlAudioOwner = audioOutput ? "parent" : "iframe"');
    expect(script).toContain('name === "AbortError"');
    expect(script).toContain('name === "NotAllowedError"');
    expect(script).toContain('postPlaybackIssue("videocut-audio-gesture-required"');
    expect(script).not.toContain("requestAnimationFrame(requestProductMediaPlay)");
  });

  it("explicitly starts the initial backing-video load when metadata is absent", async () => {
    await withRuntimeHarness(
      [],
      async ({ video }) => {
        expect(video.readyState).toBe(0);
        expect(video.loadCalls).toBe(1);
      },
      { videoReadyState: 0 },
    );
  });

  it("keeps a paused EDL seek authoritative when the base clock resets and resumes there", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({
        adapter,
        audio,
        getBaseTimelineTime,
        setTimelineTime,
        video,
      }) => {
        adapter.seek(2.74);
        expect(adapter.getTime()).toBeCloseTo(2.74, 5);
        expect(video.currentTime).toBeCloseTo(2.74, 5);
        expect(audio.currentTime).toBeCloseTo(2.74, 5);

        // HyperFrames can publish a stale paused clock after the extension's
        // source-mapped seek has already completed. This must not become the
        // Product clock or make rate/pause operations jump the media to zero.
        setTimelineTime(0);
        expect(adapter.getTime()).toBeCloseTo(2.74, 5);
        adapter.setPlaybackRate(2);
        adapter.pause();
        expect(adapter.getTime()).toBeCloseTo(2.74, 5);
        expect(video.currentTime).toBeCloseTo(2.74, 5);
        expect(audio.currentTime).toBeCloseTo(2.74, 5);

        adapter.play();
        await flushPromiseQueue();
        expect(getBaseTimelineTime()).toBeCloseTo(2.74, 5);
        expect(adapter.getTime()).toBeCloseTo(2.74, 5);
        expect(video.currentTime).toBeCloseTo(2.74, 5);
        expect(audio.currentTime).toBeCloseTo(2.74, 5);
      },
    );
  });

  it("retries an interrupted parent-audio play without losing the picture stream", async () => {
    await withRuntimeHarness(
      [{ kind: "reject", name: "AbortError" }, { kind: "resolve" }],
      async ({ adapter, audio, flushFrame, messages, video }) => {
        adapter.play();
        await flushPromiseQueue();
        expect(audio.paused).toBe(true);
        expect(video.paused).toBe(false);
        expect(adapter.isPlaying()).toBe(true);
        flushFrame();
        await flushPromiseQueue();
        expect(audio.playCalls).toBe(2);
        expect(video.paused).toBe(false);
        expect(video.muted).toBe(true);
        expect(audio.muted).toBe(false);
        expect(messages).toEqual([]);
      },
    );
  });

  it("fails closed on a real autoplay block and retries on the next play gesture", async () => {
    await withRuntimeHarness(
      [{ kind: "reject", name: "NotAllowedError" }, { kind: "resolve" }],
      async ({ adapter, audio, dataset, messages, video }) => {
        adapter.play();
        await flushPromiseQueue();
        expect(adapter.isPlaying()).toBe(false);
        expect(audio.paused).toBe(true);
        expect(video.paused).toBe(true);
        expect(video.muted).toBe(true);
        expect(dataset.videocutEdlAdapter).toBe("audio-blocked");
        expect(messages).toEqual([{
          source: "chengfeng-videocut",
          type: "videocut-audio-gesture-required",
          errorName: "NotAllowedError",
        }]);

        adapter.play();
        await flushPromiseQueue();
        expect(adapter.isPlaying()).toBe(true);
        expect(audio.paused).toBe(false);
        expect(video.paused).toBe(false);
        expect(video.muted).toBe(true);
        expect(audio.muted).toBe(false);
        expect(dataset.videocutEdlAdapter).toBe("playing");
      },
    );
  });

  it("keeps audio live while the source clock jumps across a deleted range", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, flushFrame, messages, setTimelineTime, video }) => {
        adapter.play();
        await flushPromiseQueue();
        setTimelineTime(3.9);
        flushFrame();
        await flushPromiseQueue();
        expect(video.currentTime).toBeCloseTo(3.9, 5);
        expect(audio.currentTime).toBeCloseTo(3.9, 5);

        setTimelineTime(4.1);
        flushFrame();
        await flushPromiseQueue();
        expect(video.currentTime).toBeCloseTo(8.1, 5);
        expect(audio.currentTime).toBeCloseTo(8.1, 5);
        expect(video.paused).toBe(false);
        expect(video.muted).toBe(true);
        expect(audio.paused).toBe(false);
        expect(audio.muted).toBe(true);
        audio.emit("seeked");
        expect(audio.muted).toBe(false);
        expect(messages).toEqual([]);
      },
    );
  });

  it("gates parent audio before a cross-segment seek and restores it after seeked", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, flushFrame, setTimelineTime }) => {
        adapter.play();
        await flushPromiseQueue();

        setTimelineTime(3.9);
        flushFrame();
        await flushPromiseQueue();
        expect(audio.muted).toBe(false);

        audio.currentTimeWrites.length = 0;
        setTimelineTime(4.1);
        flushFrame();
        await flushPromiseQueue();

        expect(audio.currentTimeWrites.at(-1)).toEqual({
          muted: true,
          time: 8.1,
        });
        expect(audio.muted).toBe(true);
        expect(audio.paused).toBe(false);

        audio.emit("seeked");
        expect(audio.muted).toBe(false);
        expect(audio.paused).toBe(false);
      },
    );
  });

  it("cancels a pending boundary seek on pause so stale seeked cannot resume playback", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, dataset, setTimelineTime, video }) => {
        adapter.play();
        await flushPromiseQueue();
        setTimelineTime(3.9);

        adapter.seek(4.1, { keepPlaying: true });
        await flushPromiseQueue();
        expect(audio.muted).toBe(true);
        expect(dataset.videocutEdlAudioGate).toBe("seeking");

        adapter.pause();
        await flushPromiseQueue();
        expect(adapter.isPlaying()).toBe(false);
        expect(audio.paused).toBe(true);
        expect(video.paused).toBe(true);
        expect(audio.muted).toBe(false);
        expect(dataset.videocutEdlAudioGate).toBeUndefined();

        audio.emit("seeked");
        await flushPromiseQueue();
        expect(adapter.isPlaying()).toBe(false);
        expect(audio.paused).toBe(true);
        expect(video.paused).toBe(true);
        expect(audio.muted).toBe(false);
        expect(dataset.videocutEdlAudioGate).toBeUndefined();
      },
    );
  });

  it("keeps rapid keepPlaying boundary seeks latest-wins until the newest seeked", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, dataset }) => {
        adapter.play();
        await flushPromiseQueue();

        adapter.seek(4.1, { keepPlaying: true });
        adapter.seek(4.2, { keepPlaying: true });
        await flushPromiseQueue();
        expect(audio.currentTime).toBeCloseTo(8.2, 5);
        expect(audio.muted).toBe(true);
        expect(dataset.videocutEdlAudioGate).toBe("seeking");

        // Simulate a stale completion for the superseded 8.1-second seek.
        audio.currentTime = 8.1;
        audio.emit("seeked");
        await flushPromiseQueue();
        expect(audio.muted).toBe(true);
        expect(audio.paused).toBe(false);
        expect(dataset.videocutEdlAudioGate).toBe("seeking");

        audio.currentTime = 8.2;
        audio.emit("seeked");
        await flushPromiseQueue();
        expect(audio.muted).toBe(false);
        expect(audio.paused).toBe(false);
        expect(adapter.isPlaying()).toBe(true);
        expect(dataset.videocutEdlAudioGate).toBeUndefined();
      },
    );
  });

  it("pre-gates parent audio 30ms before a deleted boundary without seeking early", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, flushFrame, setTimelineTime }) => {
        adapter.play();
        await flushPromiseQueue();

        setTimelineTime(3.9);
        flushFrame();
        await flushPromiseQueue();
        expect(audio.muted).toBe(false);

        audio.currentTimeWrites.length = 0;
        setTimelineTime(3.97);
        flushFrame();
        await flushPromiseQueue();

        expect(audio.muted).toBe(true);
        expect(audio.paused).toBe(false);
        expect(audio.currentTimeWrites).toEqual([]);
      },
    );
  });

  it("does not pre-gate or seek across source-contiguous segments", async () => {
    const continuousDocument = {
      ...document,
      sourceDuration: 8,
      segments: [
        document.segments[0],
        {
          ...document.segments[1],
          sourceStart: 4,
          sourceEnd: 8,
        },
      ],
    };

    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, flushFrame, setTimelineTime, video }) => {
        adapter.play();
        await flushPromiseQueue();

        setTimelineTime(3.9);
        flushFrame();
        await flushPromiseQueue();
        audio.currentTimeWrites.length = 0;
        video.currentTimeWrites.length = 0;

        setTimelineTime(3.97);
        flushFrame();
        await flushPromiseQueue();
        expect(audio.muted).toBe(false);

        setTimelineTime(4.01);
        flushFrame();
        await flushPromiseQueue();
        expect(audio.muted).toBe(false);
        expect(audio.currentTimeWrites).toEqual([]);
        expect(video.currentTimeWrites).toEqual([]);
      },
      { editList: continuousDocument },
    );
  });

  it("keeps parent audio live at 2x and follows Studio mute state", async () => {
    await withRuntimeHarness(
      [{ kind: "resolve" }],
      async ({ adapter, audio, flushFrame, setMuted, video }) => {
        adapter.setPlaybackRate(2);
        adapter.play();
        await flushPromiseQueue();
        expect(audio.playbackRate).toBe(2);
        expect(video.playbackRate).toBe(2);
        expect(audio.muted).toBe(false);

        setMuted(true);
        flushFrame();
        expect(audio.muted).toBe(true);
        expect(video.muted).toBe(true);

        setMuted(false);
        flushFrame();
        expect(audio.muted).toBe(false);
        expect(audio.paused).toBe(false);
      },
    );
  });
});
