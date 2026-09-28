// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useProjectVisuals, type ProjectVisuals } from "./useProjectVisuals";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks(); });
function setup() {
  const requests: ((r: Response) => void)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => requests.push(resolve)));
  vi.spyOn(globalThis, "setInterval").mockReturnValue(1 as never);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const host = document.createElement("div");
  const root = createRoot(host);
  let state!: ProjectVisuals;
  function Probe({ id }: { id: string }) { state = useProjectVisuals(id); return null; }
  const render = (id: string) => act(() => root.render(<Probe id={id} />));
  cleanups.push(() => act(() => root.unmount()));
  render("a");
  const reply = async (index: number, revision: string, status = 200) => {
    await act(async () => { requests[index]!(new Response(JSON.stringify({ revision, document: { layers: [], projectId: revision }, timings: [] }), { status })); });
  };
  return { get state() { return state; }, render, reply };
}
test("late old response cannot overwrite a newer visual update", async () => {
  const h = setup(); let reload!: Promise<void>;
  act(() => { reload = h.state.reload(); });
  await h.reply(1, "new"); await reload;
  await h.reply(0, "old");
  expect(h.state.document?.projectId).toBe("new");
});
test("old project request cannot repopulate the next project", async () => {
  const h = setup(); h.render("b");
  await h.reply(1, "b"); await h.reply(0, "a");
  expect(h.state.document?.projectId).toBe("b");
});
test("failed update preserves picture and a successful retry clears error", async () => {
  const h = setup(); await h.reply(0, "a");
  act(() => { void h.state.reload(); }); await h.reply(1, "bad", 500);
  expect(h.state.document?.projectId).toBe("a"); expect(h.state.error).toContain("500");
  act(() => { void h.state.reload(); }); await h.reply(2, "new");
  expect(h.state.error).toBeNull(); expect(h.state.document?.projectId).toBe("new");
});
test("a swapped inserted clip of the same length replaces the picture without a reload", async () => {
  const requests: ((r: Response) => void)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => requests.push(resolve)));
  vi.spyOn(globalThis, "setInterval").mockReturnValue(1 as never);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const root = createRoot(document.createElement("div"));
  let state!: ProjectVisuals;
  function Probe() { state = useProjectVisuals("p"); return null; }
  act(() => root.render(<Probe />));
  cleanups.push(() => act(() => root.unmount()));
  const layer = (assetId: string, label: string) => ({ layerId: "insert:hook", start: 0, end: 16, duration: 16, label,
    media: { assetId, sourceIn: 0, sourceOut: 16, fit: "contain", muted: true } });
  const reply = async (i: number, assetId: string, label: string) => act(async () => {
    requests[i]!(new Response(JSON.stringify({ revision: "same", document: null, timings: [], insertLayers: [layer(assetId, label)] })));
  });
  await reply(0, "a".repeat(64), "旧开头");
  act(() => { void state.reload(); }); await reply(1, "b".repeat(64), "新开头");
  expect(state.insertLayers[0]!.media.assetId).toBe("b".repeat(64));
  expect(state.insertLayers[0]!.label).toBe("新开头");
});
