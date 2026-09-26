// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, test, expect, vi } from "vitest";
import { VideoVisual } from "./VideoVisual";
import type { ActiveVisual } from "./VisualOverlay";
import { mediaWindow, visualWinner } from "./VisualOverlay";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const layer: ActiveVisual = {
  layerId: "b", src: "/test.mp4", start: 1, duration: 2, cues: [],
  media: { assetId: "a".repeat(64), sourceIn: 0.5, sourceOut: 2.5, fit: "contain", muted: true },
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});
const flush = () => act(async () => { await Promise.resolve(); });
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(initial = layer, layers?: readonly ActiveVisual[]) {
  const host = document.createElement("div");
  host.className = "cf-cut-player-stage"; document.body.append(host);
  const master = document.createElement("video"), mount = document.createElement("div");
  master.dataset.kouboMediaOwner = "video";
  host.append(master, mount);
  const masterState = { paused: true, seeking: false, ended: false };
  for (const key of ["paused", "seeking", "ended"] as const) {
    Object.defineProperty(master, key, { configurable: true, get: () => masterState[key] });
  }
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const seeking = new WeakMap<HTMLMediaElement, boolean>();
  const errors = new WeakMap<HTMLMediaElement, MediaError | null>();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true; });
  vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockImplementation(function(this: HTMLMediaElement) { return seeking.get(this) ?? false; });
  vi.spyOn(HTMLMediaElement.prototype, "error", "get").mockImplementation(function(this: HTMLMediaElement) { return errors.get(this) ?? null; });
  const plays: Array<{ video: HTMLMediaElement; request: ReturnType<typeof deferred> }> = [];
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function(this: HTMLMediaElement) {
    paused.set(this, false);
    const request = deferred(); plays.push({ video: this, request });
    return request.promise;
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); });
  let tick: FrameRequestCallback = () => {};
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(cb => { tick = cb; return 1; });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const root = createRoot(mount);
  act(() => root.render(<VideoVisual layer={initial} layers={layers} />));
  let disposed = false;
  const dispose = () => { if (!disposed) { act(() => root.unmount()); host.remove(); disposed = true; } };
  cleanup.push(dispose);
  return {
    master, masterState, mount, play, pause, plays, paused, seeking, errors, dispose,
    get video() { return mount.querySelector("video")!; },
    get alert() { return mount.querySelector('[role="alert"]'); },
    tick: () => act(() => tick(0)),
    event: (type: string) => act(() => master.dispatchEvent(new Event(type))),
    videoEvent: (type: string) => act(() => mount.querySelector("video")!.dispatchEvent(new Event(type))),
    render: (next: ActiveVisual) => act(() => root.render(<VideoVisual layer={next} />)),
    start: (time = 1.75) => {
      master.currentTime = time; masterState.paused = false;
      act(() => master.dispatchEvent(new Event("play")));
    },
  };
}

test("B-roll follows master pause, seek and rate without seeking every playback frame", async () => {
  const h = setup();
  h.master.currentTime = 1.75; h.event("seeked");
  expect(h.video.currentTime).toBeCloseTo(1.25);
  expect(h.video.muted).toBe(true); expect(h.video.paused).toBe(true);
  h.master.playbackRate = 1.5; h.start();
  h.plays[0].request.resolve(); await flush();
  expect(h.video.playbackRate).toBe(1.5); expect(h.play).toHaveBeenCalledTimes(1);
  h.video.currentTime = 1.26; h.master.currentTime = 1.77; h.tick();
  expect(h.video.currentTime).toBe(1.26);
  h.masterState.paused = true; h.master.currentTime = 1.1; h.event("seeked");
  expect(h.video.currentTime).toBeCloseTo(0.6); expect(h.video.paused).toBe(true);
  h.master.currentTime = 3.1; h.tick(); expect(h.video.style.visibility).toBe("hidden");
  h.render({ ...layer, layerId: "fractional", start: 221.98000000000002, duration: 9.2,
    media: { ...layer.media!, sourceIn: 0, sourceOut: 9.2 } });
  h.master.currentTime = 221.98; h.event("seeked");
  expect(h.video.style.visibility).toBe("visible"); expect(h.video.currentTime).toBe(0);
  h.master.currentTime = 231.18; h.event("seeked"); expect(h.video.style.visibility).toBe("hidden");
});

