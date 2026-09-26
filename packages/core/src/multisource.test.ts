import { describe, expect, it } from "bun:test";
import { type EditListDocument, applyEditListOperation, parseEditListDocument,
  sourceTimeToTimelineTime, timelineTimeToSourcePosition, timelineTimeToSourceTime } from "./editList";
import { parseTranscriptWords, type TimedWord } from "./cuts";
import { createSubtitleDocument, subtitleCueTimings, timelineTimeForSourceTime, wordPlays } from "./subtitles";
import { createVisualDocument, visualLayerTimings } from "./visuals";

const A = "input/a/source.wav";
const B = "input/b/source.wav";

/** Pure post-import fixture: original word IDs collide, project word IDs do not. */
function words(): TimedWord[] {
  return parseTranscriptWords({ cues: [
    { id: "a-cue", words: [{ id: "a:first:w0", sourceWordId: "w0", source: A, instanceId: "first", start: 0, end: 1, text: "甲" }] },
    { id: "b-cue", words: [{ id: "b:second:w0", sourceWordId: "w0", source: B, instanceId: "second", start: 0, end: 1, text: "乙" }] },
    { id: "repeat-cue", words: [{ id: "a:repeat:w0", sourceWordId: "w0", source: A, instanceId: "repeat", start: 0, end: 1, text: "甲" }] },
  ] });
}

function fixture(): EditListDocument {
  return {
    schemaVersion: 2, projectId: "multisource-pure-regression", sourceDuration: 8,
    baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "b".repeat(64), mode: "manual", duration: 6,
    sources: [
      { path: A, sha256: "c".repeat(64), duration: 4, mediaKind: "audio" },
      { path: B, sha256: "d".repeat(64), duration: 8, mediaKind: "video" },
    ],
    segments: [
      { id: "a-first", source: A, instanceId: "first", sourceStart: 0, sourceEnd: 2, timelineStart: 0, trackId: "a-roll", playbackRate: 1 },
      { id: "b-second", source: B, instanceId: "second", sourceStart: 0, sourceEnd: 2, timelineStart: 2, trackId: "a-roll", playbackRate: 1 },
      { id: "a-repeat", source: A, instanceId: "repeat", sourceStart: 0, sourceEnd: 2, timelineStart: 4, trackId: "a-roll", playbackRate: 1 },
    ],
  };
}

function subtitleDocument(transcript: TimedWord[], edl: EditListDocument) {
  const result = createSubtitleDocument(edl.projectId, edl.baseTranscriptRevision, transcript, edl);
  result.cues = transcript.map((word, index) => ({ id: `cue-${index}`, wordIds: [word.id], text: word.text ?? "" }));
  return result;
}

function visualDocument(transcript: TimedWord[], edl: EditListDocument) {
  return {
    ...createVisualDocument(edl.projectId, edl.baseTranscriptRevision),
    layers: transcript.map((word, index) => ({ id: `visual-${index}`, wordIds: [word.id], module: "modules/test/index.html" })),
  };
}

