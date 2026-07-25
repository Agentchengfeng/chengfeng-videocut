import { describe, expect, it } from "vitest";
import type { ClipManifestClip } from "./playbackTypes";
import { filterStudioTimelineManifestClips } from "./timelineDOM";
import {
  isStudioTimelineHiddenElement,
  isTimelineIgnoredElement,
} from "./timelineElementHelpers";

function fakeElement(options: {
  companion?: boolean;
  runtimeIgnored?: boolean;
  studioHidden?: boolean;
} = {}): Element {
  const element = {
    closest(selector: string) {
      if (selector === "[data-workbench-companion-audio]") {
        return options.companion ? element : null;
      }
      if (selector === "[data-studio-timeline-hidden]") {
        return options.studioHidden ? element : null;
      }
      return options.runtimeIgnored ? element : null;
    },
  };
  return element as unknown as Element;
}

function clip(id: string): ClipManifestClip {
  return {
    id,
    label: id,
    kind: id.endsWith("audio") ? "audio" : "video",
    tagName: id.endsWith("audio") ? "audio" : "video",
    start: 0,
    duration: 10,
    track: id.endsWith("audio") ? 1 : 0,
    compositionId: null,
    parentCompositionId: null,
    compositionSrc: null,
    assetUrl: "/a-roll.mp4",
  };
}

describe("Studio timeline visibility", () => {
  it("treats companion audio as UI-only hidden without a runtime-ignore marker", () => {
    const companion = fakeElement({ companion: true });
    const video = fakeElement();
    const doc = {
      getElementById(id: string) {
        return id === "a-roll-audio" ? companion : video;
      },
      querySelector() {
        return null;
      },
    } as unknown as Document;

    expect(isStudioTimelineHiddenElement(companion)).toBe(true);
    expect(isTimelineIgnoredElement(companion)).toBe(false);
    expect(isStudioTimelineHiddenElement(video)).toBe(false);
    expect(
      filterStudioTimelineManifestClips(doc, [
        clip("a-roll-video"),
        clip("a-roll-audio"),
      ]).map((item) => item.id),
    ).toEqual(["a-roll-video"]);
  });

  it("hides an EDL backing video from Studio without hiding it from runtime", () => {
    const backing = fakeElement({ studioHidden: true });
    expect(isStudioTimelineHiddenElement(backing)).toBe(true);
    expect(isTimelineIgnoredElement(backing)).toBe(false);
  });
});
