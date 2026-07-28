// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  applyEditListOperation,
  type EditListDocument,
  type EditListOperation,
} from "@video-workbench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEditListState } from "../../components/useProjectEditList";

const visualHarness = vi.hoisted(() => ({
  audio: vi.fn(),
  video: vi.fn(),
}));

vi.mock("./CutVideoFilmstrip", () => ({
  CutVideoFilmstrip: (props: unknown) => {
    visualHarness.video(props);
    return <div data-testid="video-filmstrip" aria-hidden="true" />;
  },
}));

vi.mock("./CutAudioWaveform", () => ({
  CutAudioWaveform: (props: unknown) => {
    visualHarness.audio(props);
    return <div data-testid="audio-waveform" aria-hidden="true" />;
  },
}));

import { CutTimeline } from "./CutTimeline";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const revision = "a".repeat(64);

function editListFixture(firstEnd = 4): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "timeline-interaction",
    sourceDuration: 10,
    baseCutsRevision: revision,
    baseTranscriptRevision: revision,
    mode: "cuts-derived",
    duration: 10,
    segments: [
      {
        id: "a-roll-0001",
        source: "input/source.mp4",
        sourceStart: 0,
        sourceEnd: firstEnd,
        timelineStart: 0,
        trackId: "a-roll",
        playbackRate: 1,
      },
      {
        id: "a-roll-0002",
        source: "input/source.mp4",
        sourceStart: firstEnd,
        sourceEnd: 10,
        timelineStart: firstEnd,
        trackId: "a-roll",
        playbackRate: 1,
      },
    ],
  };
}

function subpixelEditListFixture(): EditListDocument {
  return {
    ...editListFixture(),
    segments: [
      {
        id: "short-a",
        source: "input/source.mp4",
        sourceStart: 0,
        sourceEnd: 0.001,
        timelineStart: 0,
        trackId: "a-roll",
        playbackRate: 1,
      },
      {
        id: "short-b",
        source: "input/source.mp4",
        sourceStart: 0.001,
        sourceEnd: 0.002,
        timelineStart: 0.001,
        trackId: "a-roll",
        playbackRate: 1,
      },
      {
        id: "remainder",
        source: "input/source.mp4",
        sourceStart: 0.002,
        sourceEnd: 10,
        timelineStart: 0.002,
        trackId: "a-roll",
        playbackRate: 1,
      },
    ],
  };
}

function stateFixture(
  document: EditListDocument,
  patchOperation = vi.fn(async (_operation: EditListOperation) => document),
): ProjectEditListState {
  return {
    projectId: document.projectId,
    document,
    revision,
    loading: false,
    ready: true,
    saveState: "idle",
    reload: vi.fn(async () => true),
    patchOperation,
    canUndo: false,
    undoLastEditListChange: vi.fn(async () => undefined),
  };
}

function pointerEvent(
  type: string,
  options: { clientX: number; clientY?: number; pointerId?: number; bubbles?: boolean },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: options.bubbles ?? true,
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY ?? 0,
    pointerId: options.pointerId ?? 1,
  });
}

function mockAnimationFrames(): { flush: () => void } {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    flush: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}

function renderTimeline(editList: ProjectEditListState): {
  host: HTMLDivElement;
  root: Root;
  onSeek: ReturnType<typeof vi.fn>;
  onUndo: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSeek = vi.fn();
  const onUndo = vi.fn();
  act(() => root.render(
    <CutTimeline
      projectId={editList.document?.projectId ?? "timeline-interaction"}
      editList={editList}
      timelineTime={0}
      onSeek={onSeek}
      canUndo={editList.canUndo}
      onUndo={onUndo}
    />,
  ));
  const track = host.querySelector<HTMLElement>(".cf-cut-track");
  if (!track) throw new Error("Expected timeline track");
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 720,
    bottom: 60,
    left: 0,
    width: 720,
    height: 60,
    toJSON: () => ({}),
  });
  return { host, root, onSeek, onUndo };
}

function timelineCanvas(host: HTMLElement): HTMLElement {
  const canvas = host.querySelector<HTMLElement>(
    '[data-hyperframes-timeline-fork="canvas"]',
  );
  if (!canvas) throw new Error("Expected Product-owned HyperFrames timeline canvas");
  return canvas;
}

