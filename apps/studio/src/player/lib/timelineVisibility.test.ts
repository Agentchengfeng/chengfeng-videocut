// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClipManifestClip } from "./playbackTypes";
import { filterStudioTimelineManifestClips } from "./timelineDOM";
import { furthestClipEndFromSource, isStudioTimelineHiddenElement, isTimelineIgnoredElement } from "./timelineElementHelpers";
import { buildTimelineMoveTimingPatch, buildTimelineResizeTimingPatch } from "../../hooks/timelineEditingHelpers";
import { setCompositionDurationToContent } from "../../utils/timelineAssetDrop";

const source = `<main data-composition-id="main" data-duration="10">
  <div id="visible" data-start="0" data-duration="4"></div>
  <section data-studio-timeline-hidden><audio id="hidden" data-start="0" data-duration="10"></audio></section>
  <section data-hf-ignore><audio id="ignored" data-start="0" data-duration="99"></audio></section>
</main>`;
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("Studio timeline visibility", () => {
  it("hides backing media and descendants only from the editable timeline", () => {
    const doc = parse(source);
    const hidden = doc.getElementById("hidden")!;
    expect(isStudioTimelineHiddenElement(hidden)).toBe(true);
    expect(isTimelineIgnoredElement(hidden)).toBe(false);
    expect(isTimelineIgnoredElement(doc.getElementById("ignored")!)).toBe(true);
    const clips = ["visible", "hidden", "ignored"].map((id) => ({ id }) as ClipManifestClip);
    expect(filterStudioTimelineManifestClips(doc, clips).map((clip) => clip.id)).toEqual(["visible"]);
    expect(furthestClipEndFromSource(source)).toBe(10);
    expect(hidden.hasAttribute("muted")).toBe(false);
    for (const marker of ["data-hf-ignore", "data-hyperframes-ignore", "data-hyperframes-picker-ignore", "data-hf-color-grading-canvas"]) {
      expect(furthestClipEndFromSource(source.replaceAll("data-hf-ignore", marker))).toBe(10);
    }
  });

  it("does not invent a UI contract for the unused legacy companion marker", () => {
    const doc = parse('<audio id="legacy" data-workbench-companion-audio data-start="0" data-duration="10"></audio>');
    expect(isStudioTimelineHiddenElement(doc.getElementById("legacy")!)).toBe(false);
    expect(isTimelineIgnoredElement(doc.getElementById("legacy")!)).toBe(false);
    expect(furthestClipEndFromSource(doc.body.innerHTML)).toBe(10);
  });

  it("ignores an overflowing hidden end without losing valid content duration", () => {
    const overflowing = '<audio data-studio-timeline-hidden data-start="1e308" data-duration="1e308"></audio>';
    expect(furthestClipEndFromSource(overflowing)).toBe(0);
    expect(furthestClipEndFromSource(source + overflowing)).toBe(10);
    const moved = buildTimelineMoveTimingPatch(source + overflowing, { id: "visible" }, 1, 4);
    expect(parse(moved).querySelector("main")?.getAttribute("data-duration")).toBe("10");
    expect(furthestClipEndFromSource(moved)).toBe(10);
  });

  it("preserves hidden content duration through serialized edits and real file reopen", async () => {
    const target = { id: "visible" };
    const moved = buildTimelineMoveTimingPatch(source, target, 1, 4);
    const resized = buildTimelineResizeTimingPatch(moved, target,
      { id: "visible", tag: "div", start: 1, duration: 4, track: 0 },
      { start: 1, duration: 2 });
    const directory = await mkdtemp(join(tmpdir(), "studio-hidden-duration-"));
    const path = join(directory, "index.html");
    await writeFile(path, resized);
    const reopened = await readFile(path, "utf8");
    expect(parse(reopened).querySelector("main")?.getAttribute("data-duration")).toBe("10");
    expect(furthestClipEndFromSource(reopened)).toBe(10);
    expect(parse(reopened).getElementById("visible")?.getAttribute("data-duration")).toBe("2");
    expect(parse(reopened).getElementById("hidden")?.outerHTML).toBe(parse(source).getElementById("hidden")?.outerHTML);
    const removed = parse(reopened);
    removed.getElementById("visible")!.remove();
    const removedSource = removed.body.innerHTML;
    const afterDelete = setCompositionDurationToContent(removedSource, furthestClipEndFromSource(removedSource));
    await writeFile(path, afterDelete);
    expect(parse(await readFile(path, "utf8")).querySelector("main")?.getAttribute("data-duration")).toBe("10");
  });
});
