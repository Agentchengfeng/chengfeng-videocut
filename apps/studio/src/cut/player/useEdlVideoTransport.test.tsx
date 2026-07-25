// @vitest-environment happy-dom

import React, { StrictMode, act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditListDocument, EditListSegment } from "@video-workbench/core";
import {
  resolveEdlMediaPlaybackRate,
  useEdlVideoTransport,
  type EdlVideoTransport,
} from "./useEdlVideoTransport";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const baseRevision = "a".repeat(64);
const nextRevision = "b".repeat(64);

function segment(
  id: string,
  sourceStart: number,
  sourceEnd: number,
  timelineStart: number,
  playbackRate = 1,
): EditListSegment {
  return {
    id,
    source: "input/source.mp4",
    sourceStart,
    sourceEnd,
    timelineStart,
    trackId: "a-roll",
    playbackRate,
  };
}

function editList(segments: EditListSegment[]): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "transport-hook-fixture",
    sourceDuration: 20,
    baseCutsRevision: baseRevision,
    baseTranscriptRevision: baseRevision,
    mode: "manual",
    duration: segments.reduce(
      (duration, item) => duration + (item.sourceEnd - item.sourceStart) / item.playbackRate,
      0,
    ),
    segments,
  };
}

const uncutDocument = editList([segment("whole", 0, 20, 0)]);
const cutDocument = editList([
  segment("a", 0, 4, 0),
  segment("b", 8, 12, 4),
  segment("c", 15, 20, 8),
]);
const withoutTailDocument = editList([
  segment("a", 0, 4, 0),
  segment("b", 8, 12, 4),
]);

type TransportInput = Parameters<typeof useEdlVideoTransport>[0];

function Harness({
  input,
  onValue,
}: {
  input: TransportInput;
  onValue: (value: EdlVideoTransport) => void;
}): ReactElement {
  const value = useEdlVideoTransport(input);
  useEffect(() => onValue(value), [onValue, value]);
  return <video ref={value.videoRef} src={input.sourceUrl ?? undefined} />;
}

interface MediaHarness {
  video: HTMLVideoElement;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  setCurrentTime: (time: number) => void;
  completeSeek: (time: number) => void;
  loadedMetadata: () => void;
}

function installMediaHarness(video: HTMLVideoElement): MediaHarness {
  let currentTime = 0;
  let paused = true;
  let seeking = false;
  const play = vi.fn(async () => {
    paused = false;
    video.dispatchEvent(new Event("play"));
  });
  const pause = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event("pause"));
  });
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => 1 },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        seeking = true;
      },
    },
    paused: { configurable: true, get: () => paused },
    seeking: { configurable: true, get: () => seeking },
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
    load: { configurable: true, value: vi.fn() },
  });
  return {
    video,
    play,
    pause,
    setCurrentTime: (time) => {
      currentTime = time;
    },
    completeSeek: (time) => {
      currentTime = time;
      seeking = false;
      video.dispatchEvent(new Event("seeked"));
    },
    loadedMetadata: () => video.dispatchEvent(new Event("loadedmetadata")),
  };
}

