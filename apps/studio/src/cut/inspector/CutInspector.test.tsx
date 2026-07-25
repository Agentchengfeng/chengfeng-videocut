// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditListDocument } from "@video-workbench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CutInspector,
  type CutInspectorEditList,
  type CutInspectorTransport,
} from "./CutInspector";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const revision = "a".repeat(64);

function documentFixture(mode: EditListDocument["mode"] = "cuts-derived"): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "inspector-contract",
    sourceDuration: 659.7,
    baseCutsRevision: revision,
    baseTranscriptRevision: revision,
    mode,
    duration: 213.1,
    segments: [
      {
        id: "a-roll-0001",
        source: "input/source.mp4",
        sourceStart: 0,
        sourceEnd: 100,
        timelineStart: 0,
        trackId: "a-roll",
        playbackRate: 1,
      },
      {
        id: "a-roll-0002",
        source: "input/source.mp4",
        sourceStart: 120,
        sourceEnd: 233.1,
        timelineStart: 100,
        trackId: "a-roll",
        playbackRate: 1,
      },
    ],
  };
}

function editListFixture(
  overrides: Partial<CutInspectorEditList> = {},
): CutInspectorEditList {
  return {
    document: documentFixture(),
    loading: false,
    ready: true,
    ...overrides,
  };
}

function transportFixture(
  overrides: Partial<CutInspectorTransport> = {},
): CutInspectorTransport {
  return {
    muted: false,
    volume: 0.8,
    playbackRate: 1,
    toggleMuted: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
    ...overrides,
  };
}

function renderInspector(
  editList: CutInspectorEditList,
  transport: CutInspectorTransport,
): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CutInspector editList={editList} transport={transport} />));
  return { host, root };
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Expected the native input value setter");
  setter.call(input, value);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CutInspector real parameter contract", () => {
  it("renders only values owned by the edit list and labels preview controls as session-only", () => {
    const rendered = renderInspector(editListFixture(), transportFixture());

    expect(rendered.host.querySelector('[data-koubo-inspector="true"]')).not.toBeNull();
    expect(rendered.host.textContent).toContain("仅影响当前预览，不写入项目或成片。");
    expect(rendered.host.textContent).toContain("文稿剪辑");
    expect(rendered.host.textContent).toContain("10:59.7");
    expect(rendered.host.textContent).toContain("03:33.1");
    expect(rendered.host.textContent).toContain("07:26.6");
    expect(rendered.host.textContent).toContain("片段数");
    expect(rendered.host.textContent).toContain("2");

    for (const unsupported of ["画幅", "分辨率", "帧率", "保存位置", "成片倍速", "片段速度"]) {
      expect(rendered.host.textContent).not.toContain(unsupported);
    }

    act(() => rendered.root.unmount());
  });

  it("forwards preview controls to the existing transport without owning another value", () => {
    const editList = editListFixture();
    const transport = transportFixture();
    const rendered = renderInspector(editList, transport);
    const mute = rendered.host.querySelector<HTMLButtonElement>('[aria-label="预览静音"]');
    const volume = rendered.host.querySelector<HTMLInputElement>('[aria-label="预览音量"]');
    const playbackRate = rendered.host.querySelector<HTMLSelectElement>(
      '[aria-label="预览倍速"]',
    );

    expect(mute).not.toBeNull();
    expect(volume).not.toBeNull();
    expect(playbackRate).not.toBeNull();

    act(() => mute?.click());
    act(() => {
      if (!volume) return;
      setNativeInputValue(volume, "0.35");
      volume.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      if (!playbackRate) return;
      playbackRate.value = "1.5";
      playbackRate.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(transport.toggleMuted).toHaveBeenCalledOnce();
    expect(transport.setVolume).toHaveBeenCalledWith(0.35);
    expect(transport.setPlaybackRate).toHaveBeenCalledWith(1.5);
    act(() => rendered.root.render(<CutInspector editList={editList} transport={transport} />));
    expect(volume?.value).toBe("0.8");
    expect(playbackRate?.value).toBe("1");

    act(() => rendered.root.unmount());
  });

  it.each([
    {
      name: "loading",
      editList: editListFixture({ document: null, loading: true, ready: false }),
      status: "正在读取剪辑信息…",
    },
    {
      name: "not ready",
      editList: editListFixture({ document: null, loading: false, ready: false }),
      status: "剪辑信息尚未就绪",
    },
  ])("disables controls and omits fake facts while $name", ({ editList, status }) => {
    const rendered = renderInspector(editList, transportFixture());
    const inspector = rendered.host.querySelector<HTMLElement>("[data-koubo-inspector]");
    const facts = rendered.host.querySelector(".cf-cut-inspector__facts");

    expect(inspector?.getAttribute("aria-busy")).toBe(String(editList.loading));
    expect(rendered.host.textContent).toContain(status);
    expect(facts).toBeNull();
    expect(rendered.host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(rendered.host.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(
      true,
    );
    expect(rendered.host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    expect(rendered.host.textContent).not.toContain("00:00.0");
    expect(rendered.host.textContent).not.toContain("0 段");

    act(() => rendered.root.unmount());
  });

  it("uses the manual-mode label without creating a writable mode control", () => {
    const editList = editListFixture({ document: documentFixture("manual") });
    const rendered = renderInspector(editList, transportFixture({ muted: true }));

    expect(rendered.host.textContent).toContain("手动精剪");
    expect(rendered.host.querySelector('[aria-label="取消预览静音"]')).not.toBeNull();
    expect(rendered.host.querySelector('select[aria-label="剪辑模式"]')).toBeNull();

    act(() => rendered.root.unmount());
  });
});
