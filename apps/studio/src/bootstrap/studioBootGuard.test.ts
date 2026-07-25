// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const guardSource = readFileSync(
  resolve(process.cwd(), "public/studio-boot-guard.js"),
  "utf8",
);

type GuardWindow = Window & {
  __CHENGFENG_STUDIO_BOOT__?: {
    markReady(): void;
    reloadOnce(reason: string): Promise<boolean>;
    dispose(): void;
    getState(): { ready: boolean; state: string };
  };
  __CHENGFENG_STUDIO_NAVIGATE__?: (url: string) => void;
};

function installGuard() {
  document.documentElement.removeAttribute("data-studio-ready");
  document.body.innerHTML = `
    <div id="studio-boot-guard" data-state="loading">
      <strong id="studio-boot-status"></strong>
      <p id="studio-boot-detail"></p>
      <button id="studio-boot-reload" hidden></button>
    </div>
    <div id="root"></div>
  `;
  window.eval(guardSource);
  return (window as GuardWindow).__CHENGFENG_STUDIO_BOOT__!;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  (window as GuardWindow).__CHENGFENG_STUDIO_BOOT__?.dispose();
  delete (window as GuardWindow).__CHENGFENG_STUDIO_BOOT__;
  delete (window as GuardWindow).__CHENGFENG_STUDIO_NAVIGATE__;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }))));
});

describe("Studio boot guard", () => {
  it("hides the startup shell when Studio mounts", () => {
    const guard = installGuard();
    guard.markReady();

    expect(guard.getState()).toEqual({ ready: true, state: "loading" });
    expect(document.getElementById("studio-boot-guard")?.hidden).toBe(true);
    expect(document.documentElement.dataset.studioReady).toBe("true");
  });

  it("reloads once when the React root stays empty", async () => {
    const navigations: string[] = [];
    (window as GuardWindow).__CHENGFENG_STUDIO_NAVIGATE__ = (url) => navigations.push(url);
    installGuard();

    await vi.advanceTimersByTimeAsync(12_000);

    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toContain("studio-recovery-reason=mount-timeout");
  });

  it("stops an automatic reload loop and shows a recovery action", async () => {
    const navigations: string[] = [];
    (window as GuardWindow).__CHENGFENG_STUDIO_NAVIGATE__ = (url) => navigations.push(url);
    const guard = installGuard();

    expect(await guard.reloadOnce("first-failure")).toBe(true);
    expect(await guard.reloadOnce("second-failure")).toBe(false);

    expect(navigations).toHaveLength(1);
    expect(document.getElementById("studio-boot-guard")?.dataset.state).toBe("error");
    expect(document.getElementById("studio-boot-reload")?.hidden).toBe(false);
  });

  it("recovers a stale Vite chunk after a preload error", async () => {
    const navigations: string[] = [];
    (window as GuardWindow).__CHENGFENG_STUDIO_NAVIGATE__ = (url) => navigations.push(url);
    installGuard();

    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    await vi.runAllTimersAsync();

    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toContain("studio-recovery-reason=asset-version-mismatch");
  });
});
