// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_STYLE_PRESETS,
  type SubtitleDocument,
} from "@video-workbench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";
import { CutInspector } from "./CutInspector";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function subtitleDocument(style = DEFAULT_SUBTITLE_STYLE): SubtitleDocument {
  return {
    schemaVersion: 1,
    projectId: "inspector-contract",
    baseTranscriptRevision: "b".repeat(64),
    style,
    cues: [{ id: "sub-0001", wordIds: ["w-1"], text: "今天" }],
  };
}

function subtitlesFixture(document: SubtitleDocument | null): ProjectSubtitles {
  return {
    projectId: "inspector-contract",
    document,
    revision: document ? "c".repeat(64) : "none",
    timings: [],
    stale: [],
    loading: false,
    ready: true,
    saveState: "idle",
    error: null,
    reload: vi.fn(async () => undefined),
    save: vi.fn(),
    setCueText: vi.fn(),
    setStyle: vi.fn(),
    mergeWithPrevious: vi.fn(),
    splitAt: vi.fn(),
  };
}

function render(subtitles?: ProjectSubtitles): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<CutInspector {...(subtitles ? { subtitles } : {})} />));
  return host;
}

describe("CutInspector", () => {
  it("navigates by feature, with the same tab strip as the column on the left", () => {
    const element = render(subtitlesFixture(subtitleDocument()));
    // 参数 is the column's name, not a row inside it: the strip below says
    // which feature, and the column on the left carries no heading either.
    expect(element.querySelector<HTMLElement>(".cf-cut-inspector")?.getAttribute("aria-label"))
      .toBe("参数");
    expect(element.querySelector("h2")).toBeNull();
    expect(element.querySelector(".cf-cut-inspector__header")).toBeNull();

    const tablist = element.querySelector<HTMLElement>('[role="tablist"]');
    expect(tablist?.classList.contains("cf-cut-feature-tabs")).toBe(true);
    const tabs = Array.from(element.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["字幕"]);
    expect(tabs[0]?.className).toBe("cf-cut-feature-tab");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    // The tab names the feature, so the group under it names the parameters
    // rather than repeating 字幕 one line down.
    const groups = Array.from(element.querySelectorAll(".cf-cut-inspector__group-title"))
      .map((node) => node.textContent);
    expect(groups).toEqual(["样式"]);

    const panel = element.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
  });

  it("does not keep a playback group, whose controls already sit under the video", () => {
    const element = render(subtitlesFixture(subtitleDocument()));
    expect(element.textContent).not.toContain("预览音量");
    expect(element.textContent).not.toContain("预览倍速");
    expect(element.textContent).not.toContain("仅影响当前预览");
  });

  it("does not restate the cut as a table of figures nobody asked for", () => {
    const element = render(subtitlesFixture(subtitleDocument()));
    expect(element.textContent).not.toContain("原素材时长");
    expect(element.textContent).not.toContain("成片时长");
    expect(element.textContent).not.toContain("片段数");
  });

  it("offers whole looks rather than the fields a look is made of", () => {
    const element = render(subtitlesFixture(subtitleDocument()));
    const tiles = Array.from(element.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(tiles).toHaveLength(SUBTITLE_STYLE_PRESETS.length);
    expect(tiles.map((tile) => tile.textContent?.replace("字幕", "")))
      .toEqual(SUBTITLE_STYLE_PRESETS.map((preset) => preset.label));
    // The controls a preset replaced must not come back alongside it.
    expect(element.querySelector('input[type="color"]')).toBeNull();
    expect(element.querySelector('input[type="range"]')).toBeNull();
    expect(element.querySelector("select")).toBeNull();
  });

  it("marks the look the document is actually using", () => {
    const preset = SUBTITLE_STYLE_PRESETS[2]!;
    const element = render(subtitlesFixture(subtitleDocument(preset.style)));
    const checked = Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]'))
      .filter((tile) => tile.getAttribute("aria-checked") === "true")
      .map((tile) => tile.textContent?.replace("字幕", ""));
    expect(checked).toEqual([preset.label]);
  });

  it("writes the whole style, not a patch, so no second place can disagree", () => {
    const subtitles = subtitlesFixture(subtitleDocument());
    const element = render(subtitles);
    const large = SUBTITLE_STYLE_PRESETS[1]!;
    act(() => {
      Array.from(element.querySelectorAll<HTMLButtonElement>('[role="radio"]'))[1]?.click();
    });
    expect(subtitles.setStyle).toHaveBeenCalledWith(large.style);
  });

  it("says so plainly when there is nothing to adjust, and drops the strip with it", () => {
    const element = render(subtitlesFixture(null));
    expect(element.textContent).toContain("还没有可调的参数");
    expect(element.querySelector('[role="radio"]')).toBeNull();
    // An empty tab strip is worse than none: it promises a place to go back to.
    expect(element.querySelector('[role="tablist"]')).toBeNull();
    expect(element.querySelector('[role="tabpanel"]')).toBeNull();
  });
});
