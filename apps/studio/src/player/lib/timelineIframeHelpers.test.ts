// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  buildMissingCompositionElements,
  disposePreviewEdlAudio,
  installPreviewEdlAudioCleanup,
  playPreviewEdlAudio,
  setPreviewPlaybackRate,
} from "./timelineIframeHelpers";
import type { IframeWindow } from "./playbackTypes";

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

describe("playPreviewEdlAudio", () => {
  it("starts the EDL audio element owned by the parent document", async () => {
    const iframe = document.createElement("iframe");
    const audio = document.createElement("audio");
    const play = vi.fn(() => Promise.resolve());
    audio.play = play;
    audio.id = "videocut-edl-audio-1";
    document.body.append(audio);
    iframe.setAttribute("data-videocut-edl-audio-id", audio.id);

    await expect(playPreviewEdlAudio(iframe)).resolves.toBeUndefined();
    expect(play).toHaveBeenCalledTimes(1);
    expect(iframe.getAttribute("data-videocut-edl-audio-play")).toBe("playing");
  });

  it("does nothing for an ordinary HyperFrames iframe", () => {
    expect(playPreviewEdlAudio(document.createElement("iframe"))).toBeNull();
  });

  it("bootstraps an audible EDL output through muted playback when activation is absent", async () => {
    const iframe = document.createElement("iframe");
    const audio = document.createElement("audio");
    audio.id = "videocut-edl-audio-2";
    document.body.append(audio);
    iframe.setAttribute("data-videocut-edl-audio-id", audio.id);
    const play = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
      .mockResolvedValueOnce();
    audio.play = play;

    await expect(playPreviewEdlAudio(iframe)).resolves.toBeUndefined();

    expect(play).toHaveBeenCalledTimes(2);
    expect(audio.muted).toBe(false);
    expect(iframe.getAttribute("data-videocut-edl-audio-play")).toBe(
      "playing:muted-bootstrap",
    );
  });

  it("keeps a muted EDL visual playing when the inaudible audio node is blocked", async () => {
    const iframe = document.createElement("iframe");
    const audio = document.createElement("audio");
    audio.id = "videocut-edl-audio-3";
    audio.muted = true;
    audio.play = vi.fn(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
    document.body.append(audio);
    iframe.setAttribute("data-videocut-edl-audio-id", audio.id);

    await expect(playPreviewEdlAudio(iframe)).resolves.toBeUndefined();
    expect(iframe.getAttribute("data-videocut-edl-audio-play")).toBe("muted-skip");
  });
});

describe("parent EDL audio cleanup", () => {
  it("stops, unloads, and removes the parent audio decoder idempotently", () => {
    const iframe = document.createElement("iframe");
    const audio = document.createElement("audio");
    const pause = vi.fn();
    const load = vi.fn();
    audio.pause = pause;
    audio.load = load;
    audio.id = "videocut-edl-audio-dispose";
    audio.src = "/video.mp4";
    document.body.append(iframe, audio);
    iframe.setAttribute("data-videocut-edl-audio-id", audio.id);
    iframe.setAttribute("data-videocut-edl-audio-play", "playing");
    iframe.setAttribute("data-videocut-edl-user-activation", "active");

    expect(disposePreviewEdlAudio(iframe)).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(audio.hasAttribute("src")).toBe(false);
    expect(audio.isConnected).toBe(false);
    expect(iframe.hasAttribute("data-videocut-edl-audio-id")).toBe(false);
    expect(iframe.hasAttribute("data-videocut-edl-audio-play")).toBe(false);
    expect(iframe.hasAttribute("data-videocut-edl-user-activation")).toBe(false);

    expect(disposePreviewEdlAudio(iframe)).toBe(false);
    expect(pause).toHaveBeenCalledTimes(1);
    iframe.remove();
  });

  it("releases the old parent audio when an iframe reload replaces its association", async () => {
    const iframe = document.createElement("iframe");
    const firstAudio = document.createElement("audio");
    const secondAudio = document.createElement("audio");
    firstAudio.id = "videocut-edl-audio-before-reload";
    secondAudio.id = "videocut-edl-audio-after-reload";
    firstAudio.pause = vi.fn();
    firstAudio.load = vi.fn();
    secondAudio.pause = vi.fn();
    secondAudio.load = vi.fn();
    document.body.append(iframe, firstAudio, secondAudio);
    iframe.setAttribute("data-videocut-edl-audio-id", firstAudio.id);
    const cleanup = installPreviewEdlAudioCleanup(iframe);

    iframe.setAttribute("data-videocut-edl-audio-id", secondAudio.id);
    await vi.waitFor(() => expect(firstAudio.isConnected).toBe(false));

    expect(secondAudio.isConnected).toBe(true);
    cleanup();
    expect(secondAudio.isConnected).toBe(false);
    iframe.remove();
  });

  it("releases parent audio when the custom player host is removed abnormally", async () => {
    const playerHost = document.createElement("div");
    const iframe = document.createElement("iframe");
    const audio = document.createElement("audio");
    audio.id = "videocut-edl-audio-detached-host";
    audio.pause = vi.fn();
    audio.load = vi.fn();
    playerHost.appendChild(iframe);
    document.body.append(playerHost, audio);
    iframe.setAttribute("data-videocut-edl-audio-id", audio.id);
    const cleanup = installPreviewEdlAudioCleanup(iframe, playerHost);

    playerHost.remove();
    await vi.waitFor(() => expect(audio.isConnected).toBe(false));

    cleanup();
  });
});

describe("setPreviewPlaybackRate", () => {
  it("forwards rate changes to an explicit Studio extension adapter", () => {
    const iframe = document.createElement("iframe");
    const setPlaybackRate = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { __studioPlaybackAdapter: { setPlaybackRate } },
    });

    setPreviewPlaybackRate(iframe, 2);

    expect(setPlaybackRate).toHaveBeenCalledWith(2);
  });
});
