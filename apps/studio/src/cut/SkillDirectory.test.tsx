// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SKILL_DIRECTORY } from "@video-workbench/contracts";
import { SkillDirectory } from "./SkillDirectory";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("loads only the local read-only directory, and drafts rather than installs", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => SKILL_DIRECTORY }));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const close = vi.fn();
  await act(async () => { root.render(<SkillDirectory onClose={close} />); });
  expect(host.querySelectorAll("article")).toHaveLength(7);
  expect(host.textContent).toContain("独立 Skill");
  expect(host.textContent).toContain("尚未公开发行");
  expect(host.textContent).not.toContain("小黑动画目前包含在画面 Skill 内");
  expect(host.textContent).toContain("不代表当前安装版本");
  act(() => host.querySelector<HTMLButtonElement>("article button")!.click());
  expect(host.querySelector("textarea")!.value).toContain("等我确认");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/skills");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭 Skills 能力"]')!.click());
  expect(close).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
it("fails visibly instead of claiming missing metadata is installed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(<SkillDirectory onClose={vi.fn()} />); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("未执行安装");
  expect(host.querySelectorAll("article")).toHaveLength(0);
  act(() => root.unmount());
});
