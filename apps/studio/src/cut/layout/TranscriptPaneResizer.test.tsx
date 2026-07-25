// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampTranscriptWidth,
  TranscriptPaneResizer,
  TRANSCRIPT_WIDTH_DEFAULT,
  TRANSCRIPT_WIDTH_STORAGE_KEY,
  transcriptWidthBounds,
} from "./TranscriptPaneResizer";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let resizeObserverCallback: ResizeObserverCallback | null = null;
const originalResizeObserver = globalThis.ResizeObserver;

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe() {}

  disconnect() {}
}

function pointer(type: string, init: PointerEventInit): Event {
  const event = typeof PointerEvent === "function"
    ? new PointerEvent(type, { ...init, isPrimary: init.isPrimary ?? true })
    : new MouseEvent(type, init);
  if (!("pointerId" in event)) {
    Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
    Object.defineProperty(event, "isPrimary", { value: init.isPrimary ?? true });
  }
  return event;
}

function Harness({ width = 1000 }: { width?: number }) {
  const workspaceRef = useRef<HTMLElement>(null);
  const [paneWidth, setPaneWidth] = useState(TRANSCRIPT_WIDTH_DEFAULT);
  const [resizing, setResizing] = useState(false);
  return (
    <section
      data-testid="workspace"
      data-width={paneWidth}
      data-resizing={resizing ? "true" : "false"}
      ref={(element) => {
        (workspaceRef as { current: HTMLElement | null }).current = element;
        if (element) {
          element.style.paddingLeft = "1px";
          element.style.paddingRight = "1px";
          Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({
            x: 100,
            y: 0,
            top: 0,
            left: 100,
            right: 100 + width,
            bottom: 500,
            width,
            height: 500,
            toJSON: () => ({}),
          }) });
        }
      }}
    >
      <TranscriptPaneResizer
        workspaceRef={workspaceRef}
        onWidthChange={setPaneWidth}
        onResizingChange={setResizing}
      />
    </section>
  );
}

function renderHarness(width = 1000): {
  host: HTMLDivElement;
  root: Root;
  separator: HTMLDivElement;
  workspace: HTMLElement;
  rerender: (nextWidth: number) => void;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Harness width={width} />));
  const separator = host.querySelector<HTMLDivElement>("[data-testid='transcript-width-resizer']");
  const workspace = host.querySelector<HTMLElement>("[data-testid='workspace']");
  if (!separator || !workspace) throw new Error("Expected width-resizer harness");
  Object.assign(separator, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  return {
    host,
    root,
    separator,
    workspace,
    rerender: (nextWidth) => act(() => root.render(<Harness width={nextWidth} />)),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resizeObserverCallback = null;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalResizeObserver;
});

describe("TranscriptPaneResizer", () => {
  it("uses desktop default and clamps the Player-safe maximum", () => {
    expect(clampTranscriptWidth(999, 1000)).toBe(480);
    expect(clampTranscriptWidth(1, 1000)).toBe(280);
    expect(transcriptWidthBounds(960)).toEqual({ min: 280, max: 475 });
    expect(transcriptWidthBounds(961)).toEqual({ min: 280, max: 476 });
    expect(transcriptWidthBounds(970)).toEqual({ min: 280, max: 480 });
    const { root, separator, workspace } = renderHarness();
    expect(separator.getAttribute("role")).toBe("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuemin")).toBe("280");
    expect(separator.getAttribute("aria-valuemax")).toBe("480");
    expect(separator.getAttribute("aria-valuenow")).toBe("320");
    expect(workspace.getAttribute("data-width")).toBe("320");
    act(() => root.unmount());
  });

  it("captures primary pointer drag and persists only on pointerup", () => {
    const { root, separator, workspace } = renderHarness();
    act(() => separator.dispatchEvent(pointer("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 7,
      clientX: 420,
    })));
    expect(workspace.getAttribute("data-resizing")).toBe("true");
    act(() => separator.dispatchEvent(pointer("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      clientX: 440,
    })));
    expect(separator.getAttribute("aria-valuenow")).toBe("340");
    expect(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY)).toBeNull();
    act(() => separator.dispatchEvent(pointer("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      clientX: 440,
    })));
    expect(workspace.getAttribute("data-resizing")).toBe("false");
    expect(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY)).toBe("340");
    act(() => root.unmount());
  });

  it("rolls back a cancelled drag without persisting", () => {
    const { root, separator, workspace } = renderHarness();
    act(() => separator.dispatchEvent(pointer("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 8,
      clientX: 420,
    })));
    act(() => separator.dispatchEvent(pointer("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 8,
      clientX: 500,
    })));
    expect(separator.getAttribute("aria-valuenow")).toBe("400");
    act(() => separator.dispatchEvent(pointer("pointercancel", {
      bubbles: true,
      pointerId: 8,
    })));
    expect(workspace.getAttribute("data-resizing")).toBe("false");
    expect(separator.getAttribute("aria-valuenow")).toBe("320");
    expect(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY)).toBeNull();
    act(() => root.unmount());
  });

  it("rolls back lost pointer capture, window Escape, and blur without persisting", () => {
    const { root, separator, workspace } = renderHarness();
    const start = (pointerId: number) => act(() => separator.dispatchEvent(pointer("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId,
      clientX: 420,
    })));
    const move = (pointerId: number) => act(() => separator.dispatchEvent(pointer("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId,
      clientX: 460,
    })));

    start(9);
    move(9);
    act(() => separator.dispatchEvent(pointer("lostpointercapture", { bubbles: true, pointerId: 9 })));
    expect(separator.getAttribute("aria-valuenow")).toBe("320");
    expect(workspace.getAttribute("data-resizing")).toBe("false");

    start(10);
    move(10);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("320");
    expect(workspace.getAttribute("data-resizing")).toBe("false");

    start(11);
    move(11);
    act(() => window.dispatchEvent(new Event("blur")));
    expect(separator.getAttribute("aria-valuenow")).toBe("320");
    expect(workspace.getAttribute("data-resizing")).toBe("false");
    expect(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY)).toBeNull();
    act(() => root.unmount());
  });

  it("reclamps on workspace ResizeObserver without persisting and treats corrupt storage as default", () => {
    window.localStorage.setItem(TRANSCRIPT_WIDTH_STORAGE_KEY, "not-a-width");
    const corrupt = renderHarness();
    expect(corrupt.separator.getAttribute("aria-valuenow")).toBe("320");
    act(() => corrupt.root.unmount());

    window.localStorage.setItem(TRANSCRIPT_WIDTH_STORAGE_KEY, "480");
    const { root, separator, workspace, rerender } = renderHarness(1000);
    expect(separator.getAttribute("aria-valuenow")).toBe("480");
    rerender(960);
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));
    expect(separator.getAttribute("aria-valuemax")).toBe("475");
    expect(separator.getAttribute("aria-valuenow")).toBe("475");
    expect(workspace.getAttribute("data-width")).toBe("475");
    expect(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY)).toBe("480");
    act(() => root.unmount());
  });

  it("supports keyboard width changes and complete separator ARIA", () => {
    const { root, separator } = renderHarness();
    const press = (key: string) => act(() => separator.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    })));
    press("ArrowRight");
    expect(separator.getAttribute("aria-valuenow")).toBe("336");
    press("PageUp");
    expect(separator.getAttribute("aria-valuenow")).toBe("384");
    press("End");
    expect(separator.getAttribute("aria-valuenow")).toBe("480");
    press("Home");
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    expect(separator.getAttribute("aria-valuetext")).toBe("文稿宽度 280 像素");
    expect(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY)).toBe("280");
    act(() => root.unmount());
  });
});
