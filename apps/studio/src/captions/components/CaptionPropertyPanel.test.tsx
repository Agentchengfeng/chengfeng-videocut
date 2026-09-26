// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { CaptionPropertyPanel } from "./CaptionPropertyPanel";
import { useCaptionStore } from "../store";
import { buildCaptionModel } from "../parser";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  useCaptionStore.getState().reset();
});

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CaptionPropertyPanel iframeRef={{ current: null }} />));
  disposals.push(() => { act(() => root.unmount()); host.remove(); });
  return host;
}

function expectNotice(host: HTMLElement) {
  const notices = host.querySelectorAll('[role="note"]');
  expect(notices).toHaveLength(1);
  expect(notices[0].textContent).toBe(
    "实验编辑：逐词样式与时间修改仅保存为编辑草稿（面板、时间条）；预览画面与导出暂不应用这些修改。组级修改暂不支持保存。",
  );
  expect(notices[0].parentElement).toBe(host.firstElementChild);
}

test("empty selection keeps all draft-only boundaries visible", () => {
  const host = mount();
  expectNotice(host);
  expect(host.textContent).toContain("Select caption words");
});

test("word selection, animation tab, group selection and clearing retain the notice", () => {
  const store = useCaptionStore.getState();
  const model = buildCaptionModel([{ id: "w1", text: "字幕", start: 1, end: 2 }], {
    width: 1920, height: 1080, duration: 3,
  });
  store.setModel(model);
  store.selectSegment("segment-0");
  const host = mount();
  expectNotice(host);
  expect(host.textContent).toContain("1 word");
  const animation = [...host.querySelectorAll("button")].find((button) => button.textContent === "Animation");
  expect(animation).toBeDefined();
  act(() => animation!.click());
  expectNotice(host);
  act(() => store.selectGroup(model.groupOrder[0]));
  expectNotice(host);
  act(() => store.clearSelection());
  expectNotice(host);
  expect(host.textContent).toContain("Select caption words");
});