describe("multisource v2 identity and legacy compatibility", () => {
  it("round-trips the registry and segment usage instances without mutation", () => {
    const edl = fixture(); const before = JSON.stringify(edl);
    expect(parseEditListDocument(edl)).toEqual(edl);
    expect(JSON.stringify(edl)).toBe(before);
  });

  it("preserves unchanged v1 parsing, numeric mapping, subtitles and visuals", () => {
    const edl = fixture(); edl.schemaVersion = 1; delete edl.sources;
    edl.segments = [{ ...edl.segments[0]! }]; delete edl.segments[0]!.instanceId;
    edl.duration = 2;
    const transcript = [{ id: "w0", text: "旧", start: 0, end: 1 }];
    expect(parseEditListDocument(edl)).toEqual(edl);
    expect(sourceTimeToTimelineTime(edl, 0.5)).toBe(0.5);
    expect(timelineTimeToSourcePosition(edl, 0.5)).toEqual({ source: A, segmentId: "a-first", sourceTime: 0.5 });
    expect(timelineTimeToSourceTime(edl, 0.5)).toBe(0.5);
    expect(subtitleCueTimings(subtitleDocument(transcript, edl), transcript, edl)[0]).toMatchObject({ start: 0, end: 1, orphaned: false });
    expect(visualLayerTimings(visualDocument(transcript, edl), transcript, edl)[0]).toMatchObject({ start: 0, end: 1, orphaned: false });
  });

  it("keeps colliding original word IDs distinct after namespacing", () => {
    const transcript = words();
    expect(new Set(transcript.map(w => w.id)).size).toBe(3);
    expect(transcript.map(w => w.sourceWordId)).toEqual(["w0", "w0", "w0"]);
    expect(transcript.map(w => [w.source, w.instanceId])).toEqual([[A, "first"], [B, "second"], [A, "repeat"]]);
    expect(() => parseTranscriptWords({ cues: [{ words: transcript.map(w => ({ ...w, id: "w0" })) }] })).toThrow(/not unique/);
  });

  it("maps equal source seconds using both source and instance, never a numeric fallback", () => {
    const edl = fixture();
    expect(sourceTimeToTimelineTime(edl, 0.5, { source: A, instanceId: "first" })).toBe(0.5);
    expect(sourceTimeToTimelineTime(edl, 0.5, { source: B, instanceId: "second" })).toBe(2.5);
    expect(sourceTimeToTimelineTime(edl, 0.5, { source: A, instanceId: "repeat" })).toBe(4.5);
    for (const identity of [undefined, { source: A }, { instanceId: "first" }, { source: B, instanceId: "first" }, { source: A, instanceId: "absent" }]) {
      expect(sourceTimeToTimelineTime(edl, 0.5, identity)).toBeNull();
      expect(timelineTimeForSourceTime(edl.segments, 0.5, identity)).toBeNull();
    }
    expect(wordPlays(edl.segments, { start: 0, end: 1 })).toBe(false);
  });

  it("returns exact source, instance and segment at seams and the final endpoint", () => {
    for (const [time, segmentId, source, instanceId, sourceTime] of [
      [0, "a-first", A, "first", 0], [2, "b-second", B, "second", 0],
      [4, "a-repeat", A, "repeat", 0], [6, "a-repeat", A, "repeat", 2],
    ] as const) {
      expect(timelineTimeToSourcePosition(fixture(), time)).toEqual({ segmentId, source, instanceId, sourceTime });
    }
    for (const time of [-1, NaN, Infinity, 6.1]) expect(timelineTimeToSourcePosition(fixture(), time)).toBeNull();
  });
});