function timelinePixelsPerSecond(host: HTMLElement): number {
  const pixelsPerSecond = Number(timelineCanvas(host).dataset.pixelsPerSecond);
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
    throw new Error(`Expected a positive runtime pps, received ${pixelsPerSecond}`);
  }
  return pixelsPerSecond;
}

function segmentGeometry(host: HTMLElement, segmentId: string): {
  element: HTMLElement;
  left: number;
  width: number;
} {
  const element = host.querySelector<HTMLElement>(
    `[data-edl-segment-id="${segmentId}"]`,
  );
  if (!element) throw new Error(`Expected timeline segment ${segmentId}`);
  return {
    element,
    left: Number.parseFloat(element.style.left),
    width: Number.parseFloat(element.style.width),
  };
}

function setSnapping(host: HTMLElement, enabled: boolean): void {
  const button = host.querySelector<HTMLButtonElement>(
    'button[aria-label="切换时间线吸附"]',
  );
  if (!button) throw new Error("Expected HyperFrames snapping control");
  if ((button.getAttribute("aria-pressed") === "true") !== enabled) {
    act(() => button.click());
  }
}

afterEach(() => {
  document.body.replaceChildren();
  visualHarness.audio.mockReset();
  visualHarness.video.mockReset();
  vi.restoreAllMocks();
});

