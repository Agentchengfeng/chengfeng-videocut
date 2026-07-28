import { DEFAULT_SUBTITLE_STYLE, SUBTITLE_STYLE_PRESETS } from "@video-workbench/core";
import { describe, expect, it } from "vitest";
import { subtitleTextCss } from "./subtitleCss";

describe("subtitleTextCss", () => {
  it("grows the outline outward instead of centring it on the glyph edge", () => {
    const css = subtitleTextCss({ ...DEFAULT_SUBTITLE_STYLE, strokeWidth: 7 }, "6cqh");
    // -webkit-text-stroke centres: half of every width lands inside the letter,
    // so a nominal 7 showed 3.5 and filled in the counters of dense Han
    // characters. It is also the one thing ASS could never have matched.
    expect(css).not.toHaveProperty("WebkitTextStroke");
    // Every copy sits a full 0.07em from the centre — the whole nominal width.
    // Blur must be exactly zero and the colour the outline's: the drop shadow
    // in the same list also starts with two offsets.
    const offsets = String(css.textShadow)
      .match(/(-?\d+\.\d+)em (-?\d+\.\d+)em 0 #000000/g)
      ?.map((stamp) => {
        const [x, y] = stamp.split("em").map((part) => Number.parseFloat(part));
        return Math.hypot(x ?? 0, y ?? 0);
      }) ?? [];
    expect(offsets.length).toBe(16);
    for (const distance of offsets) expect(distance).toBeCloseTo(0.07, 4);
  });

  it("draws no outline at all when the look does not have one", () => {
    const css = subtitleTextCss({ ...DEFAULT_SUBTITLE_STYLE, strokeWidth: 0, shadowColor: "" }, "5cqh");
    expect(css.textShadow).toBeUndefined();
  });

  it("takes the plate's padding and corners from the style, not a stylesheet", () => {
    const capsule = SUBTITLE_STYLE_PRESETS.find((preset) => preset.id === "plate");
    expect(capsule).toBeDefined();
    const css = subtitleTextCss(capsule!.style, "5cqh");
    expect(css.borderRadius).toBe("0.800em");
    expect(css.padding).toBe("0.160em 0.360em");
    expect(css.background).toBe(capsule!.style.backgroundColor);
  });

  it("scales everything attached to the type with the type", () => {
    // The swatch is a button and the frame is a video; the same style has to
    // produce the same shape in both, so nothing here may be a pixel.
    for (const preset of SUBTITLE_STYLE_PRESETS) {
      const css = subtitleTextCss(preset.style, "5cqh");
      for (const value of [css.padding, css.borderRadius, css.letterSpacing, css.textShadow]) {
        if (value === undefined) continue;
        expect(String(value)).not.toMatch(/\dpx/);
      }
    }
  });

  it("passes the font size through untouched so the caller picks the unit", () => {
    expect(subtitleTextCss(DEFAULT_SUBTITLE_STYLE, "6cqh").fontSize).toBe("6cqh");
    expect(subtitleTextCss(DEFAULT_SUBTITLE_STYLE, "12.6px").fontSize).toBe("12.6px");
  });
});
