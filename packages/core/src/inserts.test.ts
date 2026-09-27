import { describe, expect, test } from "bun:test";
import type { EditListDocument, EditListSegment } from "@video-workbench/contracts";
import { parseEditListDocument } from "./editList";
import { applyInserts, assertInsertDocument, followCutAnchors, insertAssetPath, insertMediaLayers, stripInserts, type InsertDocument } from "./inserts";
import { subtitleCueTimings } from "./subtitles";

const REV = "a".repeat(64);
const ASSET = "b".repeat(64);
const VOICE = "input/source.wav";
const word = (id: string, start: number, end: number, isGap = false) => ({ id, start, end, isGap, text: isGap ? "" : id, source: VOICE, instanceId: "original", sourceWordId: id });
const words = [word("w1", 0, 1), word("g1", 1, 1.6, true), word("w2", 1.6, 2.4), word("g2", 2.4, 3, true), word("w3", 3, 4)];

function edl(): EditListDocument {
  return parseEditListDocument({
    schemaVersion: 2, projectId: "p", sourceDuration: 10, baseCutsRevision: REV, baseTranscriptRevision: REV, mode: "manual",
    sources: [{ path: VOICE, sha256: REV, duration: 10, mediaKind: "audio" }],
    segments: [
      { id: "a-roll-0001", source: VOICE, sourceStart: 0, sourceEnd: 2.4, timelineStart: 0, trackId: "a-roll", playbackRate: 1, instanceId: "original" },
      { id: "a-roll-0002", source: VOICE, sourceStart: 3, sourceEnd: 4, timelineStart: 2.4, trackId: "a-roll", playbackRate: 1, instanceId: "original" },
    ],
    duration: 3.4,
  });
}
const doc = (inserts: InsertDocument["inserts"]): InsertDocument => ({ schemaVersion: 1, projectId: "p", inserts });
const assets = new Map([[ASSET, { duration: 20, hasAudio: true }]]);
const clip = (id: string, afterWordId: string, sourceOut = 5) => ({ id, afterWordId, assetId: ASSET, sourceIn: 0, sourceOut, fit: "contain" as const });

describe("applyInserts", () => {
  test("splits inside the pause after the anchor and ripples the rest", () => {
    const out = parseEditListDocument(applyInserts({ editList: edl(), words, document: doc([clip("i1", "w1")]), assets }));
    expect(out.segments.map(s => [s.id, s.sourceStart, s.sourceEnd, s.timelineStart])).toEqual([
      ["a-roll-0001", 0, 1.3, 0],
      ["insert-i1", 0, 5, 1.3],
      ["a-roll-0001~i1", 1.3, 2.4, 6.3],
      ["a-roll-0002", 3, 4, 7.4],
    ]);
    expect(out.duration).toBe(8.4);
    expect(out.sources!.find(s => s.path === insertAssetPath(ASSET))).toMatchObject({ sha256: ASSET, mediaKind: "video", duration: 20 });
  });

  test("anchor at a segment end appends without splitting", () => {
    const out = applyInserts({ editList: edl(), words, document: doc([clip("i1", "w2", 2)]), assets });
    expect(out.segments.map(s => s.id)).toEqual(["a-roll-0001", "insert-i1", "a-roll-0002"]);
    expect(out.segments[2]!.timelineStart).toBe(4.4);
  });

  test("is idempotent and fully reversible", () => {
    const once = applyInserts({ editList: edl(), words, document: doc([clip("i1", "w1"), clip("i2", "w2", 2)]), assets });
    const twice = applyInserts({ editList: once, words, document: doc([clip("i1", "w1"), clip("i2", "w2", 2)]), assets });
    expect(twice.segments).toEqual(once.segments);
    const cleared = applyInserts({ editList: once, words, document: doc([]), assets });
    expect(cleared.segments.map(s => [s.id, s.sourceStart, s.sourceEnd, s.timelineStart])).toEqual(edl().segments.map(s => [s.id, s.sourceStart, s.sourceEnd, s.timelineStart]));
    expect(cleared.sources!.map(s => s.path)).toEqual([VOICE]);
    expect(stripInserts(once).length).toBe(2);
  });

  test("two inserts in one segment keep narration order", () => {
    const moreWords = [word("x1", 0, 0.5), word("gx", 0.5, 0.8, true), word("x2", 0.8, 1.4), word("gy", 1.4, 1.8, true), word("x3", 1.8, 2.4)];
    const out = applyInserts({ editList: edl(), words: moreWords, document: doc([clip("i2", "x2", 1), clip("i1", "x1", 1)]), assets });
    expect(out.segments.map(s => s.id)).toEqual(["a-roll-0001", "insert-i1", "a-roll-0001~i1", "insert-i2", "a-roll-0001~i2", "a-roll-0002"]);
    const narration = out.segments.filter(s => s.source === VOICE);
    for (let i = 1; i < narration.length; i++) expect(narration[i]!.sourceStart).toBeGreaterThanOrEqual(narration[i - 1]!.sourceEnd);
  });

  test("subtitles after the insert move by the clip length", () => {
    const out = parseEditListDocument(applyInserts({ editList: edl(), words, document: doc([clip("i1", "w1")]), assets }));
    const subs = { schemaVersion: 1, projectId: "p", baseTranscriptRevision: REV, style: {}, cues: [{ id: "c1", wordIds: ["w1"], text: "a" }, { id: "c2", wordIds: ["w2"], text: "b" }] } as any;
    const t = subtitleCueTimings(subs, words, out);
    expect(t.find(x => x.cueId === "c1")!.start).toBe(0);
    expect(t.find(x => x.cueId === "c2")!.start).toBeCloseTo(6.6, 6);
  });

  test("rejects cut anchors, gaps, missing assets and silent media", () => {
    const cutEdl = parseEditListDocument({ ...edl(), segments: [{ ...edl().segments[1]!, timelineStart: 0 }], duration: 1 });
    expect(() => applyInserts({ editList: cutEdl, words, document: doc([clip("i1", "w1")]), assets })).toThrow(/cut from the edit/);
    expect(() => applyInserts({ editList: edl(), words, document: doc([clip("i1", "g1")]), assets })).toThrow(/not a spoken word/);
    expect(() => applyInserts({ editList: edl(), words, document: doc([clip("i1", "w1")]), assets: new Map() })).toThrow(/unimported/);
    expect(() => applyInserts({ editList: edl(), words, document: doc([clip("i1", "w1")]), assets: new Map([[ASSET, { duration: 20, hasAudio: false }]]) })).toThrow(/no audio/);
    expect(() => applyInserts({ editList: edl(), words, document: doc([clip("i1", "w1", 30)]), assets })).toThrow(/exceeds/);
  });
});