describe("CutTimeline HyperFrames-style trim interaction", () => {
  it("exposes global undo in the Timeline toolbar and maps Cmd/Ctrl+Z to the same action", () => {
    const editList = {
      ...stateFixture(editListFixture()),
      canUndo: true,
    };
    const rendered = renderTimeline(editList);
    const undo = rendered.host.querySelector<HTMLButtonElement>(
      'button[aria-label="撤销上一次编辑"]',
    );
    expect(undo).not.toBeNull();
    expect(undo?.disabled).toBe(false);

    act(() => undo?.click());
    expect(rendered.onUndo).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
      }));
    });
    expect(rendered.onUndo).toHaveBeenCalledTimes(2);

    act(() => rendered.root.unmount());
  });

  it("keeps adjacent sub-pixel groups on exact half-open timeline geometry", () => {
    const rendered = renderTimeline(stateFixture(subpixelEditListFixture()));
    const pixelsPerSecond = timelinePixelsPerSecond(rendered.host);
    const groups = [...rendered.host.querySelectorAll<HTMLElement>("[data-edl-segment-id]")];
    const geometry = groups.map((group) => ({
      id: group.dataset.edlSegmentId,
      left: Number(group.dataset.logicalLeft),
      width: Number(group.dataset.logicalWidth),
      visualWidth: Number.parseFloat(group.style.width),
      minWidth: group.style.minWidth,
      borderInlineWidth: group.style.borderInlineWidth,
    }));

    for (const { width } of geometry.slice(0, 2)) {
      expect(width).toBeCloseTo(0.001 * pixelsPerSecond, 12);
    }
    // Logical half-open geometry remains exact while the official HyperFrames
    // 4px visual minimum is also the clip's hitbox (no sub-pixel wrapper around
    // a larger overflowing child).
    expect(geometry[0]!.left + geometry[0]!.width).toBeCloseTo(geometry[1]!.left, 5);
    expect(geometry[1]!.left + geometry[1]!.width).toBeCloseTo(geometry[2]!.left, 5);
    expect(geometry.every(({ visualWidth }) => visualWidth >= 4)).toBe(true);
    expect(geometry.every(({ minWidth }) => minWidth === "4px")).toBe(true);
    expect(
      geometry.every(({ borderInlineWidth }) =>
        borderInlineWidth === "0" || borderInlineWidth === "0px"
      ),
    ).toBe(true);

    for (let index = 1; index < geometry.length; index += 1) {
      const previousEnd = geometry[index - 1]!.left + geometry[index - 1]!.width;
      expect(Math.abs(previousEnd - geometry[index]!.left)).toBeLessThanOrEqual(0.0000011);
    }

    const logicalSegments = subpixelEditListFixture().segments;
    for (let index = 1; index < logicalSegments.length; index += 1) {
      const boundary = logicalSegments[index]!.timelineStart;
      const owners = logicalSegments.filter((segment) => {
        const duration = (segment.sourceEnd - segment.sourceStart) / segment.playbackRate;
        return boundary >= segment.timelineStart && boundary < segment.timelineStart + duration;
      });
      expect(owners.map(({ id }) => id)).toEqual([logicalSegments[index]!.id]);
    }

    act(() => rendered.root.unmount());
  });

  it("projects every linked A/V segment into one editable group, under three lanes", () => {
    const patchOperation = vi.fn(async (_operation: EditListOperation) => editListFixture());
    const rendered = renderTimeline(stateFixture(editListFixture(), patchOperation));
    const timeline = rendered.host.querySelector<HTMLElement>("[data-linked-av-tracks='true']");
    const groups = Array.from(
      rendered.host.querySelectorAll<HTMLElement>("[data-edl-segment-id]"),
    );

    expect(timeline?.getAttribute("aria-label")).toBe("视频与原声联动时间线");
    const canvas = timelineCanvas(rendered.host);
    expect(canvas.dataset.gutterWidth).toBe("32");
    expect(canvas.dataset.leftPadding).toBe("48");
    expect(canvas.dataset.rulerHeight).toBe("24");
    expect(canvas.dataset.topPadding).toBe("50");
    expect(canvas.dataset.trackHeight).toBe("48");
    expect(canvas.dataset.bottomPadding).toBe("72");
    // Three rows now: video, audio, and the visual layers drawn over them.
    // 24 ruler + 50 top pad + 3×48 tracks + 72 bottom pad.
    expect(canvas.style.height).toBe("290px");
    expect(rendered.host.querySelector("[data-hyperframes-timeline-lane='visual']")).not.toBeNull();
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const segmentId = group.dataset.edlSegmentId;
      const linkedAudio = rendered.host.querySelector<HTMLElement>(
        `[data-linked-segment-id="${segmentId}"]`,
      );
      expect(group.dataset.avLinked).toBe("true");
      expect(group.getAttribute("role")).toBe("option");
      expect(group.getAttribute("aria-selected")).toBe("false");
      expect(group.dataset.trackLane).toBe("video");
      expect(linkedAudio?.dataset.trackLane).toBe("audio");
      expect(linkedAudio?.dataset.avLinked).toBe("true");
      expect(group.querySelectorAll('[data-testid="video-filmstrip"]')).toHaveLength(1);
      expect(linkedAudio?.querySelectorAll('[data-testid="audio-waveform"]')).toHaveLength(1);
    }
    expect(rendered.host.querySelectorAll("audio")).toHaveLength(0);
    expect(patchOperation).not.toHaveBeenCalled();

    const lanes = Array.from(
      rendered.host.querySelectorAll<HTMLElement>("[data-hyperframes-timeline-lane]"),
    );
    expect(lanes.map((lane) => lane.dataset.hyperframesTimelineLane)).toEqual([
      "video",
      "audio",
      "visual",
    ]);
    expect(lanes.map((lane) => lane.style.height)).toEqual(["48px", "48px", "48px"]);

    const gutter = lanes[0]?.firstElementChild as HTMLElement | null;
    const leftPad = lanes[0]?.children[1] as HTMLElement | undefined;
    const track = rendered.host.querySelector<HTMLElement>(".cf-cut-track");
    if (!gutter) throw new Error("Expected fixed lane labels");
    expect(gutter.getAttribute("aria-label")).toBe("视频轨");
    expect(gutter.style.width).toBe("32px");
    expect(leftPad?.style.width).toBe("48px");
    expect(lanes[1]?.firstElementChild?.getAttribute("aria-label")).toBe("原声轨");
    expect(track?.getAttribute("role")).toBe("listbox");
    expect(track?.getAttribute("aria-orientation")).toBe("horizontal");
    act(() => gutter.dispatchEvent(pointerEvent("pointerdown", { clientX: -1 })));
    expect(rendered.onSeek).not.toHaveBeenCalled();

    act(() => rendered.root.unmount());
  });

  it("keeps ruler and screen-reader duration equal to the EDL even with physical empty canvas", () => {
    const document = editListFixture();
    const rendered = renderTimeline(stateFixture(document));
    const track = rendered.host.querySelector<HTMLElement>(".cf-cut-track.is-video");
    if (!track) throw new Error("Expected video track");

    const pixelsPerSecond = timelinePixelsPerSecond(rendered.host);
    expect(Number.parseFloat(track.style.width)).toBeGreaterThan(document.duration * pixelsPerSecond);
    expect(rendered.host.textContent).toContain("时间线从 00:00 到 10.00 秒");
    expect(rendered.host.textContent).toContain("00:10");
    expect(rendered.host.textContent).not.toContain("01:00");

    act(() => track.dispatchEvent(pointerEvent("pointerdown", {
      clientX: Number.parseFloat(track.style.width),
      pointerId: 55,
    })));
    expect(rendered.onSeek).toHaveBeenLastCalledWith(document.duration);

    act(() => window.dispatchEvent(pointerEvent("pointercancel", {
      clientX: Number.parseFloat(track.style.width),
      pointerId: 55,
    })));
    act(() => rendered.root.unmount());
  });

  it("does not delete or split while a native toolbar control owns focus", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    const first = rendered.host.querySelector<HTMLElement>(
      '[data-edl-segment-id="a-roll-0001"]',
    );
    const fit = rendered.host.querySelector<HTMLButtonElement>(".cf-cut-fit-button");
    if (!first || !fit) throw new Error("Expected clip and Timeline toolbar");

    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100 })));
    act(() => fit.focus());
    act(() => fit.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Backspace",
    })));
    act(() => fit.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "s",
    })));

    expect(patchOperation).not.toHaveBeenCalled();
    act(() => rendered.root.unmount());
  });

  it("scrubs the official playhead through the one Product seek callback", () => {
    const rendered = renderTimeline(stateFixture(editListFixture()));
    const track = rendered.host.querySelector<HTMLElement>(".cf-cut-track.is-video");
    const playhead = rendered.host.querySelector<HTMLElement>(
      '[data-hyperframes-timeline-playhead="true"]',
    );
    if (!track || !playhead) throw new Error("Expected timeline track and playhead");

    act(() => track.dispatchEvent(pointerEvent("pointerdown", {
      clientX: 120,
      pointerId: 31,
    })));
    expect(rendered.onSeek).toHaveBeenCalledTimes(1);
    expect(playhead.dataset.scrubbing).toBe("true");

    act(() => window.dispatchEvent(pointerEvent("pointermove", {
      clientX: 180,
      pointerId: 31,
    })));
    act(() => window.dispatchEvent(pointerEvent("pointerup", {
      clientX: 240,
      pointerId: 31,
    })));
    expect(rendered.onSeek).toHaveBeenCalledTimes(3);
    expect(playhead.dataset.scrubbing).toBeUndefined();

    act(() => rendered.root.unmount());
  });

  it("does not run destructive shortcuts when modified or repeated", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    const first = rendered.host.querySelector<HTMLElement>(
      '[data-edl-segment-id="a-roll-0001"]',
    );
    if (!first) throw new Error("Expected first clip");

    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100 })));
    for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "s",
        [modifier]: true,
      })));
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Delete",
        [modifier]: true,
      })));
    }
    for (const key of ["s", "Delete"]) {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        repeat: true,
      })));
    }

    expect(patchOperation).not.toHaveBeenCalled();
    act(() => rendered.root.unmount());
  });

  it("hides trim controls until hover or selection, including narrow clips", () => {
    const rendered = renderTimeline(stateFixture(editListFixture(0.04)));
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    if (!first) throw new Error("Expected first clip");

    expect(rendered.host.querySelectorAll(".cf-cut-trim-handle")).toHaveLength(0);

    act(() => first.dispatchEvent(pointerEvent("pointerover", { clientX: 1 })));
    expect(rendered.host.querySelectorAll(".cf-cut-trim-handle")).toHaveLength(0);

    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1 })));
    expect(first.dataset.trimHandles).toBe("visible");
    expect(first.querySelectorAll(".cf-cut-trim-handle")).toHaveLength(2);

    act(() => rendered.root.unmount());
  });

  it("previews after 2px and commits exactly once on pointer up", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    setSnapping(rendered.host, false);
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    if (!first) throw new Error("Expected first clip");
    const pixelsPerSecond = timelinePixelsPerSecond(rendered.host);
    const initialWidth = segmentGeometry(rendered.host, "a-roll-0001").width;
    const committedMediaWidth = pixelsPerSecond * 4;
    const endX = initialWidth;
    const halfSecondPx = pixelsPerSecond * 0.5;

    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const flushFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    };

    act(() => first.dispatchEvent(pointerEvent("pointerover", { clientX: 100 })));
    const initialEndHandle = first.querySelector<HTMLButtonElement>(".cf-cut-trim-handle.is-end");
    if (!initialEndHandle) throw new Error("Expected end trim handle");

    act(() => initialEndHandle.dispatchEvent(pointerEvent("pointerdown", { clientX: endX, pointerId: 7 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientX: endX + 1, pointerId: 7 })));
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientX: endX + 1, pointerId: 7 })));
    expect(patchOperation).not.toHaveBeenCalled();

    const endHandle = first.querySelector<HTMLButtonElement>(".cf-cut-trim-handle.is-end");
    if (!endHandle) throw new Error("Expected selected end trim handle");
    act(() => endHandle.dispatchEvent(pointerEvent("pointerdown", { clientX: endX, pointerId: 8 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", {
      clientX: endX - halfSecondPx,
      pointerId: 8,
    })));
    act(flushFrames);

    expect(patchOperation).not.toHaveBeenCalled();
    expect(Number.parseFloat(first.style.width)).toBeLessThan(initialWidth);
    const firstVideoProps = visualHarness.video.mock.calls
      .map(([props]) => props)
      .filter((props) => (props as { segment?: { id?: string } }).segment?.id === "a-roll-0001")
      .at(-1);
    const firstAudioProps = visualHarness.audio.mock.calls
      .map(([props]) => props)
      .filter((props) => (props as { segment?: { id?: string } }).segment?.id === "a-roll-0001")
      .at(-1);
    expect(firstVideoProps).toMatchObject({
      segment: { id: "a-roll-0001", sourceStart: 0, sourceEnd: 4 },
      segmentWidth: committedMediaWidth,
    });
    expect(firstAudioProps).toMatchObject({
      segment: { id: "a-roll-0001", sourceStart: 0, sourceEnd: 4 },
      segmentWidth: committedMediaWidth,
    });

    act(() => window.dispatchEvent(pointerEvent("pointerup", {
      clientX: endX - halfSecondPx,
      pointerId: 8,
    })));
    expect(patchOperation).toHaveBeenCalledOnce();
    expect(patchOperation).toHaveBeenCalledWith({
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart: 0,
      sourceEnd: 3.5,
    });
    act(() => first.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: endX - halfSecondPx,
    })));
    expect(rendered.onSeek).not.toHaveBeenCalled();

    act(() => rendered.root.unmount());
  });

  it("previews a start trim without rippling neighboring linked A/V groups", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    setSnapping(rendered.host, false);
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    const second = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0002"]');
    if (!first || !second) throw new Error("Expected both linked A/V groups");
    const frames = mockAnimationFrames();
    const pixelsPerSecond = timelinePixelsPerSecond(rendered.host);
    const trimDeltaPx = pixelsPerSecond * 0.5;
    const initialFirstWidth = segmentGeometry(rendered.host, "a-roll-0001").width;
    const committedMediaWidth = pixelsPerSecond * 4;
    const initialSecond = segmentGeometry(rendered.host, "a-roll-0002");

    act(() => first.dispatchEvent(pointerEvent("pointerover", { clientX: 0 })));
    const handle = first.querySelector<HTMLButtonElement>(".cf-cut-trim-handle.is-start");
    if (!handle) throw new Error("Expected start trim handle");
    act(() => handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, pointerId: 10 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", {
      clientX: trimDeltaPx,
      pointerId: 10,
    })));
    act(frames.flush);

    expect(patchOperation).not.toHaveBeenCalled();
    expect(Number.parseFloat(first.style.left)).toBeCloseTo(trimDeltaPx, 5);
    expect(Number.parseFloat(first.style.width)).toBeCloseTo(initialFirstWidth - trimDeltaPx, 5);
    expect(Number.parseFloat(second.style.left)).toBeCloseTo(initialSecond.left, 5);
    expect(Number.parseFloat(second.style.width)).toBeCloseTo(initialSecond.width, 5);

    const firstVideoProps = visualHarness.video.mock.calls
      .map(([props]) => props)
      .filter((props) => (props as { segment?: { id?: string } }).segment?.id === "a-roll-0001")
      .at(-1);
    const firstAudioProps = visualHarness.audio.mock.calls
      .map(([props]) => props)
      .filter((props) => (props as { segment?: { id?: string } }).segment?.id === "a-roll-0001")
      .at(-1);
    expect(firstVideoProps).toMatchObject({
      segment: { id: "a-roll-0001", sourceStart: 0, sourceEnd: 4 },
      segmentWidth: committedMediaWidth,
    });
    expect(firstAudioProps).toMatchObject({
      segment: { id: "a-roll-0001", sourceStart: 0, sourceEnd: 4 },
      segmentWidth: committedMediaWidth,
    });

    act(() => window.dispatchEvent(pointerEvent("pointercancel", {
      clientX: trimDeltaPx,
      pointerId: 10,
    })));
    act(() => rendered.root.unmount());
  });

  it("commits one ripple EDL trim only when a start-handle gesture ends", () => {
    const document = editListFixture();
    let persistedDocument = document;
    const patchOperation = vi.fn(async (operation: EditListOperation) => {
      persistedDocument = applyEditListOperation(document, operation);
      return persistedDocument;
    });
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    setSnapping(rendered.host, false);
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    const second = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0002"]');
    if (!first || !second) throw new Error("Expected both linked A/V groups");
    const frames = mockAnimationFrames();
    const pixelsPerSecond = timelinePixelsPerSecond(rendered.host);
    const trimDeltaPx = pixelsPerSecond * 0.5;
    const initialFirst = segmentGeometry(rendered.host, "a-roll-0001");
    const initialSecond = segmentGeometry(rendered.host, "a-roll-0002");

    act(() => first.dispatchEvent(pointerEvent("pointerover", { clientX: 0 })));
    const handle = first.querySelector<HTMLButtonElement>(".cf-cut-trim-handle.is-start");
    if (!handle) throw new Error("Expected start trim handle");
    act(() => handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, pointerId: 11 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", {
      clientX: trimDeltaPx,
      pointerId: 11,
    })));
    act(frames.flush);
    expect(patchOperation).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(pointerEvent("pointerup", {
      clientX: trimDeltaPx,
      pointerId: 11,
    })));

    expect(patchOperation).toHaveBeenCalledOnce();
    expect(patchOperation).toHaveBeenCalledWith({
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart: 0.5,
      sourceEnd: 4,
    });
    expect(persistedDocument.segments).toMatchObject([
      { id: "a-roll-0001", timelineStart: 0, sourceStart: 0.5, sourceEnd: 4 },
      { id: "a-roll-0002", timelineStart: 3.5, sourceStart: 4, sourceEnd: 10 },
    ]);
    expect(Number.parseFloat(first.style.left)).toBeCloseTo(initialFirst.left, 5);
    expect(Number.parseFloat(first.style.width)).toBeCloseTo(initialFirst.width, 5);
    expect(Number.parseFloat(second.style.left)).toBeCloseTo(initialSecond.left, 5);

    act(() => rendered.root.unmount());
  });

  it("discards a live preview on Escape", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    setSnapping(rendered.host, false);
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    if (!first) throw new Error("Expected first clip");
    const pixelsPerSecond = timelinePixelsPerSecond(rendered.host);
    const initialWidth = segmentGeometry(rendered.host, "a-roll-0001").width;
    const endX = initialWidth;
    const trimDeltaPx = pixelsPerSecond * 0.5;

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    act(() => first.dispatchEvent(pointerEvent("pointerover", { clientX: 100 })));
    const handle = first.querySelector<HTMLButtonElement>(".cf-cut-trim-handle.is-end");
    if (!handle) throw new Error("Expected end trim handle");
    act(() => handle.dispatchEvent(pointerEvent("pointerdown", { clientX: endX, pointerId: 9 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", {
      clientX: endX - trimDeltaPx,
      pointerId: 9,
    })));
    expect(Number.parseFloat(first.style.width)).toBeLessThan(initialWidth);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(patchOperation).not.toHaveBeenCalled();
    expect(Number.parseFloat(first.style.width)).toBeCloseTo(initialWidth, 5);

    act(() => rendered.root.unmount());
  });
});

