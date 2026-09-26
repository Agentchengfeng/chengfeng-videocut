import { expect, test } from "bun:test";
import { renderOverlayPage } from "./overlayPage";
import type { ExportPlan } from "@video-workbench/core";
import { runInNewContext } from "node:vm";

test("new modules require their own matching success; error/no-ack fail, legacy autoack survives", async () => {
  for (const mode of ["success", "error", "timeout", "spoof", "legacy"] as const) {
    const animation = { clock: "local0", authoredDuration: 2, canvas: "project", issues: [], wordCues: [] };
    const plan = { source: { width: 100, height: 100 }, output: { width: 100, height: 100 }, subtitleStyle: null,
      subtitleCues: [], layers: [{ layerId: "new", module: "new.html", start: 0, end: 2, duration: 2, cues: [], zoom: null,
        ...(mode === "legacy" ? {} : { animation }) }] } as unknown as ExportPlan;
    const html = renderOverlayPage(plan, "http://localhost/");
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const parentListeners: Array<(event: unknown) => void> = [], childListeners: Array<(event: unknown) => void> = [];
    const child = { addEventListener: (_: string, fn: (event: unknown) => void) => childListeners.push(fn),
      postMessage: (data: { token: number }) => {
        childListeners.forEach(fn => fn({ data }));
        if (mode !== "timeout" && mode !== "legacy") parentListeners.forEach(fn => fn({ source: mode === "spoof" ? {} : child,
          data: { type: mode === "error" ? "videocut:seek-error" : "videocut:seek-applied", token: data.token, message: "broken anchor" } }));
      } };
    const frame = { dataset: { layer: "new" }, style: {}, contentWindow: child, contentDocument: { readyState: "complete" } };
    const win: Record<string, any> = { addEventListener: (_: string, fn: (event: unknown) => void) => parentListeners.push(fn) };
    let now = 0;
    runInNewContext(script, { window: win, document: { getElementById: () => ({ style: {} }), querySelectorAll: () => [frame] },
      performance: { now: () => now += 6000 }, setTimeout: (fn: () => void) => fn() });
    if (mode === "success" || mode === "legacy") expect(await win.__seek(0.5)).toBe(1);
    else await expect(win.__seek(0.5)).rejects.toThrow(mode === "error" ? "broken anchor" : "did not answer");
  }
});

test("overlay carries local0 identity and uses separate source/project rectangles", () => {
  const animation = { clock: "local0" as const, authoredDuration: 2, canvas: "project" as const,
    issues: [], wordCues: [{ id: "w1", text: "关键词", start: 0, end: 1 }] };
  const plan = {
    source: { width: 1920, height: 1080 }, output: { width: 1080, height: 1920 }, subtitleStyle: null,
    subtitleCues: [], layers: [
      { layerId: "new", module: "new.html", start: 8, end: 10, duration: 2, cues: [], zoom: null, animation },
      { layerId: "legacy", module: "old.html", start: 10, end: 12, duration: 2, cues: [], zoom: null },
    ],
  } as unknown as ExportPlan;
  const html = renderOverlayPage(plan, "http://localhost/");
  expect(html).toContain('data-layer="new" src="http://localhost/new.html" scrolling');
  expect(html).toContain('data-layer="legacy" src="http://localhost/old.html" style="width:1080px;height:607.5px;left:0px;top:656.25px"');
  expect(html).toContain(JSON.stringify(animation));
  expect(html).toContain("time: Math.max(0, time - layer.start)");
  expect(html).toContain("wordCues: layer.animation.wordCues");
});
