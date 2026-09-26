// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { parseRenderCapability, useRenderCapability } from "./useRenderCapability";
import { useRenderQueue } from "./useRenderQueue";
import { RenderQueue } from "./RenderQueue";
import { CompositionsTab } from "../sidebar/CompositionsTab";
vi.mock("../../telemetry/events", () => ({ trackStudioRenderStart: vi.fn(), trackStudioEvent: vi.fn() }));
vi.mock("../../telemetry/config", () => ({ getAnonymousId: () => "test" }));
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const capability = (enabled: boolean) => ({ genericHtmlRender: { schemaVersion: 1, enabled, source: enabled ? "vite-producer-adapter" : "production-studio-adapter", reason: enabled ? "开发导出可用" : "请使用既有确认门控的产品导出流程。" } });
function mount(element: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  return { root, host };
}
test("missing, malformed and unknown-version capabilities fail closed", () => {
  for (const value of [null, {}, { genericHtmlRender: { enabled: true } }, { genericHtmlRender: { ...capability(true).genericHtmlRender, schemaVersion: 2 } }]) expect(parseRenderCapability(value).enabled).toBe(false);
  expect(parseRenderCapability(capability(false))).toMatchObject({ enabled: false, source: "production-studio-adapter" });
  expect(parseRenderCapability(capability(true)).enabled).toBe(true);
});
test.each(["disabled", "unknown", "network"])("programmatic %s start sends no POST and creates no failed job", async (mode) => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/api/health")) {
      if (mode === "network") throw new Error("offline");
      return Response.json(mode === "disabled" ? capability(false) : {});
    }
    return Response.json({ renders: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  let queue!: ReturnType<typeof useRenderQueue>;
  function Harness() { queue = useRenderQueue("test"); return null; }
  mount(<Harness />);
  await act(async () => { await queue.startRender({}); });
  expect(fetcher.mock.calls.every(call => !String(call[0]).endsWith("/render"))).toBe(true);
  expect(queue.jobs).toEqual([]);
  expect(queue.actionError).toBeTruthy();
});
test("allowed start posts once, but a changed host capability is rechecked before the next POST", async () => {
  let allowed = true;
  const fetcher = vi.fn(async (url: RequestInfo | URL) => Response.json(String(url).endsWith("/api/health") ? capability(allowed) : String(url).endsWith("/render") ? { jobId: "job-1" } : { renders: [] }));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  let queue!: ReturnType<typeof useRenderQueue>;
  function Harness() { queue = useRenderQueue("test"); return null; }
  mount(<Harness />);
  await act(async () => { await queue.startRender({}); });
  expect(queue.jobs).toHaveLength(1);
  allowed = false;
  await act(async () => { await queue.startRender({}); });
  expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith("/render"))).toHaveLength(1);
  expect(queue.jobs).toHaveLength(1);
  expect(queue.renderCapability.enabled).toBe(false);
});
test("changing origin immediately invalidates enablement and late old-host replies cannot restore it", async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).startsWith("http://old.test") ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(Response.json(capability(false)))));
  let result!: ReturnType<typeof useRenderCapability>;
  function Harness({ origin }: { origin: string }) { result = useRenderCapability("p", origin); return null; }
  const h = mount(<Harness origin="http://old.test" />);
  expect(result.capability.enabled).toBe(false);
  await act(async () => { h.root.render(<Harness origin="http://new.test" />); });
  await act(async () => { release(Response.json(capability(true))); });
  expect(result.capability.enabled).toBe(false);
  expect(result.capability.source).toBe("production-studio-adapter");
});
test("queue export button is disabled with a visible Chinese reason and does not invoke start", () => {
  const start = vi.fn();
  const h = mount(<RenderQueue jobs={[]} projectId="test" onDelete={vi.fn()} onClearCompleted={vi.fn()} onStartRender={start} isRendering={false} renderDisabledReason="请使用既有确认门控的产品导出流程。" />);
  const button = [...h.host.querySelectorAll("button")].find(button => button.textContent === "Export")!;
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(start).not.toHaveBeenCalled();
  expect(h.host.textContent).toContain("请使用既有确认门控");
});
test.each([true, false])("composition render controls honor enabled=%s without invoking disabled callbacks", (enabled) => {
  const start = vi.fn();
  const h = mount(<CompositionsTab projectId="test" compositions={["scene.html"]} activeComposition="scene.html" onSelect={vi.fn()} onRenderComposition={start} renderDisabledReason={enabled ? undefined : "通用 HTML 导出不可用"} />);
  const button = h.host.querySelector<HTMLButtonElement>('button[aria-label="Render scene"]')!;
  expect(button).not.toBeNull();
  expect(button.disabled).toBe(!enabled);
  act(() => button.click());
  expect(start).toHaveBeenCalledTimes(enabled ? 1 : 0);
});
