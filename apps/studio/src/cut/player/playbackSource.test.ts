import { describe, expect, it } from "vitest";
import type { EditListDocument } from "@video-workbench/core";
import { resolveEditListPlaybackSource } from "./playbackSource";

function documentWithSources(...sources: string[]): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "demo",
    sourceDuration: 20,
    baseCutsRevision: "a".repeat(64),
    baseTranscriptRevision: "b".repeat(64),
    mode: "cuts-derived",
    duration: sources.length * 2,
    segments: sources.map((source, index) => ({
      id: `s${index}`,
      source,
      sourceStart: index * 2,
      sourceEnd: index * 2 + 2,
      timelineStart: index * 2,
      trackId: "a-roll",
      playbackRate: 1,
    })),
  };
}

describe("resolveEditListPlaybackSource", () => {
  it("routes one project-relative source through the Range preview endpoint", () => {
    expect(resolveEditListPlaybackSource("a/b", documentWithSources("input/source.mp4"))).toEqual({
      url: "/api/projects/a%2Fb/preview/input/source.mp4",
      source: "input/source.mp4",
      consistent: true,
    });
  });

  it("preserves an absolute source", () => {
    const source = "https://cdn.example.test/source.mp4?v=1";
    expect(resolveEditListPlaybackSource("demo", documentWithSources(source)).url).toBe(source);
  });

  it("encodes every project-relative path segment without hiding separators", () => {
    expect(resolveEditListPlaybackSource(
      "demo",
      documentWithSources("input/口播 #1?.mp4"),
    ).url).toBe("/api/projects/demo/preview/input/%E5%8F%A3%E6%92%AD%20%231%3F.mp4");
  });

  it("fails closed when one EDL references multiple media sources", () => {
    expect(resolveEditListPlaybackSource(
      "demo",
      documentWithSources("input/a.mp4", "input/b.mp4"),
    )).toMatchObject({ url: null, consistent: false });
  });
});
