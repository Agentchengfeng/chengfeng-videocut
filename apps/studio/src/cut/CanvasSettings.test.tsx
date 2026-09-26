// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasSettings } from "./CanvasSettings";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
const value = (ratio = "16:9", rev = "a") => ({ projectRevision: rev.repeat(64), config: { aspectRatio: ratio } });
const reply = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
function setup() { const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const saved = vi.fn();
  act(() => root.render(<CanvasSettings projectId="test" onSaved={saved} />)); return { host, root, saved }; }
function button(host: HTMLElement, label: string) { return [...host.querySelectorAll("button")].find(b => b.textContent === label)!; }
function edit(host: HTMLElement, ratio: string) { const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, ratio);
  input.dispatchEvent(new Event("input", { bubbles: true })); }
it("reads before applying custom aspect and submits exactly the reviewed revision", async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => reply(value())).mockImplementationOnce(() => reply(value("4:5", "b")));
  vi.stubGlobal("fetch", fetcher); const { host, root, saved } = setup();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => button(host, "画布比例").click());
  expect(host.querySelectorAll("option")).toHaveLength(6);
  act(() => edit(host, "4:5"));
  await act(async () => { button(host, "应用画布").click(); button(host, "应用画布").click(); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ confirmed: true, expectedRevision: "a".repeat(64), config: { aspectRatio: "4:5" } });
  expect(saved).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("已保存 4:5");
  act(() => edit(host, "1:1")); expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => root.unmount());
});
it("blocks invalid ratios, and after conflict requires a fresh read instead of replay", async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => reply(value())).mockImplementationOnce(() => reply({ error: { code: "revision_conflict" } }, 409));
  vi.stubGlobal("fetch", fetcher); const { host, root, saved } = setup();
  await act(async () => button(host, "画布比例").click()); act(() => edit(host, "0:5"));
  await act(async () => button(host, "应用画布").click()); expect(fetcher).toHaveBeenCalledTimes(1);
  act(() => edit(host, "9:16")); await act(async () => button(host, "应用画布").click());
  expect(host.textContent).toContain("不会自动覆盖"); expect(button(host, "应用画布").disabled).toBe(true);
  expect(saved).not.toHaveBeenCalled(); act(() => root.unmount());
});
it("ignores previous project reads after switching projects", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const { host, root, saved } = setup(); await act(async () => button(host, "画布比例").click());
  act(() => root.render(<CanvasSettings projectId="other" onSaved={saved} />));
  await act(async () => finish(new Response(JSON.stringify(value()))));
  expect(host.querySelector("input")).toBeNull(); expect(saved).not.toHaveBeenCalled(); act(() => root.unmount());
});
