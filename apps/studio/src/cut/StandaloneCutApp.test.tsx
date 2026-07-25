// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const cutWorkspaceSpy = vi.hoisted(() => vi.fn());

vi.mock("./CutWorkspace", () => ({
  CutWorkspace: (props: {
    projectId: string;
    initialTimelineTime: number;
  }) => {
    cutWorkspaceSpy(props);
    return <section data-testid="cut-workspace" />;
  },
}));

import { StandaloneCutApp } from "./StandaloneCutApp";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  cutWorkspaceSpy.mockClear();
});

describe("StandaloneCutApp transcript layout route", () => {
  it("has no permanent Header tablist, return action, or fake status placeholder", () => {
    window.history.replaceState(
      null,
      "",
      "/?view=koubo&workspace=cuts#project/demo?v=1&t=12&tab=design&rc=0",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<StandaloneCutApp />));

    expect(host.querySelector('.cf-cut-header [role="tablist"]')).toBeNull();
    expect(cutWorkspaceSpy).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "demo",
      initialTimelineTime: 12,
    }));
    expect(cutWorkspaceSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty("onClose");
    expect(host.querySelector('[aria-label="关闭文稿编辑"]')).toBeNull();
    expect(host.querySelector('button[aria-label="返回预览"]')).toBeNull();
    expect(host.querySelector(".cf-cut-header")?.textContent).not.toContain("剪口播工作区");
    expect(host.querySelector("[data-single-track-operations]")?.getAttribute(
      "data-single-track-operations",
    )).toBe("move,trim,split,delete,restore,delete-range,restore-snapshot");

    act(() => root.unmount());
  });
});