describe("CutTimeline pointer move transaction", () => {
  it("keeps sub-threshold movement as a click and commits one Core magnetic move after 4px", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    if (!first) throw new Error("Expected first clip");
    const frames = mockAnimationFrames();

    expect(first.hasAttribute("draggable")).toBe(false);
    act(() => first.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, pointerId: 21 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientX: 103, pointerId: 21 })));
    act(frames.flush);
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientX: 103, pointerId: 21 })));
    expect(patchOperation).not.toHaveBeenCalled();
    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 103 })));
    expect(rendered.onSeek).toHaveBeenCalledOnce();
    rendered.onSeek.mockClear();

    act(() => first.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, pointerId: 22 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientX: 700, pointerId: 22 })));
    act(frames.flush);
    expect(
      [...rendered.host.querySelectorAll<HTMLElement>("[data-edl-segment-id]")].map(
        (clip) => clip.dataset.edlSegmentId,
      ),
    ).toEqual(["a-roll-0002", "a-roll-0001"]);
    expect(patchOperation).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientX: 700, pointerId: 22 })));
    expect(patchOperation).toHaveBeenCalledOnce();
    expect(patchOperation).toHaveBeenCalledWith({
      type: "move",
      clipId: "a-roll-0001",
      start: 10,
    });
    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 700 })));
    expect(rendered.onSeek).not.toHaveBeenCalled();
    act(frames.flush);
    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 700 })));
    expect(rendered.onSeek).toHaveBeenCalledOnce();

    act(() => rendered.root.unmount());
  });

  it("discards move preview on Escape and pointercancel without committing", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const rendered = renderTimeline(stateFixture(document, patchOperation));
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    if (!first) throw new Error("Expected first clip");
    const frames = mockAnimationFrames();

    act(() => first.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, pointerId: 31 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientX: 700, pointerId: 31 })));
    act(frames.flush);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(patchOperation).not.toHaveBeenCalled();
    expect(
      [...rendered.host.querySelectorAll<HTMLElement>("[data-edl-segment-id]")].map(
        (clip) => clip.dataset.edlSegmentId,
      ),
    ).toEqual(["a-roll-0001", "a-roll-0002"]);
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientX: 700, pointerId: 31 })));
    act(frames.flush);

    act(() => first.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, pointerId: 32 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientX: 700, pointerId: 32 })));
    act(frames.flush);
    act(() => window.dispatchEvent(pointerEvent("pointercancel", { clientX: 700, pointerId: 32 })));
    expect(patchOperation).not.toHaveBeenCalled();
    expect(
      [...rendered.host.querySelectorAll<HTMLElement>("[data-edl-segment-id]")].map(
        (clip) => clip.dataset.edlSegmentId,
      ),
    ).toEqual(["a-roll-0001", "a-roll-0002"]);

    act(() => rendered.root.unmount());
  });

  it("cancels an active move when the EDL revision changes", () => {
    const document = editListFixture();
    const patchOperation = vi.fn(async (_operation: EditListOperation) => document);
    const initialState = stateFixture(document, patchOperation);
    const rendered = renderTimeline(initialState);
    const first = rendered.host.querySelector<HTMLElement>('[data-edl-segment-id="a-roll-0001"]');
    if (!first) throw new Error("Expected first clip");
    const frames = mockAnimationFrames();

    act(() => first.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, pointerId: 41 })));
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientX: 700, pointerId: 41 })));
    act(frames.flush);
    act(() => rendered.root.render(
      <CutTimeline
        projectId={document.projectId}
        editList={{ ...initialState, revision: "b".repeat(64) }}
        timelineTime={0}
        onSeek={rendered.onSeek}
        canUndo={false}
        onUndo={rendered.onUndo}
      />,
    ));
    expect(
      [...rendered.host.querySelectorAll<HTMLElement>("[data-edl-segment-id]")].map(
        (clip) => clip.dataset.edlSegmentId,
      ),
    ).toEqual(["a-roll-0001", "a-roll-0002"]);
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientX: 700, pointerId: 41 })));
    expect(patchOperation).not.toHaveBeenCalled();

    act(() => rendered.root.unmount());
  });
});
