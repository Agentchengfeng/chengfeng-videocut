import { describe, expect, it } from "bun:test";
import { type EditListDocument, timelineTimeToSourcePosition, timelineTimeToSourceTime } from "./editList";

function fixture(): EditListDocument {
  return {
    schemaVersion: 1, projectId: "source-position", sourceDuration: 12,
    baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "b".repeat(64),
    mode: "manual", duration: 6,
    segments: [
      { id: "first", source: "input/first.wav", sourceStart: 2, sourceEnd: 4, timelineStart: 0, trackId: "a-roll", playbackRate: 1 },
      { id: "second", source: "input/second.wav", sourceStart: 2, sourceEnd: 4, timelineStart: 2, trackId: "a-roll", playbackRate: 1 },
      { id: "repeat", source: "input/first.wav", sourceStart: 2, sourceEnd: 4, timelineStart: 4, trackId: "a-roll", playbackRate: 1 },
    ],
  };
}

describe("source-aware playback position", () => {
  it("distinguishes identical source times in different sources", () => {
    expect(timelineTimeToSourcePosition(fixture(), 1)).toEqual({ segmentId: "first", source: "input/first.wav", sourceTime: 3 });
    expect(timelineTimeToSourcePosition(fixture(), 3)).toEqual({ segmentId: "second", source: "input/second.wav", sourceTime: 3 });
  });
  it("preserves repeated occurrence identity", () => {
    expect(timelineTimeToSourcePosition(fixture(), 5)).toEqual({ segmentId: "repeat", source: "input/first.wav", sourceTime: 3 });
  });
  it("selects the next source at a shared boundary and includes the final endpoint", () => {
    expect(timelineTimeToSourcePosition(fixture(), 2)?.segmentId).toBe("second");
    expect(timelineTimeToSourcePosition(fixture(), 4)?.segmentId).toBe("repeat");
    expect(timelineTimeToSourcePosition(fixture(), 6)?.sourceTime).toBe(4);
  });
  it("keeps numeric callers compatible without mutating the document", () => {
    const document = fixture(); const before = JSON.stringify(document);
    for (const time of [0, 1, 2, 3, 4, 5, 6]) {
      expect(timelineTimeToSourceTime(document, time)).toBe(timelineTimeToSourcePosition(document, time)?.sourceTime ?? null);
    }
    expect(JSON.stringify(document)).toBe(before);
  });
  it("rejects invalid cursor values", () => {
    for (const time of [-1, 6.01, NaN, Infinity, -Infinity]) {
      expect(timelineTimeToSourcePosition(fixture(), time)).toBeNull();
      expect(timelineTimeToSourceTime(fixture(), time)).toBeNull();
    }
  });
  it("does not bypass document validation", () => {
    const document = fixture(); document.segments[1]!.sourceEnd = 13;
    expect(() => timelineTimeToSourcePosition(document, 3)).toThrow();
  });
});
