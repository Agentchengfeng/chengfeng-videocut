// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditListSegment } from "@video-workbench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CutAudioWaveform } from "./CutAudioWaveform";
import { CutVideoFilmstrip } from "./CutVideoFilmstrip";
import {
  buildTimelineFrameUrl,
  buildTimelineWaveformUrl,
  requestTimelineFrameBlob,
  requestTimelineWaveformPeaks,
  resetTimelineMediaCachesForTests,
  normalizeTimelineWaveform,
  resampleTimelineWaveform,
  timelineFrameCount,
  timelineFrameTimes,
  timelineFrameWidthBucket,
  waveformSvgPath,
} from "./timelineMedia";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function segmentFixture(overrides: Partial<EditListSegment> = {}): EditListSegment {
  return {
    id: "a-roll-0001",
    source: "input/源 文件.mp4",
    sourceStart: 10,
    sourceEnd: 20,
    timelineStart: 0,
    trackId: "a-roll",
    playbackRate: 1,
    ...overrides,
  };
}

function render(element: React.ReactNode): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  resetTimelineMediaCachesForTests();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("timeline media URL and sampling contract", () => {
  it("requests at least one frame for every positive-width clip and caps filmstrip requests at four frames", () => {
    const segment = segmentFixture();
    expect(timelineFrameCount(0)).toBe(0);
    expect(timelineFrameCount(1)).toBe(1);
    expect(timelineFrameCount(35.99)).toBe(1);
    expect(timelineFrameCount(224)).toBe(2);
    expect(timelineFrameCount(10_000)).toBe(4);
    expect(timelineFrameTimes(segment, 30, 4)).toEqual([11.25, 13.75, 16.25, 18.75]);
  });

  it("builds the Product frame and waveform endpoints without losing Chinese paths", () => {
    const frameUrl = buildTimelineFrameUrl({
      projectId: "项目 one",
      source: "input/源 文件.mp4",
      time: 12.34567,
      width: 240.4,
    });
    expect(frameUrl).toBe(
      "/api/v1/projects/%E9%A1%B9%E7%9B%AE%20one/media/frame?source=input%2F%E6%BA%90+%E6%96%87%E4%BB%B6.mp4&time=12.346&width=320",
    );
    expect(buildTimelineWaveformUrl("项目 one", "input/源 文件.mp4")).toBe(
      "/api/v1/projects/%E9%A1%B9%E7%9B%AE%20one/media/waveform?source=input%2F%E6%BA%90+%E6%96%87%E4%BB%B6.mp4",
    );
    expect([1, 96, 97, 240.1, 481, 999].map(timelineFrameWidthBucket))
      .toEqual([96, 96, 160, 320, 640, 640]);
  });

  it("windows and pixel-resamples real peaks before creating an SVG path", () => {
    const peaks = [0, 0.1, 0.2, 0.3, 0.8, 0.5, 0.4, 0.3, 0.2, 0.1];
    const sampled = resampleTimelineWaveform({
      peaks,
      sourceStart: 4,
      sourceEnd: 8,
      sourceDuration: 10,
      pixelWidth: 12,
    });
    expect(sampled).toEqual([0.8, 0.5, 0.4, 0.3]);
    expect(waveformSvgPath(sampled, 12)).toContain("M1.50");
    expect(waveformSvgPath(sampled, 12)).not.toContain("NaN");
  });

  it("normalizes low-level real peaks per source window without inventing silent activity", () => {
    const normalized = normalizeTimelineWaveform([0, 0.016, 0.04, 0.08]);
    expect(normalized).toEqual([0, 0.2, 0.5, 1]);
    expect(normalizeTimelineWaveform([0, 0, 0])).toEqual([0, 0, 0]);
    expect(waveformSvgPath(normalized, 12)).toContain("1.00");
    expect(waveformSvgPath(normalized, 12)).not.toBe(waveformSvgPath([0, 0, 0, 0], 12));
  });
});

