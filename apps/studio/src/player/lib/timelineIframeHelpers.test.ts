// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  buildMissingCompositionElements,
  resolvePreviewPlayerPlaybackAdapter,
} from "./timelineIframeHelpers";
import type { IframeWindow, PlaybackAdapter } from "./playbackTypes";

function makeDoc(html: string): Document {
  const d = document.implementation.createHTMLDocument();
  d.body.innerHTML = html;
  return d;
}

describe("buildMissingCompositionElements — hfId (R7)", () => {
  it("harvests hfId from data-hf-id on composition host elements", () => {
    const doc = makeDoc(`
      <div data-composition-id="root">
        <div
          data-composition-id="scene-a"
          data-composition-src="scenes/a.html"
          data-hf-id="hf-scene1"
          data-start="0"
          data-duration="5"
        ></div>
      </div>
    `);

    const { missing } = buildMissingCompositionElements(doc, window as IframeWindow, [], 10);
    const entry = missing[0];

    expect(entry).toBeDefined();
    expect(entry?.hfId).toBe("hf-scene1");
  });

  it("leaves hfId undefined when element has no data-hf-id", () => {
    const doc = makeDoc(`
      <div data-composition-id="root">
        <div
          data-composition-id="scene-b"
          data-composition-src="scenes/b.html"
          data-start="0"
          data-duration="5"
        ></div>
      </div>
    `);

    const { missing } = buildMissingCompositionElements(doc, window as IframeWindow, [], 10);
    const entry = missing[0];

    expect(entry).toBeDefined();
    expect(entry?.hfId).toBeUndefined();
  });
});

describe("resolvePreviewPlayerPlaybackAdapter", () => {
  it("routes transport through the owning player so parent-proxy audio sees playback state", () => {
    const host = document.createElement("hyperframes-player") as HTMLElement & {
      play: () => void;
      pause: () => void;
      seek: (time: number) => void;
      currentTime: number;
      duration: number;
      paused: boolean;
      ready: boolean;
    };
    const shadow = host.attachShadow({ mode: "open" });
    const iframe = document.createElement("iframe");
    shadow.appendChild(iframe);
    document.body.appendChild(host);

    let hostTime = 0;
    let hostPaused = true;
    const hostPlay = vi.fn(() => {
      hostPaused = false;
    });
    const hostPause = vi.fn(() => {
      hostPaused = true;
    });
    const hostSeek = vi.fn((time: number) => {
      hostTime = time;
      hostPaused = true;
    });
    Object.assign(host, { play: hostPlay, pause: hostPause, seek: hostSeek });
    Object.defineProperties(host, {
      currentTime: { get: () => hostTime },
      duration: { get: () => 30 },
      paused: { get: () => hostPaused },
      ready: { get: () => true },
    });

    const fallback: PlaybackAdapter = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 30,
      isPlaying: () => false,
    };
    const adapter = resolvePreviewPlayerPlaybackAdapter(iframe, fallback);

    expect(adapter).not.toBeNull();
    adapter?.play();
    expect(hostPlay).toHaveBeenCalledTimes(1);
    expect(fallback.play).not.toHaveBeenCalled();
    expect(adapter?.isPlaying()).toBe(true);

    adapter?.seek(4.2, { keepPlaying: true });
    expect(hostSeek).toHaveBeenCalledWith(4.2);
    expect(hostPlay).toHaveBeenCalledTimes(2);
    expect(adapter?.getTime()).toBe(4.2);
    expect(adapter?.isPlaying()).toBe(true);

    adapter?.pause();
    expect(hostPause).toHaveBeenCalledTimes(1);
    expect(fallback.pause).not.toHaveBeenCalled();
    expect(adapter?.isPlaying()).toBe(false);
  });

  it("keeps standalone iframe playback on the existing adapter", () => {
    const iframe = document.createElement("iframe");
    const fallback: PlaybackAdapter = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 5,
      isPlaying: () => false,
    };

    expect(resolvePreviewPlayerPlaybackAdapter(iframe, fallback)).toBeNull();
  });
});