describe("insert document and layers", () => {
  test("validates shape", () => {
    expect(assertInsertDocument(doc([clip("i1", "w1")])).inserts).toHaveLength(1);
    expect(() => assertInsertDocument(doc([clip("i1", "w1"), clip("i1", "w2")]))).toThrow(/unique/);
    expect(() => assertInsertDocument(doc([clip("i1", "w1"), clip("i2", "w1")]))).toThrow(/anchor/);
    expect(() => assertInsertDocument(doc([{ ...clip("i1", "w1"), gainDb: 3 }]))).toThrow(/gainDb/);
  });

  test("derives one media layer per inserted clip", () => {
    const out = applyInserts({ editList: edl(), words, document: doc([{ ...clip("i1", "w1"), fit: "cover" }]), assets });
    expect(insertMediaLayers(out, doc([{ ...clip("i1", "w1"), fit: "cover" }]))).toEqual([
      { layerId: "insert:i1", media: { assetId: ASSET, sourceIn: 0, sourceOut: 5, fit: "cover", muted: true }, start: 1.3, end: 6.3, duration: 5 },
    ]);
    expect(insertMediaLayers(edl())).toEqual([]);
  });
});

describe("followCutAnchors", () => {
  const narration = (ranges: Array<[number, number]>) => ranges.map(([a, b], i) => ({ id: `n${i}`, source: VOICE, sourceStart: a, sourceEnd: b,
    timelineStart: 0, trackId: "a-roll", playbackRate: 1, instanceId: "original" })) as EditListSegment[];
  test("keeps anchors that still play", () => {
    const out = followCutAnchors(doc([clip("i1", "w2")]), words, narration([[0, 4]]));
    expect(out.moved).toEqual([]);
    expect(out.document.inserts[0]!.afterWordId).toBe("w2");
  });
  test("moves a cut anchor back to the nearest playing word", () => {
    const out = followCutAnchors(doc([clip("i1", "w2")]), words, narration([[0, 1.3], [3, 4]]));
    expect(out.moved).toEqual([{ insertId: "i1", fromWordId: "w2", toWordId: "w1", toWordText: "w1" }]);
  });
  test("skips words another insert already follows, then looks forward", () => {
    const out = followCutAnchors(doc([clip("i1", "w1"), clip("i2", "w2")]), words, narration([[0, 1.3], [3, 4]]));
    expect(out.document.inserts.map(i => i.afterWordId)).toEqual(["w1", "w3"]);
  });
  test("refuses in plain words when nothing is left to follow", () => {
    expect(() => followCutAnchors(doc([clip("i1", "w1"), clip("i2", "w2")]), words, narration([[0, 1.3]]))).toThrow(/已经没有可以跟随的口播/);
  });
});

describe("range edits on a narration with inserts", () => {
  const { applyEditListOperation } = require("./editList") as typeof import("./editList");
  const placed = () => applyInserts({ editList: { ...edl(), mode: "manual" }, words, document: doc([clip("i1", "w1")]), assets });
  const view = (d: EditListDocument) => d.segments.map(s => [s.instanceId, s.sourceStart, s.sourceEnd]);

  test("deleting narration keeps the clip after the narration it followed", () => {
    const out = applyEditListOperation(placed(), { type: "delete-range", source: VOICE, sourceStart: 1.6, sourceEnd: 2.4 });
    expect(view(out)).toEqual([["original", 0, 1.3], ["insert:i1", 0, 5], ["original", 1.3, 1.6], ["original", 3, 4]]);
    expect(out.schemaVersion).toBe(2);
  });

  test("deleting the narration a clip follows moves the clip to the nearest earlier narration", () => {
    const out = applyEditListOperation(placed(), { type: "delete-range", source: VOICE, sourceStart: 0.9, sourceEnd: 1.6 });
    expect(view(out)).toEqual([["original", 0, 0.9], ["insert:i1", 0, 5], ["original", 1.6, 2.4], ["original", 3, 4]]);
  });

  test("restoring a range keeps the clip in place", () => {
    const out = applyEditListOperation(placed(), { type: "restore", source: VOICE, sourceStart: 2.4, sourceEnd: 3, previousSegmentId: "a-roll-0001~i1", nextSegmentId: "a-roll-0002" } as any);
    const ids = out.segments.map(s => s.instanceId);
    expect(ids.filter(i => i === "insert:i1")).toHaveLength(1);
    expect(out.segments.find(s => s.instanceId === "insert:i1")!.timelineStart).toBeCloseTo(1.3, 6);
    expect(out.duration).toBeCloseTo(8.4 + 0.6, 6);
  });
});