test("rapid pause and resume waits for the cancelled play before starting another", async () => {
  const h = setup(); h.start();
  h.masterState.paused = true; h.event("pause"); expect(h.video.paused).toBe(true);
  const pauses = h.pause.mock.calls.length;
  h.tick(); h.tick(); expect(h.pause).toHaveBeenCalledTimes(pauses);
  h.masterState.paused = false; h.event("play"); h.tick();
  expect(h.play).toHaveBeenCalledTimes(1);
  h.plays[0].request.reject(new DOMException("interrupted by pause", "AbortError")); await flush();
  expect(h.play).toHaveBeenCalledTimes(2); expect(h.alert).toBeNull();
  h.plays[1].request.resolve(); await flush();
  expect(h.video.paused).toBe(false); expect(h.alert).toBeNull();
});

test("seek cancels an outstanding play and resumes only after it settles", async () => {
  const h = setup(); h.start();
  h.masterState.seeking = true; h.master.currentTime = 2.4; h.event("seeking");
  expect(h.video.paused).toBe(true); expect(h.video.currentTime).toBeCloseTo(1.9);
  h.masterState.seeking = false; h.event("seeked"); expect(h.play).toHaveBeenCalledTimes(1);
  h.plays[0].request.reject(new Error("superseded play")); await flush();
  expect(h.play).toHaveBeenCalledTimes(2); expect(h.alert).toBeNull();
  h.plays[1].request.resolve(); await flush(); expect(h.video.currentTime).toBeCloseTo(1.9);
});

test("a pending play resolving after leaving the layer cannot resume the hidden video", async () => {
  const h = setup(); h.start(); h.master.currentTime = 3.1; h.tick();
  h.plays[0].request.resolve(); await flush();
  expect(h.video.paused).toBe(true); expect(h.video.style.visibility).toBe("hidden");
  expect(h.play).toHaveBeenCalledTimes(1); expect(h.alert).toBeNull();
});

test("source replacement isolates the new video from stale play rejections", async () => {
  const h = setup(); h.start(); const oldVideo = h.video;
  h.render({ ...layer, src: "/replacement.mp4" });
  expect(h.video).not.toBe(oldVideo); expect(oldVideo.paused).toBe(true);
  expect(h.play).toHaveBeenCalledTimes(2);
  h.plays[0].request.reject(new Error("old source failed")); await flush(); h.tick();
  expect(h.play).toHaveBeenCalledTimes(2); expect(h.alert).toBeNull();
  h.plays[1].request.resolve(); await flush(); expect(h.video.paused).toBe(false);
});

test("a stale source success cannot clear the new source media failure", async () => {
  const h = setup(); h.start();
  h.render({ ...layer, src: "/replacement.mp4" });
  h.errors.set(h.video, { code: 3, message: "new decoder failure" } as MediaError); h.videoEvent("error");
  h.plays[0].request.resolve(); await flush();
  h.plays[1].request.reject(new DOMException("cancelled after media error", "AbortError")); await flush();
  expect(h.alert?.textContent).toContain("MEDIA_ERR_DECODE: new decoder failure");
  expect(h.video.paused).toBe(true); expect(h.play).toHaveBeenCalledTimes(2);
});

test("the follower waits for its own seek completion before playing", () => {
  const h = setup(); h.seeking.set(h.video, true); h.start();
  h.tick(); expect(h.play).not.toHaveBeenCalled();
  h.seeking.set(h.video, false); h.videoEvent("seeked");
  expect(h.video.currentTime).toBeCloseTo(1.25); expect(h.play).toHaveBeenCalledTimes(1);
});

test("timing edits retain the video source and resynchronize the paused frame", () => {
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const h = setup(); h.master.currentTime = 1.75; h.event("seeked");
  const video = h.video;
  h.render({ ...layer, start: 1.2, duration: 1.8 });
  expect(h.video).toBe(video);
  expect(video.getAttribute("src")).toBe(layer.src);
  expect(video.currentTime).toBeCloseTo(1.05);
  expect(load).not.toHaveBeenCalled();
  h.dispose(); expect(load).toHaveBeenCalledTimes(1);
});

test("equivalent layer objects do not pause or restart a playing follower", async () => {
  const h = setup(); h.start(); h.plays[0].request.resolve(); await flush();
  const pauses = h.pause.mock.calls.length;
  h.render({ ...layer, media: { ...layer.media! }, cues: [...layer.cues] });
  expect(h.pause).toHaveBeenCalledTimes(pauses); expect(h.play).toHaveBeenCalledTimes(1);
  expect(h.video.paused).toBe(false);
});