describe("timeline frame scheduler", () => {
  it("deduplicates keys and never starts more than four frame fetches", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      releases.push(() => {
        inFlight -= 1;
        resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob(["frame"], { type: "image/jpeg" }),
        });
      });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const requests = Array.from({ length: 6 }, (_, index) =>
      requestTimelineFrameBlob(`/frame-${index}`)
    );
    expect(requestTimelineFrameBlob("/frame-0")).toBe(requests[0]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(maximumInFlight).toBe(4);

    for (const release of releases.splice(0)) release();
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(maximumInFlight).toBe(4);
    for (const release of releases.splice(0)) release();
    await Promise.all(requests);
    expect(maximumInFlight).toBe(4);
  });

  it("keeps more than 160 queued keys inflight so an early duplicate shares its Promise", async () => {
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      releases.push(() => resolve({
        ok: true,
        status: 200,
        blob: async () => new Blob(["frame"], { type: "image/jpeg" }),
      }));
    }));
    vi.stubGlobal("fetch", fetchMock);

    // Four requests run while the remaining 161 stay queued. None of those
    // unresolved keys may compete with the 160-entry resolved-Blob LRU.
    const requests = Array.from({ length: 165 }, (_, index) =>
      requestTimelineFrameBlob(`/queued-frame-${index}`)
    );
    expect(requestTimelineFrameBlob("/queued-frame-0")).toBe(requests[0]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    let drainCycles = 0;
    while (fetchMock.mock.calls.length < requests.length || releases.length > 0) {
      drainCycles += 1;
      if (drainCycles > 200) throw new Error("Frame request queue did not drain");
      for (const release of releases.splice(0)) release();
      await flushAsyncWork();
    }
    await Promise.all(requests);

    expect(fetchMock).toHaveBeenCalledTimes(165);
    await requestTimelineFrameBlob("/queued-frame-164");
    expect(fetchMock).toHaveBeenCalledTimes(165);
  });

  it("bounds the session LRU at 160 frame keys and removes failed entries", async () => {
    let failNext = false;
    const fetchMock = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        return { ok: false, status: 500, blob: async () => new Blob() };
      }
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["frame"], { type: "image/jpeg" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all(Array.from({ length: 161 }, (_, index) =>
      requestTimelineFrameBlob(`/lru-frame-${index}`)
    ));
    expect(fetchMock).toHaveBeenCalledTimes(161);

    await requestTimelineFrameBlob("/lru-frame-0");
    expect(fetchMock).toHaveBeenCalledTimes(162);
    await requestTimelineFrameBlob("/lru-frame-160");
    expect(fetchMock).toHaveBeenCalledTimes(162);

    failNext = true;
    await expect(requestTimelineFrameBlob("/recoverable-frame")).rejects.toThrow(
      "Frame request failed with 500",
    );
    await requestTimelineFrameBlob("/recoverable-frame");
    expect(fetchMock).toHaveBeenCalledTimes(164);
  });

  it("deduplicates concurrent waveform failures but permits a later retry", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "waveform_not_available" } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ peaks: [0.2, 0.8] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = requestTimelineWaveformPeaks("project", "input/source.mp4");
    expect(requestTimelineWaveformPeaks("project", "input/source.mp4")).toBe(first);
    await expect(first).rejects.toThrow();
    await expect(requestTimelineWaveformPeaks("project", "input/source.mp4"))
      .resolves.toEqual([0.2, 0.8]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("timeline visual components", () => {
  it("keeps a visible narrow clip loadable instead of suppressed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", undefined);
    const rendered = render(
      <CutVideoFilmstrip
        projectId="project"
        segment={segmentFixture()}
        segmentWidth={35}
        sourceDuration={30}
      />,
    );
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rendered.host.querySelector(".cf-cut-video-filmstrip")?.getAttribute("data-media-state"))
      .not.toBe("suppressed");
    expect(rendered.host.querySelector("video, audio")).toBeNull();
    act(() => rendered.root.unmount());
  });

  it("shows real filmstrip blobs only for the latest segment request", async () => {
    const oldBlob = new Blob(["old"], { type: "image/jpeg" });
    const newBlob = new Blob(["new"], { type: "image/jpeg" });
    let releaseOld: (() => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("old.mp4")) {
        return new Promise((resolve) => {
          releaseOld = () => resolve({ ok: true, status: 200, blob: async () => oldBlob });
        });
      }
      return Promise.resolve({ ok: true, status: 200, blob: async () => newBlob });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", undefined);
    const createObjectUrl = vi.fn((object: Blob | MediaSource) =>
      object === oldBlob ? "blob:old" : "blob:new"
    );
    const revokeObjectUrl = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectUrl);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectUrl);

    const rendered = render(
      <CutVideoFilmstrip
        projectId="project"
        segment={segmentFixture({ source: "old.mp4" })}
        segmentWidth={80}
        sourceDuration={30}
      />,
    );
    await flushAsyncWork();
    act(() => rendered.root.render(
      <CutVideoFilmstrip
        projectId="project"
        segment={segmentFixture({ source: "new.mp4" })}
        segmentWidth={80}
        sourceDuration={30}
      />,
    ));
    await flushAsyncWork();
    releaseOld?.();
    await flushAsyncWork();

    expect(rendered.host.querySelector("img")?.getAttribute("src")).toBe("blob:new");
    expect(rendered.host.querySelector("video, audio")).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalledWith(oldBlob);
    act(() => rendered.root.unmount());
  });

  it("keeps failed filmstrip slots in place instead of shifting later source times", async () => {
    let requestIndex = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      requestIndex += 1;
      if (requestIndex === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          blob: async () => new Blob(),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: async () => new Blob(["second"], { type: "image/jpeg" }),
      });
    }));
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:second");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const rendered = render(
      <CutVideoFilmstrip
        projectId="project"
        segment={segmentFixture()}
        segmentWidth={224}
        sourceDuration={30}
      />,
    );
    await flushAsyncWork();

    const slots = rendered.host.querySelectorAll("[data-frame-slot]");
    expect(slots).toHaveLength(2);
    expect(slots[0]?.getAttribute("data-frame-state")).toBe("unavailable");
    expect(slots[1]?.tagName).toBe("IMG");
    expect(slots[1]?.getAttribute("src")).toBe("blob:second");
    act(() => rendered.root.unmount());
  });

  it("shares one real waveform request and reports failure instead of drawing fake peaks", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("no-audio.mp4")) {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({ error: { code: "no_audio", message: "该视频没有原声音轨" } }),
        });
      }
      if (url.includes("broken.mp4")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ peaks: [0.1, 0.4, 0.8, 0.2] }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = "input/source.mp4";
    const first = render(
      <CutAudioWaveform
        projectId="project"
        segment={segmentFixture({ source })}
        segmentWidth={120}
        sourceDuration={30}
      />,
    );
    const second = render(
      <CutAudioWaveform
        projectId="project"
        segment={segmentFixture({ id: "a-roll-0002", source, sourceStart: 20, sourceEnd: 30 })}
        segmentWidth={120}
        sourceDuration={30}
      />,
    );
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.host.querySelector("svg path")?.getAttribute("d")).toBeTruthy();
    expect(second.host.querySelector("svg path")?.getAttribute("d")).toBeTruthy();
    expect(first.host.querySelector("video, audio")).toBeNull();

    const broken = render(
      <CutAudioWaveform
        projectId="project"
        segment={segmentFixture({ source: "broken.mp4" })}
        segmentWidth={120}
        sourceDuration={30}
      />,
    );
    await flushAsyncWork();
    expect(broken.host.textContent).toContain("波形不可用");
    expect(broken.host.querySelector("svg path")).toBeNull();

    const noAudio = render(
      <CutAudioWaveform
        projectId="project"
        segment={segmentFixture({ source: "no-audio.mp4" })}
        segmentWidth={120}
        sourceDuration={30}
      />,
    );
    await flushAsyncWork();
    expect(noAudio.host.textContent).toContain("无原声");
    expect(noAudio.host.querySelector(".cf-cut-audio-waveform")?.getAttribute("data-media-state"))
      .toBe("no-audio");
    expect(noAudio.host.textContent).not.toContain("波形不可用");

    act(() => first.root.unmount());
    act(() => second.root.unmount());
    act(() => broken.root.unmount());
    act(() => noAudio.root.unmount());
  });
});
