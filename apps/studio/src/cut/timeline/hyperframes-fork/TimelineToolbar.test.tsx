// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineToolbar, type TimelineToolbarProps } from "./TimelineToolbar";
import { getNextTimelineZoomPercent } from "./timelineZoom";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const roots: Root[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

function setup(overrides: Partial<TimelineToolbarProps> = {}) {
  const props: TimelineToolbarProps = {
    canUndo: true, onUndo: vi.fn(), onSelectTool: vi.fn(),
    snappingEnabled: true, onSnappingEnabledChange: vi.fn(),
    canSplit: true, onSplit: vi.fn(), canDelete: true, onDelete: vi.fn(),
    zoomMode: "manual", manualZoomPercent: 100,
    onZoomModeChange: vi.fn(), onManualZoomPercentChange: vi.fn(),
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<TimelineToolbar {...props} />));
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  return { host, props, button };
}

describe("responsive timeline toolbar", () => {
  it("omits the restriction entry when no multi-source notice is supplied", () => {
    expect(setup().host.querySelector("details")).toBeNull();
  });

  it("keeps the complete notice in native details without intercepting edit keys", () => {
    const editingNotice = "波形与缩略图待生成；分割、删除暂不支持撤销，并会清空当前撤销记录。";
    const { host, props } = setup({ editingNotice });
    const details = host.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    expect(summary.textContent).toBe("不可撤销");
    expect(summary.getAttribute("aria-label")).toBe("多源编辑限制：分割、删除不可撤销");
    expect(details.textContent).toContain(editingNotice);
    expect(details.open).toBe(false);
    act(() => summary.click());
    expect(details.open).toBe(true);
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    try {
      const key = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true });
      summary.dispatchEvent(key);
      expect(listener).toHaveBeenCalledOnce();
      expect(key.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", listener);
    }
    act(() => summary.click());
    expect(details.open).toBe(false);
    expect(props.onSplit).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it("preserves every named action in its wrapping group", () => {
    const { host } = setup();
    expect([...host.querySelectorAll(".cf-hf-timeline-toolbar__edit button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["撤销上一次编辑", "选择工具", "切换时间线吸附", "在播放头拆分", "删除片段"]);
    expect([...host.querySelectorAll(".cf-hf-timeline-toolbar__zoom button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["适应时间线宽度", "缩小时间线", "放大时间线"]);
    expect(host.querySelector('input[aria-label="时间线缩放"]')).not.toBeNull();
  });

  it("retains editing, snapping and logarithmic zoom handlers", () => {
    const { props, button } = setup();
    act(() => {
      for (const label of ["撤销上一次编辑", "选择工具", "切换时间线吸附", "在播放头拆分", "删除片段", "适应时间线宽度", "缩小时间线", "放大时间线"]) button(label).click();
    });
    expect(props.onUndo).toHaveBeenCalledOnce();
    expect(props.onSelectTool).toHaveBeenCalledOnce();
    expect(props.onSnappingEnabledChange).toHaveBeenCalledWith(false);
    expect(props.onSplit).toHaveBeenCalledOnce();
    expect(props.onDelete).toHaveBeenCalledOnce();
    expect(props.onZoomModeChange).toHaveBeenNthCalledWith(1, "fit");
    expect(props.onManualZoomPercentChange).toHaveBeenNthCalledWith(1, getNextTimelineZoomPercent("out", "manual", 100));
    expect(props.onManualZoomPercentChange).toHaveBeenNthCalledWith(2, getNextTimelineZoomPercent("in", "manual", 100));
  });

  it("keeps unavailable edit actions disabled", () => {
    const { props, button } = setup({ canUndo: false, canSplit: false, canDelete: false });
    act(() => {
      for (const label of ["撤销上一次编辑", "在播放头拆分", "删除片段"]) {
        expect(button(label).disabled).toBe(true);
        button(label).click();
      }
    });
    expect(props.onUndo).not.toHaveBeenCalled();
    expect(props.onSplit).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("declares pane-driven wrapping without hiding or vertically shrinking actions", () => {
    // DOM emulators do not perform flex layout; real viewport QA is separate.
    const css = readFileSync(resolve(process.cwd(), "src/cut/timeline/hyperframes-fork/TimelineToolbar.css"), "utf8");
    expect(css).toMatch(/\.cf-hf-timeline-toolbar\s*\{[^}]*flex-shrink:\s*0/);
    expect(css).toMatch(/\.cf-hf-timeline-toolbar__row\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/input\[type="range"\]\s*\{[^}]*min-width:\s*56px/);
    expect(css).not.toMatch(/display:\s*none|visibility:\s*hidden|overflow:\s*hidden/);
    expect(css).toMatch(/\.cf-hf-timeline-toolbar__notice-body\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.cf-hf-timeline-toolbar__notice-body\s*\{[^}]*max-height:/);
    expect(css).toMatch(/\.cf-hf-timeline-toolbar__notice-body\s*\{[^}]*overflow:\s*auto/);
  });
});