describe("multisource edit operations", () => {
  it("trim, split, move and delete retain the full registry and surviving instance identities", () => {
    const original = fixture(); const before = JSON.stringify(original);
    const trimmed = applyEditListOperation(original, { type: "trim", clipId: "a-first", sourceStart: 0.25, sourceEnd: 1.75 });
    const split = applyEditListOperation(trimmed, { type: "split", clipId: "a-first", offset: 0.75, newClipId: "a-first-right" });
    expect(split.segments.filter(s => s.instanceId === "first").map(s => [s.id, s.sourceStart, s.sourceEnd])).toEqual([
      ["a-first", 0.25, 1], ["a-first-right", 1, 1.75],
    ]);
    const moved = applyEditListOperation(split, { type: "move", clipId: "a-repeat", start: 0 });
    expect(moved.segments[0]!.id).toBe("a-repeat");
    const deleted = applyEditListOperation(moved, { type: "delete", clipId: "b-second" });
    for (const result of [trimmed, split, moved, deleted]) {
      expect(result.schemaVersion).toBe(2);
      expect(result.sources).toEqual(original.sources);
      expect(result.sourceDuration).toBe(8);
      expect(parseEditListDocument(result)).toEqual(result);
      expect(result.segments.every(s => s.instanceId === "first" || s.instanceId === "second" || s.instanceId === "repeat")).toBe(true);
    }
    expect(deleted.duration).toBe(3.5);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("bounds trim by the referenced source, not the longest registry entry", () => {
    expect(() => applyEditListOperation(fixture(), { type: "trim", clipId: "a-first", sourceStart: 0, sourceEnd: 5 })).toThrow();
    expect(applyEditListOperation(fixture(), { type: "trim", clipId: "b-second", sourceStart: 0, sourceEnd: 7 }).duration).toBe(11);
  });
});

describe("multisource subtitle and visual anchors", () => {
  it("separates two zero-second sources and the repeated use of one source", () => {
    const edl = fixture(); const transcript = words();
    const subtitleTimes = subtitleCueTimings(subtitleDocument(transcript, edl), transcript, edl);
    const visualTimes = visualLayerTimings(visualDocument(transcript, edl), transcript, edl);
    for (const timings of [subtitleTimes, visualTimes]) {
      expect(timings.map(t => [t.start, t.end, t.orphaned])).toEqual([[0, 1, false], [2, 3, false], [4, 5, false]]);
    }
  });

  it("deleting one occurrence orphans only its anchors, with later instances rippling", () => {
    const original = fixture(); const transcript = words();
    const edl = applyEditListOperation(original, { type: "delete", clipId: "a-first" });
    for (const timings of [subtitleCueTimings(subtitleDocument(transcript, original), transcript, edl), visualLayerTimings(visualDocument(transcript, original), transcript, edl)]) {
      expect(timings.map(t => [t.start, t.end, t.orphaned])).toEqual([[0, 0, true], [0, 1, false], [2, 3, false]]);
    }
  });

  it("split keeps the usage identity and moving another usage remaps both kinds of anchors", () => {
    const original = fixture(); const transcript = words();
    const split = applyEditListOperation(original, { type: "split", clipId: "a-first", offset: 0.5, newClipId: "a-first-right" });
    const edl = applyEditListOperation(split, { type: "move", clipId: "a-repeat", start: 0 });
    expect(timelineTimeToSourcePosition(edl, 2.5)).toEqual({ source: A, instanceId: "first", segmentId: "a-first-right", sourceTime: 0.5 });
    expect(sourceTimeToTimelineTime(edl, 0.5, { source: A, instanceId: "first" })).toBe(2.5);
    for (const timings of [subtitleCueTimings(subtitleDocument(transcript, original), transcript, edl), visualLayerTimings(visualDocument(transcript, original), transcript, edl)]) {
      expect(timings.map(t => [t.start, t.end, t.orphaned])).toEqual([[2, 3, false], [4, 5, false], [0, 1, false]]);
    }
  });

  it("does not rescue malformed word identity by finding equal seconds in another source", () => {
    const edl = fixture();
    for (const mutate of [
      (word: TimedWord) => { delete word.instanceId; },
      (word: TimedWord) => { delete word.source; },
      (word: TimedWord) => { word.source = B; },
      (word: TimedWord) => { word.instanceId = "missing"; },
    ]) {
      const transcript = words().slice(0, 1); mutate(transcript[0]!);
      for (const timings of [subtitleCueTimings(subtitleDocument(transcript, edl), transcript, edl), visualLayerTimings(visualDocument(transcript, edl), transcript, edl)]) {
        expect(timings[0]).toMatchObject({ duration: 0, orphaned: true });
      }
    }
  });

  it("maps the retained middle of an anchored word after precise trim", () => {
    const original = fixture(); const transcript = words().slice(0, 1);
    const edl = applyEditListOperation(original, { type: "trim", clipId: "a-first", sourceStart: 0.25, sourceEnd: 0.75 });
    for (const timings of [subtitleCueTimings(subtitleDocument(transcript, original), transcript, edl), visualLayerTimings(visualDocument(transcript, original), transcript, edl)]) {
      expect(timings[0]).toMatchObject({ start: 0, end: 0.5, orphaned: false });
    }
  });
});

describe("multisource registry validation", () => {
  for (const path of ["/tmp/source.wav", "../source.wav", "input/../source.wav", "input//source.wav", "input/./source.wav", "input\\source.wav", "C:/source.wav", "https://example.com/source.wav", "input/\u0000source.wav"]) {
    it(`rejects unsafe registry path ${JSON.stringify(path)}`, () => {
      const edl = fixture(); edl.sources![0]!.path = path; edl.segments[0]!.source = path; edl.segments[2]!.source = path;
      expect(() => parseEditListDocument(edl)).toThrow();
    });
  }
  it("rejects malformed hashes, duplicate paths, missing or unknown sources and missing instances", () => {
    for (const mutate of [
      (edl: EditListDocument) => { edl.sources![0]!.sha256 = "bad"; },
      (edl: EditListDocument) => { edl.sources![0]!.sha256 = "C".repeat(64); },
      (edl: EditListDocument) => { edl.sources![0]!.duration = 0; },
      (edl: EditListDocument) => { edl.sources![0]!.duration = NaN; },
      (edl: EditListDocument) => { edl.sources![0]!.duration = Infinity; },
      (edl: EditListDocument) => { edl.sources!.push({ ...edl.sources![0]! }); },
      (edl: EditListDocument) => { delete edl.sources; },
      (edl: EditListDocument) => { edl.segments[0]!.source = "input/unknown.wav"; },
      (edl: EditListDocument) => { delete edl.segments[0]!.instanceId; },
      (edl: EditListDocument) => { edl.segments[0]!.instanceId = " "; },
      (edl: EditListDocument) => { edl.segments[1]!.instanceId = "first"; },
      (edl: EditListDocument) => { edl.sourceDuration = 12; },
      (edl: EditListDocument) => { edl.segments[0]!.sourceEnd = 5; edl.segments[1]!.timelineStart = 5; edl.segments[2]!.timelineStart = 7; edl.duration = 9; },
    ]) {
      const edl = fixture(); mutate(edl);
      expect(() => parseEditListDocument(edl)).toThrow();
    }
  });
  it("requires explicit v2 before accepting registry or instances", () => {
    const edl = fixture(); edl.schemaVersion = 1;
    expect(() => parseEditListDocument(edl)).toThrow();
    delete edl.sources;
    expect(() => parseEditListDocument(edl)).toThrow();
  });
});