test("real media errors retain their reason only while active and clear after media recovery", () => {
  const h = setup(); h.master.currentTime = 1.75; h.event("seeked");
  h.errors.set(h.video, { code: 3, message: "decoder rejected packet" } as MediaError); h.videoEvent("error");
  expect(h.alert?.textContent).toContain("MEDIA_ERR_DECODE: decoder rejected packet");
  h.master.currentTime = 3.1; h.tick(); expect(h.alert).toBeNull();
  h.master.currentTime = 1.75; h.event("seeked");
  expect(h.alert?.textContent).toContain("decoder rejected packet");
  h.videoEvent("canplay"); expect(h.alert).not.toBeNull();
  h.errors.set(h.video, null); h.videoEvent("loadeddata"); expect(h.alert).toBeNull();
});

test("replacing a failed source clears old errors but preserves a new source failure", () => {
  const h = setup(); h.master.currentTime = 1.75; h.event("seeked");
  h.errors.set(h.video, { code: 2, message: "resource missing" } as MediaError); h.videoEvent("error");
  expect(h.alert?.textContent).toContain("MEDIA_ERR_NETWORK");
  h.render({ ...layer, src: "/replacement.mp4" }); expect(h.alert).toBeNull();
  h.errors.set(h.video, { code: 4, message: "unsupported codec" } as MediaError); h.videoEvent("error");
  expect(h.alert?.textContent).toContain("MEDIA_ERR_SRC_NOT_SUPPORTED: unsupported codec");
});

test("non-cancellation play failures are visible without a retry loop and successful retry clears them", async () => {
  const h = setup(); h.start(); h.paused.set(h.video, true);
  h.plays[0].request.reject(new DOMException("playback denied", "NotAllowedError")); await flush();
  expect(h.alert?.textContent).toContain("NotAllowedError: playback denied");
  h.tick(); h.tick(); expect(h.play).toHaveBeenCalledTimes(1);
  h.event("play"); expect(h.play).toHaveBeenCalledTimes(2);
  h.plays[1].request.resolve(); await flush(); expect(h.alert).toBeNull();
});

test("browser AbortError alone is recoverable rather than a media failure", async () => {
  const h = setup(); h.start(); h.paused.set(h.video, true);
  h.plays[0].request.reject(new DOMException("interrupted by load", "AbortError")); await flush();
  expect(h.alert).toBeNull(); h.tick(); expect(h.play).toHaveBeenCalledTimes(2);
  h.plays[1].request.resolve(); await flush(); expect(h.alert).toBeNull();
});

test("unmounted play results cannot write errors or restart playback", async () => {
  const h = setup(); h.start(); const video = h.video; h.dispose();
  expect(video.hasAttribute("src")).toBe(false);
  h.plays[0].request.reject(new Error("late failure")); await flush();
  expect(h.play).toHaveBeenCalledTimes(1); expect(h.mount.textContent).toBe("");
});

test("media window is bounded to winner plus nearest future MP4 across rapid scrubs", () => {
  const layers = Array.from({ length: 30 }, (_, i) => ({ ...layer, layerId: `v${i}`, start: i * 2 }));
  for (const time of [0, 17, 58, 3, 42, 0]) {
    expect(mediaWindow(layers, time)).toEqual(time === 58 ? ["v29"] : [`v${Math.floor(time / 2)}`, `v${Math.floor(time / 2) + 1}`]);
  }
  expect(mediaWindow(layers, 70)).toEqual([]);
});

test("overlapping later HTML or MP4 wins; losing media is not retained", () => {
  const first = { ...layer, layerId: "first", start: 0, duration: 10 };
  const last = { ...layer, layerId: "last", start: 2, duration: 2 };
  expect(visualWinner([first, last], 2)?.layerId).toBe("last");
  expect(mediaWindow([first, last], 2)).toEqual(["last"]);
  expect(mediaWindow([first, { ...last, media: undefined }], 2)).toEqual([]);
  expect(visualWinner([first, last], 4)?.layerId).toBe("first");
});

test("overlap losers never play and the winner follows the explicit narration owner", () => {
  const winner = { ...layer, layerId: "winner" };
  const h = setup(layer, [layer, winner]);
  h.start();
  expect(h.play).not.toHaveBeenCalled();
  expect(h.video.style.visibility).toBe("hidden");
  h.render(winner);
  const unrelated = document.createElement("video");
  unrelated.currentTime = 99;
  h.master.parentElement!.prepend(unrelated);
  h.master.currentTime = 1.5; h.event("seeked");
  expect(h.video.currentTime).toBeCloseTo(1);
  expect(h.video.style.visibility).toBe("visible");
});
