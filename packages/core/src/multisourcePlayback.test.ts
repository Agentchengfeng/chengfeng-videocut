import { describe, expect, test } from "bun:test";
import { buildPlaybackTranscript } from "./node";
import { parseEditListDocument, applyEditListOperation } from "./editList";
import type { TimedWord } from "./cuts";

const word = (id: string, source: string, instanceId: string, start = 0, end = 1): TimedWord =>
  ({ id, source, instanceId, sourceWordId: "same-word", start, end, text: "同字", isGap: false });
function edl(parts: Array<[string, string, number, number]>) {
  let duration = 0;
  const segments = parts.map(([source, instanceId, sourceStart, sourceEnd], i) => {
    const segment = { id: `s${i}`, source, instanceId, sourceStart, sourceEnd, timelineStart: duration, trackId: "a-roll", playbackRate: 1 };
    duration += sourceEnd - sourceStart; return segment;
  });
  return parseEditListDocument({ schemaVersion: 2, projectId: "test", sourceDuration: 10,
    sources: ["a.wav", "b.wav"].map(path => ({ path, duration: 10, mediaKind: "audio", sha256: "a".repeat(64) })),
    baseCutsRevision: "b".repeat(64), baseTranscriptRevision: "c".repeat(64), mode: "manual", duration, segments });
}
const played = (words: TimedWord[], document: ReturnType<typeof edl>) => buildPlaybackTranscript("test", words, document);

describe("v2 playback transcript is EDL and instance addressed", () => {
  test("A-B-A uses independent instances despite same timestamps and original word ids", () => {
    const result = played([word("b", "b.wav", "B"), word("a2", "a.wav", "A2"), word("a1", "a.wav", "A1")],
      edl([["a.wav", "A1", 0, 1], ["b.wav", "B", 0, 1], ["a.wav", "A2", 0, 1]]));
    expect(result.stream.map(e => "id" in e && [e.id, e.instanceId, e.timelineStart, e.timelineEnd])).toEqual([
      ["a1", "A1", 0, 1], ["b", "B", 1, 2], ["a2", "A2", 2, 3],
    ]);
    expect(result.removedSpeechCount).toBe(0);
    expect(result.totalPlayedSeconds).toBe(3);
  });

  test("move respects reversed source order", () => {
    const document = edl([["a.wav", "A", 0, 1], ["a.wav", "A", 2, 3]]);
    const moved = applyEditListOperation(document, { type: "move", clipId: "s1", start: 0 });
    expect(played([word("early", "a.wav", "A"), word("late", "a.wav", "A", 2, 3)], moved).stream.map(e => "id" in e && e.id)).toEqual(["late", "early"]);
  });

  test("partial word trim reports only audible intersection and bounded removed summary", () => {
    const result = played([word("a", "a.wav", "A"), word("removed-b", "b.wav", "B")], edl([["a.wav", "A", 0.25, 0.75]]));
    expect(result.stream).toHaveLength(1);
    expect(result.stream[0]).toMatchObject({ id: "a", seconds: 0.5, sourceStart: 0.25, sourceEnd: 0.75, timelineStart: 0, timelineEnd: 0.5 });
    expect(result.removedSpeechCount).toBe(2);
    expect(result).not.toHaveProperty("removed");
    expect(result.stream.every(e => !("removedSpeech" in e))).toBe(true);
  });

  test("split coalesces only source and timeline contiguous same-word fragments", () => {
    const original = edl([["a.wav", "A", 0, 1]]);
    const split = applyEditListOperation(original, { type: "split", clipId: "s0", offset: 0.5, newClipId: "right" });
    const result = played([word("a", "a.wav", "A")], split);
    expect(result.stream).toHaveLength(1);
    expect(result.stream[0]).toMatchObject({ seconds: 1, timelineStart: 0, timelineEnd: 1, segmentIds: ["s0", "right"] });
    expect(played([word("a", "a.wav", "A")], edl([["a.wav", "A", 0, 0.3], ["a.wav", "A", 0.7, 1]])).stream).toHaveLength(2);
    expect(played([word("a", "a.wav", "A"), word("b", "b.wav", "B")],
      edl([["a.wav", "A", 0, 0.5], ["b.wav", "B", 0, 1], ["a.wav", "A", 0.5, 1]])).stream).toHaveLength(3);
  });

  test("v2 rejects missing or inconsistent source identities", () => {
    for (const field of ["source", "instanceId", "sourceWordId"] as const) {
      const input = word("a", "a.wav", "A"); delete input[field];
      expect(() => played([input], edl([["a.wav", "A", 0, 1]]))).toThrow("Multisource playback requires");
    }
    expect(() => played([word("a", "b.wav", "A")], edl([["a.wav", "A", 0, 1]]))).toThrow("Multisource playback requires");
  });

  test("v1 entry shape, durations and removedSpeech remain unchanged", () => {
    const document = edl([["a.wav", "A", 0.5, 1]]);
    const legacy = { ...document, schemaVersion: 1 as const, sources: undefined, segments: document.segments.map(({ instanceId, ...s }) => s) };
    const result = played([{ id: "removed", start: 0, end: 0.2, text: "删", isGap: false },
      { id: "keep", start: 0.2, end: 1, text: "留", isGap: false }], legacy);
    expect(result.stream).toEqual([{ removedSpeech: "删", seconds: 0.2 }, { id: "keep", text: "留", isGap: false, seconds: 0.8 }]);
    expect(result).not.toHaveProperty("removedSpeechCount");
  });
});
