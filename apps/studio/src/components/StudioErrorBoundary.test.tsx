// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioErrorBoundary } from "./StudioErrorBoundary";

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
});
