// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAssembledVideoTransport, type EdlVideoTransport } from "./useAssembledVideoTransport";
import { usePreviewArtifact, previewArtifactUrl, type PreviewArtifactStream } from "./previewArtifact";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function coldHarness(initialTime = 7, stream: PreviewArtifactStream | null = null) {
  let value!: EdlVideoTransport;
  let metadata = false, mediaDuration = NaN;
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(() => metadata ? 1 : 0);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockImplementation(() => mediaDuration);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const resolve = (source: string) => source;
  function Cold({ source, duration }: { source: string | null; duration: number }) {
    value = useAssembledVideoTransport({ sourceUrl: source, stream, resolveFragmentUrl: resolve, duration, initialTimelineTime: initialTime });
    return source ? <video ref={value.videoRef} /> : null;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  return {
    get value() { return value; }, get video() { return host.querySelector("video")!; }, play, pause,
    render: (duration: number, source: string | null = "/cold.mp4", key = "a") => act(() => root.render(<Cold key={key} source={source} duration={duration} />)),
    loaded: (duration = NaN) => { metadata = true; mediaDuration = duration; act(() => host.querySelector("video")!.dispatchEvent(new Event("loadedmetadata"))); },
    loading: () => { metadata = false; mediaDuration = NaN; },
    event: (name: string) => act(() => host.querySelector("video")!.dispatchEvent(new Event(name))),
    dispose: () => act(() => root.unmount()),
  };
}

it("retains cold URL intent while duration is unknown and initialization reports zero", () => {
  const h = coldHarness();
  try {
    h.render(0); h.event("timeupdate"); h.event("seeked");
    expect(h.value.timelineTime).toBe(7);
    expect(h.video.currentTime).toBe(0);
    h.loaded(); expect(h.value.timelineTime).toBe(7);
    h.render(20); expect(h.video.currentTime).toBe(7);
  } finally { h.dispose(); }
});

it("waits for metadata after duration and gives the latest user seek including zero priority", async () => {
  const h = coldHarness();
  try {
    h.render(20);
    expect(h.video.currentTime).toBe(0);
    await act(async () => h.value.seek(12));
    await act(async () => h.value.seek(0));
    h.loaded(20);
    expect(h.video.currentTime).toBe(0); expect(h.value.timelineTime).toBe(0);
    expect(h.play).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it("retains a seek before the media element mounts and clamps only to known media bounds", async () => {
  const h = coldHarness();
  try {
    h.render(0, null);
    await act(async () => h.value.seek(25));
    h.render(0); h.loaded(20);
    expect(h.value.timelineTime).toBe(20); expect(h.video.currentTime).toBe(20);
  } finally { h.dispose(); }
});

it("preserves current position across source reload and pause supersedes queued autoplay", async () => {
  const h = coldHarness();
  try {
    h.render(20); h.loaded(20);
    await act(async () => h.value.seek(4, { keepPlaying: true }));
    expect(h.play).toHaveBeenCalledTimes(1);
    h.loading(); h.render(20, "/new.mp4"); h.video.currentTime = 0;
    h.event("timeupdate"); h.event("ended");
    expect(h.value.timelineTime).toBe(4);
    act(() => h.value.pause()); h.loaded(20);
    expect(h.video.currentTime).toBe(4); expect(h.value.desiredPlaying).toBe(false);
    expect(h.play).toHaveBeenCalledTimes(1);
  } finally { h.dispose(); }
});

it("does not consume reload intent from the previous source's temporarily retained metadata", () => {
  const h = coldHarness(7);
  try {
    h.render(20); h.loaded(20);
    expect(h.video.currentTime).toBe(7);
    // Deliberately retain readyState=1 while src changes, as a browser may do
    // before its asynchronous load reset. Only the NEW metadata may unlock seek.
    h.render(19, "/replacement.mp4");
    h.event("durationchange");
    h.loading(); h.video.currentTime = 0; h.event("timeupdate"); h.event("seeked");
    expect(h.value.timelineTime).toBe(7);
    h.loaded(20);
    expect(h.video.currentTime).toBe(7);
  } finally { h.dispose(); }
});

it("latest loading seek plays after readiness and project remount discards previous pending intent", async () => {
  const h = coldHarness(7);
  try {
    h.render(0);
    await act(async () => h.value.restoreIntent(12, true));
    await act(async () => h.value.seek(9, { keepPlaying: true }));
    h.loaded(20); expect(h.video.currentTime).toBe(9); expect(h.play).toHaveBeenCalledTimes(1);
    h.loading(); h.render(0, "/old-pending.mp4");
    await act(async () => h.value.seek(18, { keepPlaying: true }));
    h.render(0, "/other-project.mp4", "other-project"); h.loaded(20);
    expect(h.video.currentTime).toBe(7); expect(h.value.desiredPlaying).toBe(false);
    expect(h.play).toHaveBeenCalledTimes(1);
  } finally { h.dispose(); }
});

it("stale play rejection cannot clear the new source's playback state", async () => {
  const h = coldHarness();
  let reject!: (cause: Error) => void;
  try {
    h.render(20); h.loaded(20);
    h.play.mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }));
    let previous!: Promise<void>;
    act(() => { previous = h.value.seek(4, { keepPlaying: true }); });
    h.loading(); h.render(20, "/new.mp4"); h.loaded(20); h.event("playing");
    expect(h.value.isPlaying).toBe(true);
    await act(async () => { reject(new Error("old source")); await previous; });
    expect(h.value.isPlaying).toBe(true); expect(h.value.timelineTime).toBe(4);
  } finally { h.dispose(); }
});

it("known timeline bounds win over codec duration and late metadata cannot reset an applied seek", async () => {
  const h = coldHarness();
  try {
    h.render(10); h.loaded(10.08);
    await act(async () => h.value.seek(20));
    expect(h.video.currentTime).toBe(10); expect(h.value.duration).toBe(10);
    await act(async () => h.value.seek(3)); h.event("loadedmetadata");
    expect(h.video.currentTime).toBe(3);
  } finally { h.dispose(); }
});

it.each([true, false])("MSE preserves initial seek when metadata-first=%s and retains segment offsets", async metadataFirst => {
  const offsets: number[] = [];
  class TestMediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    readyState = "open";
    sourceBuffers: object[] = [];
    addSourceBuffer() {
      const buffer = Object.assign(new EventTarget(), { updating: false, mode: "", appendWindowStart: 0,
        appendWindowEnd: Infinity, timestampOffset: 0,
        appendBuffer() { offsets.push(this.timestampOffset); }, abort() {} });
      this.sourceBuffers.push(buffer); return buffer;
    }
    removeSourceBuffer(buffer: object) { this.sourceBuffers = this.sourceBuffers.filter(item => item !== buffer); }
    endOfStream() { this.readyState = "ended"; }
  }
  vi.stubGlobal("MediaSource", TestMediaSource);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mse-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let release!: () => void;
  const waiting = new Promise<void>(yes => { release = yes; });
  vi.stubGlobal("fetch", vi.fn(async () => { await waiting; return new Response(new Uint8Array([1])); }));
  const h = coldHarness(7, { mimeType: "video/mp4", totalSeconds: 20, segments: [
    { source: "a.mp4", headExtra: 0.1, out: 0, dur: 10 },
    { source: "b.mp4", headExtra: 0.2, out: 10, dur: 10 },
  ] });
  try {
    h.render(0);
    if (metadataFirst) h.loaded(20);
    h.event("timeupdate"); expect(h.value.timelineTime).toBe(7);
    await act(async () => { release(); await new Promise(yes => setTimeout(yes, 0)); });
    if (!metadataFirst) { expect(h.video.currentTime).toBe(0); h.loaded(20); }
    expect(h.video.currentTime).toBe(7); expect(offsets).toEqual([-0.1, 9.8]);
    expect(h.play).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it("real preview-artifact polling plus real transport preserve deep-link seek from old preview to new audio", async () => {
  let metadata = false;
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(() => metadata ? 4 : 0);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(235.562);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const state = { editRevision: "new", error: null, stream: null };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ...state, phase: "generating", artifactRevision: "old", source: "old.mp4" }))
    .mockImplementation(async () => Response.json({ ...state, phase: "current", artifactRevision: "new", source: "new-audio.mp4", hasVideo: false, hasAudio: true }));
  vi.stubGlobal("fetch", fetchMock);
  let transport!: EdlVideoTransport;
  function ArtifactHarness() {
    const artifact = usePreviewArtifact("seek-v2", "new");
    const source = artifact.state.source ? previewArtifactUrl("seek-v2", artifact.state.source) : null;
    transport = useAssembledVideoTransport({ sourceUrl: source, stream: artifact.state.stream ?? null,
      duration: 235.562, initialTimelineTime: 28.722, resolveFragmentUrl: resolveFixtureFragment });
    return source ? <video ref={transport.videoRef} data-phase={artifact.state.phase} /> : null;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ArtifactHarness />); await new Promise(yes => setTimeout(yes, 0)); });
    const video = host.querySelector("video")!;
    expect(video.dataset.phase).toBe("generating");
    metadata = true; act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(video.currentTime).toBe(28.722);
    await act(async () => { await new Promise(yes => setTimeout(yes, 380)); });
    expect(video.dataset.phase).toBe("current"); expect(video.src).toContain("new-audio.mp4");
    metadata = false; video.currentTime = 0;
    act(() => { video.dispatchEvent(new Event("timeupdate")); video.dispatchEvent(new Event("seeked")); });
    expect(transport.timelineTime).toBe(28.722);
    metadata = true; act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(video.currentTime).toBe(28.722); expect(play).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); }
});

