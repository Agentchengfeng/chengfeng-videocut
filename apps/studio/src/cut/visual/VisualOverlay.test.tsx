// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { VisualOverlay, type ActiveVisual } from "./VisualOverlay";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => vi.restoreAllMocks());
test("local0 seek carries stable word cues and invalidation is visible without replaying", () => {
  vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const host = document.createElement("div"); host.className = "cf-cut-player-stage";
  const master = document.createElement("video"); master.dataset.kouboMediaOwner = "video";
  const mount = document.createElement("div"); host.append(master, mount); document.body.append(host);
  const root = createRoot(mount);
  const layer: ActiveVisual = { layerId: "bound", src: "about:blank", start: 10, duration: 2, cues: [],
    animation: { clock: "local0", authoredDuration: 2, canvas: "project", issues: [], wordCues: [{ id: "key", text: "词", start: 0, end: 1 }] } };
  try {
    act(() => root.render(<VisualOverlay layers={[layer]} activeLayerId={null} timelineTime={0} />));
    const iframe = mount.querySelector("iframe")!;
    const send = vi.spyOn(iframe.contentWindow!, "postMessage");
    act(() => iframe.dispatchEvent(new Event("load")));
    for (const time of [10, 11.9, 10.5, 10]) {
      master.currentTime = time; act(() => master.dispatchEvent(new Event("seeked")));
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ time: time - 10, wordCues: layer.animation!.wordCues }), "*");
      const message = send.mock.calls.at(-1)![0] as { token: number };
      act(() => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: { type: "videocut:seek-applied", token: message.token } })));
    }
    send.mockClear();
    act(() => root.render(<VisualOverlay layers={[{ ...layer, animation: { ...layer.animation!, issues: ["missing_anchor"] } }]} activeLayerId="bound" timelineTime={10} />));
    expect(mount.querySelector('[role="status"]')?.textContent).toContain("missing_anchor");
    expect(iframe.style.visibility).toBe("hidden");
    expect(send).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); }
});
test.each(["error", "timeout"])("new animation %s is visible and cannot be mistaken for applied", (mode) => {
  vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const host = document.createElement("div"); host.className = "cf-cut-player-stage";
  const master = document.createElement("video"); master.dataset.kouboMediaOwner = "video";
  const mount = document.createElement("div"); host.append(master, mount); document.body.append(host);
  const root = createRoot(mount);
  const layer: ActiveVisual = { layerId: "bound", src: "about:blank", start: 0, duration: 2, cues: [],
    animation: { clock: "local0", authoredDuration: 2, canvas: "project", issues: [], wordCues: [] } };
  try {
    act(() => root.render(<VisualOverlay layers={[layer]} activeLayerId="bound" timelineTime={0} />));
    const iframe = mount.querySelector("iframe")!;
    const send = vi.spyOn(iframe.contentWindow!, "postMessage");
    act(() => iframe.dispatchEvent(new Event("load")));
    act(() => master.dispatchEvent(new Event("seeked")));
    const message = send.mock.calls.at(-1)![0] as { token: number };
    // Another window cannot acknowledge this module's request.
    act(() => window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "videocut:seek-applied", token: message.token } })));
    if (mode === "error") {
      act(() => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: { type: "videocut:seek-error", token: message.token, message: "锚点无效" } })));
    } else { now = 5001; act(() => master.dispatchEvent(new Event("seeked"))); }
    expect(mount.querySelector('[role="alert"]')?.textContent).toContain(mode === "error" ? "锚点无效" : "超时");
    expect(iframe.style.visibility).toBe("hidden");
    const count = send.mock.calls.length;
    act(() => master.dispatchEvent(new Event("seeked")));
    expect(send).toHaveBeenCalledTimes(count);
  } finally { act(() => root.unmount()); host.remove(); }
});
test("30 media layers retain only two, release old sources on rapid scrubs and preserve HTML frames", () => {
  vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const host = document.createElement("div"); host.className = "cf-cut-player-stage";
  const master = document.createElement("video"); master.dataset.kouboMediaOwner = "video";
  const mount = document.createElement("div"); host.append(master, mount); document.body.append(host);
  const root = createRoot(mount);
  const layers: ActiveVisual[] = Array.from({ length: 30 }, (_, i) => ({
    layerId: `v${i}`, src: `/v${i}.mp4`, start: i * 2, duration: 2, cues: [],
    media: { assetId: "a".repeat(64), sourceIn: 0, sourceOut: 2, fit: "contain", muted: true },
  }));
  layers.push({ layerId: "html", src: "about:blank", start: 70, duration: 2, cues: [] });
  try {
    act(() => root.render(<VisualOverlay layers={layers} activeLayerId={null} timelineTime={0} />));
    expect(mount.querySelectorAll("video")).toHaveLength(2);
    const first = mount.querySelector("video")!;
    const iframe = mount.querySelector("iframe");
    for (const time of [17, 45, 3, 58, 0]) {
      master.currentTime = time;
      act(() => master.dispatchEvent(new Event("seeked")));
      expect(mount.querySelectorAll("video").length).toBeLessThanOrEqual(2);
      expect(mount.querySelector("video")?.dataset.broll).toBe(`v${Math.floor(time / 2)}`);
      expect(mount.querySelector("iframe")).toBe(iframe);
    }
    expect(first.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); }
});

test("HTML and MP4 switch both ways from the master clock despite stale React props", () => {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(cb => { frames.set(++sequence, cb); return sequence; });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  const host = document.createElement("div"); host.className = "cf-cut-player-stage";
  const master = document.createElement("video"); master.dataset.kouboMediaOwner = "video";
  const mount = document.createElement("div"); host.append(master, mount); document.body.append(host);
  const root = createRoot(mount);
  // HTML is last in DOM, so stale visibility would cover the correct MP4.
  const layers: ActiveVisual[] = [
    { layerId: "mp4", src: "/test.mp4", start: 2, duration: 2, cues: [],
      media: { assetId: "a".repeat(64), sourceIn: 0, sourceOut: 2, fit: "contain", muted: true } },
    { layerId: "html", src: "about:blank", start: 0, duration: 2, cues: [] },
  ];
  const tick = () => act(() => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  });
  try {
    master.currentTime = 1.9;
    act(() => root.render(<VisualOverlay layers={layers} activeLayerId="html" timelineTime={1.9} />));
    const html = mount.querySelector("iframe")!;
    act(() => html.dispatchEvent(new Event("load")));
    const post = vi.spyOn(html.contentWindow!, "postMessage");
    for (const time of [2.1, 0.5, 3.9, 1.9]) {
      post.mockClear(); master.currentTime = time; tick();
      expect(html.style.visibility).toBe(time < 2 ? "visible" : "hidden");
      expect(mount.querySelector("video")?.style.visibility).toBe(time >= 2 ? "visible" : "hidden");
      if (time < 2) expect(post).toHaveBeenCalledWith(expect.objectContaining({ time }), "*");
      else expect(post).not.toHaveBeenCalled();
    }
    // Seek must synchronously arbitrate even before the next animation frame.
    master.currentTime = 2.1;
    act(() => master.dispatchEvent(new Event("seeked")));
    expect(html.style.visibility).toBe("hidden");
    master.currentTime = 1.2;
    act(() => master.dispatchEvent(new Event("seeked")));
    expect(html.style.visibility).toBe("visible");
    expect(mount.querySelector("video")?.style.visibility).toBe("hidden");
  } finally { act(() => root.unmount()); host.remove(); }
});
