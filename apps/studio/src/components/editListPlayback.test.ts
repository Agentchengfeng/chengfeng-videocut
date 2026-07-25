import { describe, expect, it, vi } from "vitest";
import type { EditListDocument } from "@video-workbench/core";
import {
  resolveSourcePlayheadTime,
  resolveEditListPlaybackTransition,
  requestEditListPlaybackTransition,
  resolveTranscriptSeekTime,
  shouldUseLegacyCutPlayback,
  deriveActualCutWordIds,
} from "./editListPlayback";

const revision = "a".repeat(64);
const document: EditListDocument = {
  schemaVersion: 1,
  projectId: "demo",
  sourceDuration: 12,
  baseCutsRevision: revision,
  baseTranscriptRevision: revision,
  mode: "cuts-derived",
  duration: 8,
  segments: [
    {
      id: "a",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 4,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    },
    {
      id: "b",
      source: "input/source.mp4",
      sourceStart: 8,
      sourceEnd: 12,
      timelineStart: 4,
      trackId: "a-roll",
      playbackRate: 1,
    },
  ],
};

describe("edit-list playback mapping", () => {
  it("maps the shared timeline playhead back to transcript source time", () => {
    expect(resolveSourcePlayheadTime(document, 5)).toBe(9);
  });

  it("maps retained transcript words into the shared timeline", () => {
    expect(resolveTranscriptSeekTime(document, 10)).toBe(6);
  });

  it("snaps a deleted transcript word to the next retained boundary", () => {
    expect(resolveTranscriptSeekTime(document, 6)).toBe(4);
  });

  it("keeps a running transport on the same source frame after deleting an earlier segment", () => {
    const previous: EditListDocument = {
      ...document,
      duration: 12,
      segments: [{
        ...document.segments[0],
        sourceEnd: 12,
      }],
    };

    const requestSeek = vi.fn();
    expect(requestEditListPlaybackTransition({
      oldEditList: previous,
      newEditList: document,
      currentTimelineTime: 9,
      wasPlaying: true,
    }, requestSeek)).toEqual({
      timelineTime: 5,
      keepPlaying: true,
    });
    expect(requestSeek).toHaveBeenCalledWith(5, { keepPlaying: true });
    expect(resolveSourcePlayheadTime(document, 5)).toBe(9);
  });

  it("jumps over a newly deleted current segment and keeps playing from the next source range", () => {
    const previous: EditListDocument = {
      ...document,
      duration: 12,
      segments: [{
        ...document.segments[0],
        sourceEnd: 12,
      }],
    };

    const requestSeek = vi.fn();
    expect(requestEditListPlaybackTransition({
      oldEditList: previous,
      newEditList: document,
      currentTimelineTime: 6,
      wasPlaying: true,
    }, requestSeek)).toEqual({
      timelineTime: 4,
      keepPlaying: true,
    });
    expect(requestSeek).toHaveBeenCalledWith(4, { keepPlaying: true });
    expect(resolveSourcePlayheadTime(document, 4)).toBe(8);
  });

  it("preserves a paused transport while still remapping its playhead", () => {
    const previous: EditListDocument = {
      ...document,
      duration: 12,
      segments: [{
        ...document.segments[0],
        sourceEnd: 12,
      }],
    };

    const requestSeek = vi.fn();
    expect(requestEditListPlaybackTransition({
      oldEditList: previous,
      newEditList: document,
      currentTimelineTime: 9,
      wasPlaying: false,
    }, requestSeek).keepPlaying).toBe(false);
    expect(requestSeek).toHaveBeenCalledWith(5, { keepPlaying: false });
  });

  it("chooses the next source-time segment after the timeline has been reordered", () => {
    const reordered: EditListDocument = {
      ...document,
      sourceDuration: 30,
      duration: 20,
      mode: "manual",
      segments: [
        { ...document.segments[0], sourceEnd: 5 },
        {
          ...document.segments[1],
          sourceStart: 20,
          sourceEnd: 30,
          timelineStart: 5,
        },
        {
          ...document.segments[1],
          id: "c",
          sourceStart: 10,
          sourceEnd: 15,
          timelineStart: 15,
        },
      ],
    };

    expect(resolveTranscriptSeekTime(reordered, 6)).toBe(15);
  });

  it("keeps legacy projects in one time domain", () => {
    expect(resolveSourcePlayheadTime(null, 5)).toBe(5);
    expect(resolveTranscriptSeekTime(null, 5)).toBe(5);
  });

  it("keeps legacy skip disabled when the EDL GET fails but managed DOM clips exist", () => {
    expect(shouldUseLegacyCutPlayback({
      document: null,
      loading: false,
      hasManagedTimelineElements: true,
    })).toBe(false);
    expect(shouldUseLegacyCutPlayback({
      document: null,
      loading: false,
      hasManagedTimelineElements: false,
    })).toBe(true);
  });

  it("derives displayed cuts from actual manual delete/trim coverage", () => {
    const manual: EditListDocument = {
      ...document,
      mode: "manual",
      duration: 4.5,
      segments: [
        { ...document.segments[0], sourceEnd: 2 },
        {
          ...document.segments[1],
          sourceStart: 5.5,
          sourceEnd: 8,
          timelineStart: 2,
        },
      ],
    };
    const words = [
      { id: "w1", start: 0, end: 2, text: "one", isGap: false },
      { id: "w2", start: 2, end: 4, text: "two", isGap: false },
      { id: "w3", start: 4, end: 6, text: "three", isGap: false },
      { id: "w4", start: 6, end: 8, text: "four", isGap: false },
    ];

    expect([...deriveActualCutWordIds(words, new Set(), manual)]).toEqual(["w2", "w3"]);
  });
});
