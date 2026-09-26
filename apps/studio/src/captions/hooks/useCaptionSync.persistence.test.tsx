// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useCaptionSync, type CaptionSyncIO } from "./useCaptionSync";
import { useCaptionStore } from "../store";
import { buildCaptionModel } from "../parser";
import { applyCaptionOverrides, parseCaptionOverrides } from "../overrides";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); useCaptionStore.getState().reset(); });
const fresh = () => buildCaptionModel([{ id: "w1", text: "原文", start: 1, end: 2 }], { width: 1920, height: 1080, duration: 3 });
const store = () => useCaptionStore.getState();
function memoryIO(initial: string | null = null) {
  let file = initial, source = "source-v1", creation = false;
  const io: CaptionSyncIO = {
    readProjectFile: vi.fn(async () => source),
    readOptionalProjectFile: vi.fn(async () => file ?? ""),
    observeProjectFileVersion: vi.fn((_path, version) => { creation = version === null; }),
    writeProjectFile: vi.fn(async (_path, content, expected) => {
      if (expected !== undefined ? expected !== file : !creation || file !== null) throw new Error("409 conflict");
      file = content;
    }),
    showToast: vi.fn(),
  };
  return { io, get file() { return file; }, change: (next: string) => { file = next; }, source: (next: string) => { source = next; } };
}
function setup(io: CaptionSyncIO) {
  store().setModel(fresh()); store().setSourceFilePath("captions.html"); store().setEditMode(true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let sync!: ReturnType<typeof useCaptionSync>;
  function Harness({ pid, io }: { pid: string; io: CaptionSyncIO }) { sync = useCaptionSync(pid, io); return null; }
  const render = (pid = "a", next = io) => act(() => root.render(<Harness pid={pid} io={next} />));
  render(); disposals.push(() => { act(() => root.unmount()); host.remove(); });
  return { get sync() { return sync; }, render };
}
const load = (h: ReturnType<typeof setup>) => act(async () => { await h.sync.loadOverrides(); });
test("real store timing/text/style save and reload use the observed content precondition", async () => {
  const mem = memoryIO(); const h = setup(mem.io); await load(h);
  store().updateSegmentTiming("segment-0", 1.2, 2.6); store().updateSegmentText("segment-0", "校对后"); store().updateSegmentStyle("segment-0", { fontSize: 58 });
  await act(async () => h.sync.save());
  expect(JSON.parse(mem.file!)[0]).toMatchObject({ wordId: "w1", text: "校对后", start: 1.2, end: 2.6, fontSize: 58 });
  store().setModel(fresh()); await load(h);
  expect(store().model!.segments.get("segment-0")).toMatchObject({ text: "校对后", start: 1.2, end: 2.6, style: { fontSize: 58 } });
});
test("800ms debounce coalesces quick changes and serializes edits during an in-flight write", async () => {
  vi.useFakeTimers(); const mem = memoryIO(); const h = setup(mem.io); await load(h);
  const original = mem.io.writeProjectFile;
  let release!: () => void; const wait = new Promise<void>(yes => { release = yes; });
  mem.io.writeProjectFile = vi.fn(async (...args) => { await wait; await original(...args); });
  store().updateSegmentTiming("segment-0", 1.1, 2.1); store().updateSegmentTiming("segment-0", 1.2, 2.2);
  await act(async () => { await vi.advanceTimersByTimeAsync(801); });
  expect(mem.io.writeProjectFile).toHaveBeenCalledTimes(1);
  store().updateSegmentTiming("segment-0", 1.3, 2.3);
  await act(async () => { release(); await h.sync.save(); });
  expect(mem.io.writeProjectFile).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mem.file!)[0].start).toBe(1.3);
});
test("conflict freezes automatic writes and shows a persistent-error toast", async () => {
  const mem = memoryIO("[]"); const h = setup(mem.io); await load(h); mem.change("external");
  store().updateSegmentStyle("segment-0", { fontSize: 72 }); await act(async () => h.sync.save());
  expect(mem.file).toBe("external"); expect(mem.io.showToast).toHaveBeenCalledWith(expect.stringContaining("409 conflict"), "error");
  store().updateSegmentTiming("segment-0", 1.2, 2.3); await act(async () => h.sync.save());
  expect(mem.io.writeProjectFile).toHaveBeenCalledTimes(1);
});
test("source-content changes reject before any override write", async () => {
  const mem = memoryIO(); const h = setup(mem.io); await load(h); mem.source("changed");
  store().updateSegmentStyle("segment-0", { fontSize: 72 }); await act(async () => h.sync.save());
  expect(mem.io.writeProjectFile).not.toHaveBeenCalled(); expect(mem.io.showToast).toHaveBeenCalledWith(expect.stringContaining("源文档已被修改"), "error");
});
test("loading cannot overwrite edits made while reads are pending", async () => {
  const mem = memoryIO(); let release!: (value: string) => void;
  mem.io.readOptionalProjectFile = vi.fn(() => new Promise(yes => { release = yes; }));
  const h = setup(mem.io); const loading = h.sync.loadOverrides();
  store().updateSegmentTiming("segment-0", 1.4, 2.8);
  await act(async () => { release("[]"); await loading; });
  expect(store().model!.segments.get("segment-0")!.start).toBe(1.4);
  expect(mem.io.showToast).toHaveBeenCalledWith(expect.stringContaining("加载期间已有新编辑"), "error");
  expect(mem.io.writeProjectFile).not.toHaveBeenCalled();
});
test("exiting edit mode flushes the captured draft without needing the live model", async () => {
  const mem = memoryIO(); const h = setup(mem.io); await load(h);
  store().updateSegmentTiming("segment-0", 1.4, 2.8);
  await act(async () => { store().setEditMode(false); store().setModel(null); await Promise.resolve(); });
  expect(JSON.parse(mem.file!)[0].start).toBe(1.4);
});
test("switching projects flushes only old-project IO and stale loads cannot apply to the new model", async () => {
  const a = memoryIO(), b = memoryIO(); const h = setup(a.io); await load(h);
  store().updateSegmentTiming("segment-0", 1.4, 2.8);
  h.render("b", b.io);
  store().setModel(fresh()); await load(h);
  expect(JSON.parse(a.file!)[0].start).toBe(1.4); expect(b.io.writeProjectFile).not.toHaveBeenCalled();
  expect(store().model!.segments.get("segment-0")!.start).toBe(1);
});
test("old style-only files remain valid and invalid timing or missing stable IDs never retarget words", () => {
  expect(applyCaptionOverrides(fresh(), [{ wordIndex: 0, fontSize: 58 }]).get("segment-0")?.style.fontSize).toBe(58);
  expect(applyCaptionOverrides(fresh(), [{ wordId: "other", wordIndex: 0, start: 0, end: 1 }]).get("segment-0")?.start).toBe(1);
  for (const [start, end] of [[NaN, 2], [1, Infinity], [-1, 2], [2, 1]]) expect(() => parseCaptionOverrides([{ wordIndex: 0, start, end }])).toThrow();
});
test("bound overrides cannot be applied to a different caption source with the same word IDs", async () => {
  const mem = memoryIO(); const h = setup(mem.io); await load(h);
  store().updateSegmentTiming("segment-0", 1.4, 2.8); await act(async () => h.sync.save());
  store().setEditMode(false); store().setModel(fresh()); store().setSourceFilePath("other-captions.html"); store().setEditMode(true);
  await load(h);
  expect(store().model!.segments.get("segment-0")!.start).toBe(1);
  expect(mem.io.showToast).toHaveBeenCalledWith(expect.stringContaining("另一源文档"), "error");
});
test("group-only edits explicitly warn and protect leaving rather than claim persistence", async () => {
  const mem = memoryIO(); const h = setup(mem.io); await load(h);
  store().updateGroupStyle("group-0", { fontSize: 72 });
  expect(mem.io.showToast).toHaveBeenCalledWith(expect.stringContaining("组级"), "error");
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true); expect(mem.io.writeProjectFile).not.toHaveBeenCalled();
});
test("a changed parsed source is rejected before binding its model", async () => {
  const mem = memoryIO(); const h = setup(mem.io);
  await act(async () => h.sync.loadOverrides("old-source-content"));
  expect(mem.io.showToast).toHaveBeenCalledWith(expect.stringContaining("解析后已变化"), "error");
  expect(mem.io.writeProjectFile).not.toHaveBeenCalled();
});
