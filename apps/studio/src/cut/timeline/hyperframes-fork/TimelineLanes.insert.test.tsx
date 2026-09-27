// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineLanes } from "./TimelineLanes";
import { defaultTimelineTheme } from "./timelineTheme";

afterEach(() => { document.body.replaceChildren(); });

describe("inserted clip rows", () => {
  it("leave pointer seeking to the timeline and jump to the clip start only from the keyboard", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onInsertClipClick = vi.fn();
    const root = createRoot(host);
    act(() => root.render(
      <TimelineLanes
        segments={[]}
        insertClips={[{ id: "insert-i1", label: "i1 · 对比", start: 10, duration: 5, active: false }]}
        onInsertClipClick={onInsertClipClick}
        pixelsPerSecond={10}
        displayContentWidth={1000}
        trackRef={{ current: null }}
        theme={defaultTimelineTheme}
        onSegmentHover={() => {}}
        onSegmentPointerDown={() => {}}
        onSegmentClick={() => {}}
        onSegmentFocus={() => {}}
        onSegmentResizeStart={() => {}}
      />,
    ));
    const clip = host.querySelector<HTMLButtonElement>('.cf-cut-insert-clip.is-video')!;
    act(() => clip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onInsertClipClick).not.toHaveBeenCalled();
    act(() => clip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(onInsertClipClick).toHaveBeenCalledWith("insert-i1");
    act(() => root.unmount());
  });
});