function renderTransport(initialInput: TransportInput, strict = false): {
  root: Root;
  host: HTMLDivElement;
  api: () => EdlVideoTransport;
  rerender: (input: TransportInput) => void;
} {
  let value: EdlVideoTransport | null = null;
  const onValue = (next: EdlVideoTransport) => {
    value = next;
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const renderHarness = (input: TransportInput) => (
    <Harness input={input} onValue={onValue} />
  );
  act(() => root.render(
    strict ? <StrictMode>{renderHarness(initialInput)}</StrictMode> : renderHarness(initialInput),
  ));
  return {
    root,
    host,
    api: () => {
      if (!value) throw new Error("transport hook did not publish its API");
      return value;
    },
    rerender: (input) => {
      act(() => root.render(
        strict ? <StrictMode>{renderHarness(input)}</StrictMode> : renderHarness(input),
      ));
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useEdlVideoTransport revision handling", () => {
  it("preserves the React-owned media source through a StrictMode cleanup cycle", () => {
    const rendered = renderTransport({
      document: uncutDocument,
      revision: baseRevision,
      sourceUrl: "/source.mp4",
      initialTimelineTime: 3,
    }, true);
    const video = rendered.host.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/source.mp4");

    const media = installMediaHarness(video);
    act(() => media.loadedMetadata());
    expect(media.video.currentTime).toBe(3);

    act(() => rendered.root.unmount());
  });

  it("ignores a seeked event from the previous EDL revision", () => {
    const rendered = renderTransport({
      document: uncutDocument,
      revision: baseRevision,
      sourceUrl: "/source.mp4",
      initialTimelineTime: 6,
    });
    const media = installMediaHarness(rendered.host.querySelector("video")!);

    act(() => media.loadedMetadata());
    expect(media.video.currentTime).toBe(6);
    expect(rendered.api().isSeeking).toBe(true);

    rendered.rerender({
      document: cutDocument,
      revision: nextRevision,
      sourceUrl: "/source.mp4",
      initialTimelineTime: 6,
    });
    expect(rendered.api().timelineTime).toBe(4);
    expect(media.video.currentTime).toBe(8);
    expect(rendered.api().isSeeking).toBe(true);

    act(() => media.completeSeek(6));
    expect(rendered.api().isSeeking).toBe(true);

    act(() => media.completeSeek(8));
    expect(rendered.api().isSeeking).toBe(false);
    expect(rendered.api().timelineTime).toBe(4);

    act(() => rendered.root.unmount());
  });

  it("stops at the new endpoint when a playing tail is deleted", async () => {
    const rendered = renderTransport({
      document: uncutDocument,
      revision: baseRevision,
      sourceUrl: "/source.mp4",
      initialTimelineTime: 18,
    });
    const media = installMediaHarness(rendered.host.querySelector("video")!);

    act(() => media.loadedMetadata());
    act(() => media.completeSeek(18));
    await act(async () => rendered.api().play());
    expect(rendered.api().isPlaying).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(1);

    rendered.rerender({
      document: withoutTailDocument,
      revision: nextRevision,
      sourceUrl: "/source.mp4",
      initialTimelineTime: 18,
    });
    expect(rendered.api().timelineTime).toBe(withoutTailDocument.duration);
    expect(rendered.api().isPlaying).toBe(false);
    expect(media.video.currentTime).toBe(12);

    act(() => media.completeSeek(12));
    expect(rendered.api().isPlaying).toBe(false);
    expect(media.play).toHaveBeenCalledTimes(1);

    act(() => {
      media.setCurrentTime(18);
      media.video.dispatchEvent(new Event("play"));
    });
    expect(rendered.api().isPlaying).toBe(false);
    expect(media.pause).toHaveBeenCalled();

    act(() => rendered.root.unmount());
  });

  it("pauses across an EDL boundary and resumes only after the retained frame is seeked", async () => {
    const rendered = renderTransport({
      document: cutDocument,
      revision: baseRevision,
      sourceUrl: "/source.mp4",
      initialTimelineTime: 3.9,
    });
    const media = installMediaHarness(rendered.host.querySelector("video")!);

    act(() => media.loadedMetadata());
    act(() => media.completeSeek(3.9));
    await act(async () => rendered.api().play());
    expect(rendered.api().isPlaying).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(1);

    act(() => {
      media.setCurrentTime(4);
      media.video.dispatchEvent(new Event("timeupdate"));
    });
    expect(media.video.currentTime).toBe(8);
    expect(rendered.api().timelineTime).toBe(4);
    expect(rendered.api().isSeeking).toBe(true);
    expect(rendered.api().isPlaying).toBe(false);
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(media.play).toHaveBeenCalledTimes(1);

    await act(async () => {
      media.completeSeek(8);
      await Promise.resolve();
    });
    expect(rendered.api().isSeeking).toBe(false);
    expect(rendered.api().isPlaying).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(media.pause.mock.invocationCallOrder[0]).toBeLessThan(
      media.play.mock.invocationCallOrder[1],
    );

    act(() => rendered.root.unmount());
  });

  it("combines user speed with the active EDL segment speed", () => {
    expect(resolveEdlMediaPlaybackRate(1.5, 2)).toBe(3);
    expect(resolveEdlMediaPlaybackRate(1.5, 0.5)).toBe(0.75);
  });
});