const resolveFixtureFragment = (source: string) => source;
function Harness({ sourceUrl }: { sourceUrl: string | null }) {
  const transport = useAssembledVideoTransport({
    stream: null,
    sourceUrl,
    resolveFragmentUrl: resolveFixtureFragment,
    duration: 10,
    initialTimelineTime: 0,
  });
  return (
    <>
      <span data-testid="published">{transport.timelineTime.toFixed(2)}</span>
      {sourceUrl ? <video ref={transport.videoRef} /> : null}
    </>
  );
}

describe("useAssembledVideoTransport", () => {
  // The player renders its <video> only once there is something to play, so the
  // element always arrives after this hook's first commit. Nothing else about the
  // hook's inputs need change when it does — so an effect that merely reads a ref
  // subscribes to a clock that is not there yet and never returns. That shipped
  // once: sound was perfect and the transcript playhead sat on the first word.
  it("follows a media element that mounts after the first render", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness sourceUrl={null} />));
    expect(host.querySelector("video")).toBeNull();

    act(() => root.render(<Harness sourceUrl="/api/projects/demo/preview/source.mp4" />));
    const video = host.querySelector("video");
    expect(video).not.toBeNull();
    // A real playing element has metadata; happy-dom does not load the fixture.
    Object.defineProperty(video!, "readyState", { value: 1, configurable: true });
    act(() => { video!.dispatchEvent(new Event("loadedmetadata")); });

    Object.defineProperty(video!, "currentTime", { value: 7.5, configurable: true });
    act(() => { video!.dispatchEvent(new Event("timeupdate")); });

    expect(host.querySelector('[data-testid="published"]')?.textContent).toBe("7.50");
  });
});
