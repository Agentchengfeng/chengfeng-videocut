// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CutPlayer } from "./CutPlayer";
import { createTransportVideoRef, type EdlVideoTransport } from "./useAssembledVideoTransport";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function transportFixture(overrides: Partial<EdlVideoTransport> = {}): EdlVideoTransport {
  return {
    videoRef: createTransportVideoRef(),
    timelineTime: 12.4,
    duration: 230.5,
    isPlaying: false,
    desiredPlaying: false,
    isWaiting: false,
    isSeeking: false,
    playbackRate: 1,
    volume: 1,
    muted: false,
    loopEnabled: false,
    error: null,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    togglePlay: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    restoreIntent: vi.fn(async () => undefined),
    setPlaybackRate: vi.fn(),
    setVolume: vi.fn(),
    toggleMuted: vi.fn(),
    toggleLoop: vi.fn(),
    ...overrides,
  };
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
}

describe("CutPlayer controls", () => {
  it("exposes the HyperFrames-compatible transport through the Product transport", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture();

    act(() => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/source.mp4"
        transport={transport}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    expect(host.querySelector<HTMLInputElement>('[aria-label="播放位置"]')).toBeNull();
    expect(host.querySelectorAll('input[type="range"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="静音"]')).not.toBeNull();
    const volume = host.querySelector<HTMLInputElement>('input[aria-label="音量"]');
    expect(volume).not.toBeNull();
    expect(volume?.value).toBe("1");
    expect(volume?.disabled).toBe(false);
    expect(host.querySelector('[aria-label="播放速度"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="开启循环播放"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="全屏"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="快捷键与工具"]')).not.toBeNull();
    expect(host.querySelector('[data-player-transport="hyperframes-compatible"]')).not.toBeNull();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="静音"]')!.click();
    });
    expect(transport.toggleMuted).toHaveBeenCalledTimes(1);

    act(() => {
      setNativeInputValue(volume!, "0.42");
      volume!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(transport.setVolume).toHaveBeenCalledWith(0.42);
    expect(transport.play).not.toHaveBeenCalled();
    expect(transport.pause).not.toHaveBeenCalled();
    expect(transport.togglePlay).not.toHaveBeenCalled();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="播放速度"]')!.click();
    });
    act(() => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
        .find((button) => button.textContent === "1.5x")!
        .click();
    });
    expect(transport.setPlaybackRate).toHaveBeenCalledWith(1.5);

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="开启循环播放"]')!.click();
    });
    expect(transport.toggleLoop).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("keeps the visible volume control reachable by keyboard and pointer without changing play intent", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture({ isPlaying: true, desiredPlaying: true, volume: 1 });

    act(() => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/source.mp4"
        transport={transport}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const volume = host.querySelector<HTMLInputElement>('input[aria-label="音量"]')!;
    Object.defineProperty(volume, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 10,
        y: 20,
        left: 10,
        right: 110,
        top: 20,
        bottom: 44,
        width: 100,
        height: 24,
        toJSON: () => {},
      }),
    });

    const pressHome = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Home",
    });
    act(() => volume.dispatchEvent(pressHome));
    expect(pressHome.defaultPrevented).toBe(true);
    expect(transport.setVolume).toHaveBeenLastCalledWith(0);

    const pressLeft = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    act(() => volume.dispatchEvent(pressLeft));
    expect(pressLeft.defaultPrevented).toBe(true);
    expect(transport.setVolume).toHaveBeenLastCalledWith(0.95);

    act(() => {
      volume.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 52,
        buttons: 1,
      }));
    });
    expect(transport.setVolume).toHaveBeenLastCalledWith(0.42);
    expect(transport.play).not.toHaveBeenCalled();
    expect(transport.pause).not.toHaveBeenCalled();
    expect(transport.togglePlay).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("copies time/frame display and jump-to-frame without importing a second clock", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture();
    const commit = vi.fn();

    act(() => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/source.mp4"
        transport={transport}
        onTimelineTimeCommit={commit}
      />,
    ));

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="切换为帧显示"]')!.click();
    });
    expect(host.querySelector('[aria-label="切换为时间显示"]')?.textContent).toContain("372");
    expect(host.querySelector('[aria-label="切换为时间显示"]')?.textContent).toContain("6915 帧");

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="快捷键与工具"]')!.click();
    });
    expect(host.querySelector('[aria-label="播放快捷键与工具"]')).not.toBeNull();

    const input = host.querySelector<HTMLInputElement>('#cf-cut-jump-frame-input');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "1800");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('.cf-cut-jump-frame button[type="submit"]')!.click();
    });
    expect(transport.seek).toHaveBeenCalledWith(60, { keepPlaying: false });
    expect(commit).toHaveBeenCalledWith(60);

    act(() => root.unmount());
  });

  it("owns Product-safe playback shortcuts and ignores focused inputs", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture();
    const commit = vi.fn();

    await act(async () => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/source.mp4"
        transport={transport}
        onTimelineTimeCommit={commit}
      />,
    ));
    await act(async () => undefined);

    const player = host.querySelector<HTMLElement>('[aria-label="剪口播播放器"]');
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(player, "requestFullscreen", { configurable: true, value: requestFullscreen });

    const press = (code: string, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code,
        ...options,
      });
      act(() => window.dispatchEvent(event));
      return event;
    };

    expect(press("Space").defaultPrevented).toBe(true);
    expect(transport.togglePlay).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(12.4);

    press("ArrowRight");
    expect(transport.seek).toHaveBeenCalledWith(12.4 + 1 / 30, { keepPlaying: false });

    press("ArrowLeft", { shiftKey: true });
    expect(transport.seek).toHaveBeenCalledWith(12.4 - 10 / 30, { keepPlaying: false });

    press("KeyM");
    expect(transport.toggleMuted).toHaveBeenCalledOnce();
    press("KeyL", { shiftKey: true });
    expect(transport.toggleLoop).toHaveBeenCalledOnce();
    press("KeyK");
    expect(transport.pause).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(12.4);
    press("KeyF");
    expect(requestFullscreen).toHaveBeenCalledOnce();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="快捷键与工具"]')!.click();
    });
    const input = host.querySelector<HTMLInputElement>('#cf-cut-jump-frame-input');
    const inputSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
    });
    act(() => input!.dispatchEvent(inputSpace));
    expect(inputSpace.defaultPrevented).toBe(false);
    expect(transport.togglePlay).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it("blocks all playback shortcuts while preview is non-current and restores them at current", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture();
    transport.desiredPlaying = true;
    transport.isPlaying = false;
    const commit = vi.fn();

    await act(async () => root.render(
      <CutPlayer
        sourceUrl={null}
        artifactPhase="generating"
        transport={transport}
        onTimelineTimeCommit={commit}
      />,
    ));

    expect(host.querySelector<HTMLButtonElement>('.cf-cut-play-button')?.disabled).toBe(true);

    const pressSpace = () => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Space",
      });
      act(() => window.dispatchEvent(event));
      return event;
    };

    const first = pressSpace();
    const second = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "ArrowRight",
    });
    act(() => window.dispatchEvent(second));

    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    expect(transport.togglePlay).not.toHaveBeenCalled();
    expect(transport.seek).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    await act(async () => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/current.mp4"
        artifactPhase="current"
        transport={transport}
        onTimelineTimeCommit={commit}
      />,
    ));
    const restored = pressSpace();
    expect(restored.defaultPrevented).toBe(true);
    expect(transport.togglePlay).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(12.4);

    act(() => root.unmount());
  });

  it("keeps the failed preview retry button reachable as a Product action", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture();
    const retry = vi.fn();

    await act(async () => root.render(
      <CutPlayer
        sourceUrl={null}
        artifactPhase="failed"
        transport={transport}
        onArtifactRetry={retry}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    const status = host.querySelector<HTMLElement>('.cf-cut-player-state.is-error');
    const button = host.querySelector<HTMLButtonElement>('.cf-cut-preview-retry');

    expect(status?.classList.contains("has-action")).toBe(true);
    expect(button).not.toBeNull();

    act(() => button!.click());
    expect(retry).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
  // This is the product's single hardest media rule: one <video>, no independent
  // <audio>, no <iframe>, and one playback clock. Until now nothing enforced it,
  // which is how an unused second transport and a second preview surface both
  // survived in the tree. Assert it on every profile the player can be handed.
  it.each([
    ["ledger-proxy-v1" as const, "current" as const],
    ["fast-proxy-v1" as const, "current" as const],
    ["sharp-canonical-v1" as const, "generating" as const],
  ])("owns exactly one media element for profile %s", (profile, phase) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const transport = transportFixture();

    act(() => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/preview.mp4"
        transport={transport}
        artifactPhase={phase}
        artifactProfile={profile}
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    expect(host.querySelectorAll("video")).toHaveLength(1);
    expect(host.querySelectorAll("audio")).toHaveLength(0);
    expect(host.querySelectorAll("iframe")).toHaveLength(0);
    // The one element must be the transport's own, or there are two clocks.
    expect(host.querySelector("video")).toBe(transport.videoRef.current);
    expect(host.querySelectorAll('[data-koubo-media-owner="video"]')).toHaveLength(1);

    act(() => root.unmount());
  });

  it("never tells the person to wait while the ledger is playing", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CutPlayer
        sourceUrl="/api/projects/cut-player/preview.mp4"
        transport={transportFixture()}
        artifactPhase="current"
        artifactProfile="ledger-proxy-v1"
        onTimelineTimeCommit={vi.fn()}
      />,
    ));

    // Ledger playback has no generation step, so none of the artifact banners
    // may appear and the controls must never be disabled waiting for one.
    expect(host.querySelector(".cf-cut-preview-retry")).toBeNull();
    const banners = [...host.querySelectorAll(".cf-cut-player-state")].map((node) => node.textContent ?? "");
    expect(banners.some((text) => text.includes("正在生成"))).toBe(false);
    expect(banners.some((text) => text.includes("已过期"))).toBe(false);
    expect(banners.some((text) => text.includes("低资源预览"))).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(".cf-cut-play-button")?.disabled).toBe(false);

    act(() => root.unmount());
  });
});
