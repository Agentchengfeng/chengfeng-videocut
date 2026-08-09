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
import { SubtitleStyleSection } from "./SubtitleStyleSection";

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
    projectId: "subtitle-style-contract",
    baseTranscriptRevision: "b".repeat(64),
    style,
    cues: [{ id: "sub-0001", wordIds: ["w-1"], text: "今天" }],
  };
}

function subtitlesFixture(document: SubtitleDocument | null): ProjectSubtitles {
  return {
    projectId: "subtitle-style-contract",
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

function render(subtitles: ProjectSubtitles): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<SubtitleStyleSection subtitles={subtitles} />));
  return host;
}

describe("SubtitleStyleSection", () => {
  it("offers whole looks rather than the fields a look is made of", () => {
    const element = render(subtitlesFixture(subtitleDocument()));
    const tiles = Array.from(element.querySelectorAll<HTMLButtonElement>('[role="radio"]'));

    expect(element.querySelector<HTMLElement>('[role="radiogroup"]')?.getAttribute("aria-label"))
      .toBe("字幕样式");
    expect(tiles).toHaveLength(SUBTITLE_STYLE_PRESETS.length);
    expect(tiles.map((tile) => tile.textContent?.replace("字幕", "")))
      .toEqual(SUBTITLE_STYLE_PRESETS.map((preset) => preset.label));
    expect(element.querySelector('input[type="color"]')).toBeNull();
    expect(element.querySelector('input[type="range"]')).toBeNull();
    expect(element.querySelector("select")).toBeNull();
    expect(element.querySelector("h3")).toBeNull();
  });

  it("marks the look the document is actually using", () => {
    const preset = SUBTITLE_STYLE_PRESETS[2]!;
    const element = render(subtitlesFixture(subtitleDocument(preset.style)));
    const checked = Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]'))
      .filter((tile) => tile.getAttribute("aria-checked") === "true")
      .map((tile) => tile.textContent?.replace("字幕", ""));

    expect(checked).toEqual([preset.label]);
  });

  it("writes the whole style, not a patch, so the stored style remains the only source of truth", () => {
    const subtitles = subtitlesFixture(subtitleDocument());
    const element = render(subtitles);
    const large = SUBTITLE_STYLE_PRESETS[1]!;

    act(() => {
      Array.from(element.querySelectorAll<HTMLButtonElement>('[role="radio"]'))[1]?.click();
    });

    expect(subtitles.setStyle).toHaveBeenCalledWith(large.style);
  });

  it("renders nothing without a subtitle document because the parent omits the whole tab", () => {
    const element = render(subtitlesFixture(null));

    expect(element.textContent).toBe("");
    expect(element.querySelector('[role="radiogroup"]')).toBeNull();
  });
});
