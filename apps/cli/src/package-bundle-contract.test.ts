import { describe, expect, it } from "bun:test";
import { checkStudioBundleContract } from "../scripts/check-package";

describe("packaged Studio bundle contract", () => {
  it("accepts a real HyperFrames extension view without legacy workbench UI", () => {
    expect(() =>
      checkStudioBundleContract([
        {
          path: "studio/assets/index.js",
          content: 'jsx("main", { "data-studio-extension-view": "koubo", useTimelineEditingAdapter })',
        },
        { path: "studio/assets/vendor.js", content: "const hyperframes = true" },
      ])
    ).not.toThrow();
  });

  it("rejects a manifest-only claim when the extension marker is absent", () => {
    expect(() =>
      checkStudioBundleContract([
        {
          path: "studio/assets/index.js",
          content: 'const capabilities = { topLevelViews: ["storyboard", "preview", "koubo"] }',
        },
      ])
    ).toThrow("missing the HyperFrames extension view marker data-studio-extension-view");
  });

  it("rejects a view-only bundle when the managed timeline adapter is absent", () => {
    expect(() =>
      checkStudioBundleContract([
        {
          path: "studio/assets/index.js",
          content: 'jsx("main", { "data-studio-extension-view": "koubo" })',
        },
      ])
    ).toThrow("missing the managed timeline adapter marker useTimelineEditingAdapter");
  });

  it.each(["cf-task-panel", "剪辑工作区"])(
    "rejects the legacy workbench marker %s",
    (legacyMarker) => {
      expect(() =>
        checkStudioBundleContract([
          {
            path: "studio/assets/index.js",
            content: `data-studio-extension-view useTimelineEditingAdapter ${legacyMarker}`,
          },
        ])
      ).toThrow(`legacy workbench marker ${legacyMarker}`);
    },
  );

  it("rejects legacy workbench CSS even when the JavaScript view is current", () => {
    expect(() =>
      checkStudioBundleContract([
        {
          path: "studio/assets/index.js",
          content: 'jsx("main", { "data-studio-extension-view": "koubo", useTimelineEditingAdapter })',
        },
        { path: "studio/assets/index.css", content: ".cf-task-panel { display: flex }" },
      ])
    ).toThrow("legacy workbench marker cf-task-panel");
  });

  it("rejects an empty JavaScript asset set", () => {
    expect(() =>
      checkStudioBundleContract([
        { path: "studio/assets/index.css", content: ".koubo-plugin {}" },
      ])
    ).toThrow(
      "Studio package has no JavaScript bundle assets",
    );
  });
});
