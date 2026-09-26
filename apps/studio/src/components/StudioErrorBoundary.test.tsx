// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioErrorBoundary } from "./StudioErrorBoundary";
import type { StudioBootGuard } from "../bootstrap/studioBootGuard";

type RecoveryWindow = Window & {
  __CHENGFENG_STUDIO_BOOT__?: {
    markReady(): void;
    reloadOnce(reason: string): Promise<boolean>;
    forceReload(reason?: string): Promise<boolean>;
    showFailure(title: string, message: string): void;
    dispose(): void;
    getState(): { ready: boolean; state: string };
  };
};

let host: HTMLDivElement;
let root: Root;

function BrokenPanel(): never {
  throw new Error("render failed");
}

function installGuard(forceReload: StudioBootGuard["forceReload"]) {
  (window as RecoveryWindow).__CHENGFENG_STUDIO_BOOT__ = {
    markReady: vi.fn(), reloadOnce: vi.fn(async () => true), forceReload,
    showFailure: vi.fn(), dispose: vi.fn(), getState: () => ({ ready: true, state: "ready" }),
  };
}

async function renderBroken() {
  await act(async () => root.render(<StudioErrorBoundary><BrokenPanel /></StudioErrorBoundary>));
}

function reloadButton() {
  return Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("载入"))!;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as RecoveryWindow).__CHENGFENG_STUDIO_BOOT__;
  vi.restoreAllMocks();
});

describe("StudioErrorBoundary", () => {
  it("renders a visible Chinese recovery screen instead of an empty root", async () => {
    await act(async () => {
      root.render(
        <StudioErrorBoundary>
          <BrokenPanel />
        </StudioErrorBoundary>,
      );
    });

    expect(host.textContent).toContain("工作台遇到了问题");
    expect(host.textContent).toContain("重新载入工作台");
    expect(host.querySelector('[data-studio-recovery="react-error"]')).not.toBeNull();
  });

  it("uses the boot guard for a version-safe manual reload", async () => {
    const forceReload = vi.fn(async () => true);
    (window as RecoveryWindow).__CHENGFENG_STUDIO_BOOT__ = {
      markReady: vi.fn(),
      reloadOnce: vi.fn(async () => true),
      forceReload,
      showFailure: vi.fn(),
      dispose: vi.fn(),
      getState: () => ({ ready: true, state: "ready" }),
    };
    await act(async () => {
      root.render(
        <StudioErrorBoundary>
          <BrokenPanel />
        </StudioErrorBoundary>,
      );
    });

    const button = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "重新载入工作台",
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());

    expect(forceReload).toHaveBeenCalledWith("react-error");
  });

  it("does not reload automatically and leaves healthy children alone", async () => {
    const forceReload = vi.fn(async () => true);
    installGuard(forceReload);
    await act(async () => root.render(<StudioErrorBoundary><p>正常预览</p></StudioErrorBoundary>));
    expect(host.textContent).toBe("正常预览");
    await renderBroken();
    expect(forceReload).not.toHaveBeenCalled();
  });

  it.each(["unreachable", "rejected"])("shows a retryable failure when recovery is %s", async (failure) => {
    const forceReload = vi.fn(async () => {
      if (failure === "rejected") throw new Error("offline");
      return false;
    });
    installGuard(forceReload);
    await renderBroken();
    await act(async () => reloadButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("本地服务");
    expect(reloadButton().disabled).toBe(false);
    expect(forceReload).toHaveBeenCalledTimes(1);
    await act(async () => reloadButton().click());
    expect(forceReload).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated clicks while manual recovery is pending", async () => {
    let resolve!: (value: boolean) => void;
    const forceReload = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    installGuard(forceReload);
    await renderBroken();
    await act(async () => { reloadButton().click(); reloadButton().click(); });
    expect(forceReload).toHaveBeenCalledTimes(1);
    expect(reloadButton().disabled).toBe(true);
    await act(async () => resolve(false));
    expect(reloadButton().disabled).toBe(false);
  });

  it("falls back to a normal manual reload if the boot guard is unavailable", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await renderBroken();
    await act(async () => reloadButton().click());
    expect(reload).toHaveBeenCalledOnce();
  });

  it("can retry a transient render error without navigation", async () => {
    let broken = true;
    function Panel() { if (broken) throw new Error("temporary"); return <p>已恢复</p>; }
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await act(async () => root.render(<StudioErrorBoundary><Panel /></StudioErrorBoundary>));
    broken = false;
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "重试当前界面")!.click());
    expect(host.textContent).toBe("已恢复");
    expect(reload).not.toHaveBeenCalled();
  });

  it("still reports recovery rejection after StrictMode remount", async () => {
    installGuard(vi.fn(async () => false));
    await act(async () => root.render(<StrictMode><StudioErrorBoundary><BrokenPanel /></StudioErrorBoundary></StrictMode>));
    await act(async () => reloadButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("本地服务");
    expect(reloadButton().disabled).toBe(false);
  });

  it("does not overwrite a replacement screen when pending recovery settles after unmount", async () => {
    let resolve!: (value: boolean) => void;
    installGuard(() => new Promise<boolean>(done => { resolve = done; }));
    await renderBroken();
    await act(async () => reloadButton().click());
    await act(async () => root.render(<p>新界面</p>));
    await act(async () => resolve(false));
    expect(host.textContent).toBe("新界面");
  });
});
