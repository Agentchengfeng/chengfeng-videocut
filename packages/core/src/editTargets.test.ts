import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolveEditTargets, assertEditTargetQuery } from "./editTargets";
import { projectFilesRevision, TRANSACTION_FILES, type ProjectFiles } from "./projectTransaction";
import { createVisualDocument } from "./visuals";

const word = (id: string, start = 0, end = 1, source = "a.wav", instanceId = "A", text = "同句", isGap = false) =>
  ({ id, start, end, source, instanceId, sourceWordId: id.trim(), text, isGap });
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
function document(parts: Array<[string, string, number, number]> = [["a.wav", "A", 0, 10]]) {
  let duration = 0;
  const segments = parts.map(([source, instanceId, sourceStart, sourceEnd], i) => {
    const value = { id: `s${i}`, source, instanceId, sourceStart, sourceEnd, timelineStart: duration, trackId: "a-roll", playbackRate: 1 };
    duration += sourceEnd - sourceStart;
    return value;
  });
  return { schemaVersion: 2, projectId: "test", sourceDuration: 10,
    sources: ["a.wav", "b.wav"].map(path => ({ path, duration: 10, mediaKind: "audio", sha256: "a".repeat(64) })),
    baseCutsRevision: "b".repeat(64), baseTranscriptRevision: "c".repeat(64), mode: "manual", duration, segments };
}
function files(cues = [[word("a")]], edl = document()): ProjectFiles {
  const transcript = JSON.stringify({ cues: cues.map((words, i) => ({ id: `c${i}`, words })) });
  const cuts = JSON.stringify({ projectId: "test", cutWordIds: [] });
  return { ...Object.fromEntries(TRANSACTION_FILES.map(key => [key, null])),
    "transcript.json": transcript, "cut-selection.json": cuts,
    "edit-list.json": JSON.stringify({ ...edl, baseTranscriptRevision: hash(transcript), baseCutsRevision: hash(cuts) }) } as ProjectFiles;
}
const resolve = (input: ProjectFiles, query: unknown) => resolveEditTargets("isolated-target-fixture", "test", input, query);

describe("bounded, revision-bound edit targets", () => {
  test("same-time sources and repeated instances remain independently addressable", () => {
    const input = files([[word("b", 0, 1, "b.wav", "B")], [word("a2", 0, 1, "a.wav", "A2")], [word("a1")]],
      document([["a.wav", "A", 0, 1], ["b.wav", "B", 0, 1], ["a.wav", "A2", 0, 1]]));
    expect(resolve(input, { clipIds: ["s1"] }).matches[0]).toMatchObject({ wordIds: ["b"], clipIds: ["s1"] });
    expect(resolve(input, { timeline: { start: 2, end: 3 } }).matches[0]).toMatchObject({ wordIds: ["a2"], clipIds: ["s2"] });
    // Canonical Studio order is transcript document order, not source/timeline time.
    expect(resolve(input, { paragraphs: { start: 1, end: 3 } }).matches.map(m => m.wordIds)).toEqual([["b"], ["a2"], ["a1"]]);
    const repeated = resolve(input, { text: "同句" });
    expect(repeated.requiresSelection).toBe(true);
    expect(repeated.matches).toHaveLength(3);
  });

  test("clip lookup splits a coalesced playback word at its exact clip boundary", () => {
    const input = files([[word("a")]], document([["a.wav", "A", 0, .5], ["a.wav", "A", .5, 1]]));
    expect(resolve(input, { clipIds: ["s1"] }).matches[0]!.playback).toEqual([
      expect.objectContaining({ id: "a", segmentIds: ["s1"], sourceStart: .5, sourceEnd: 1, timelineStart: .5, timelineEnd: 1, seconds: .5 }),
    ]);
    expect(resolve(input, { timeline: { start: .1, end: .2 } }).matches[0]!.playback[0]!.segmentIds).toEqual(["s0"]);
  });

  test("paragraph playback follows a reordered EDL, while word IDs preserve document order", () => {
    const input = files([[word("early"), word("late", 2, 3)]], document([["a.wav", "A", 2, 3], ["a.wav", "A", 0, 1]]));
    const match = resolve(input, { paragraphs: { start: 1, end: 1 } }).matches[0]!;
    expect(match.wordIds).toEqual(["early", "late"]);
    expect(match.playback.map(e => e.id)).toEqual(["late", "early"]);
  });

  test("cut short gaps remain visible, but never merge into adjacent retained gaps", () => {
    const input = files([[word("cut-gap", 0, .1, "a.wav", "A", "", true)],
      [word("kept-gap", .1, .2, "a.wav", "A", "", true)], [word("speech", .2, 1)]],
      document([["a.wav", "A", .1, 1]]));
    const result = resolve(input, { paragraphs: { start: 1, end: 2 } });
    expect(result.totalParagraphs).toBe(2);
    expect(result.matches.map(m => [m.cueId, m.wordIds, m.removedWordIds])).toEqual([
      ["c0", [], ["cut-gap"]], ["c2", ["speech"], []],
    ]);
  });

  test("canonical paragraph fixture: cross-cue gap merging, hidden gaps, cut speech and normalized IDs", () => {
    const input = files([
      [word(" a "), word("g1", 1, 1.2, "a.wav", "A", "", true)],
      [word("g2", 1.2, 1.4, "a.wav", "A", "", true)],
      [word("deleted", 3, 4, "a.wav", "A", "删句")],
      [word("tiny", 5, 5.1, "a.wav", "A", "", true)],
      [word("last", 6, 7, "a.wav", "A", "末句")],
    ], document([["a.wav", "A", 0, 3], ["a.wav", "A", 4, 10]]));
    const result = resolve(input, { paragraphs: { start: 1, end: 3 } });
    expect(result.totalParagraphs).toBe(3);
    expect(result.matches.map(m => [m.cueId, m.wordIds, m.removedWordIds])).toEqual([
      ["c0", ["a", "g1", "g2"], []], ["c2", [], ["deleted"]], ["c4", ["last"], []],
    ]);
    expect(resolve(input, { text: "删句" }).matches[0]!.removedWordIds).toEqual(["deleted"]);
    expect(() => resolve(input, { paragraphs: { start: 4, end: 4 } })).toThrow("exceeds");
  });

  test("related cues/layers use real IDs and shared timing, including partial anchors", () => {
    const input = files([[word("a")], [word("b", 1, 2)]]);
    input["subtitles.json"] = JSON.stringify({ schemaVersion: 1, projectId: "test", baseTranscriptRevision: hash(input["transcript.json"]!), style: {}, cues: [{ id: "subtitle", text: "同句同句", wordIds: ["a", "b"] }] });
    input["visuals.json"] = JSON.stringify({ ...createVisualDocument("test", hash(input["transcript.json"]!)), layers: [{ id: "actual-layer", module: "modules/demo/index.html", wordIds: ["a", "b"] }] });
    const match = resolve(input, { paragraphs: { start: 1, end: 1 } }).matches[0]!;
    expect(match.subtitleCues).toEqual([expect.objectContaining({ id: "subtitle", selection: "partial", timing: expect.objectContaining({ cueId: "subtitle", start: 0, end: 2 }) })]);
    expect(match.visualLayers).toEqual([expect.objectContaining({ id: "actual-layer", selection: "partial", timing: expect.objectContaining({ layerId: "actual-layer", start: 0, end: 2 }) })]);
  });

  test("every transaction document participates in CAS even with a warm playback cache", () => {
    const input = files(), revision = resolve(input, { clipIds: ["s0"] }).revision;
    expect(revision).toBe(projectFilesRevision(input));
    expect(resolve(input, { clipIds: ["s0"], expectedRevision: revision }).revision).toBe(revision);
    for (const name of TRANSACTION_FILES) {
      expect(() => resolve({ ...input, [name]: (input[name] ?? "") + " " }, { clipIds: ["s0"], expectedRevision: revision })).toThrow("snapshot changed");
    }
  });

  test("a current snapshot revision cannot bless stale document bindings", () => {
    const input = files();
    resolve(input, { clipIds: ["s0"] }); // Warm derived cache must not bypass binding checks.
    for (const [name, field] of [["edit-list.json", "baseTranscriptRevision"], ["edit-list.json", "baseCutsRevision"],
      ["subtitles.json", "baseTranscriptRevision"], ["visuals.json", "baseTranscriptRevision"]] as const) {
      const document = name === "edit-list.json" ? JSON.parse(input[name]!) : name === "subtitles.json"
        ? { schemaVersion: 1, projectId: "test", style: {}, cues: [] }
        : createVisualDocument("test", hash(input["transcript.json"]!));
      for (const stale of ["d".repeat(64), undefined]) {
        const changed = { ...input, [name]: JSON.stringify({ ...document, [field]: stale }) };
        // EDL parser independently rejects missing mandatory revisions.
        if (name === "edit-list.json" && stale === undefined) {
          expect(() => resolve(changed, { clipIds: ["s0"] })).toThrow();
          continue;
        }
        try {
          resolve(changed, { clipIds: ["s0"], expectedRevision: projectFilesRevision(changed) });
          throw new Error("unexpected success");
        } catch (error: any) {
          expect(error.details).toMatchObject({ reason: "target_document_binding_stale", document: name, field });
        }
      }
    }
    for (const name of ["transcript.json", "cut-selection.json"] as const) {
      const changed = { ...input, [name]: input[name] + " " };
      expect(() => resolve(changed, { clipIds: ["s0"], expectedRevision: projectFilesRevision(changed) })).toThrow("stale");
    }
  });

  test("binding validation rejects unknown anchors and source overflow without requiring mutation-only fields", () => {
    const input = files(), revision = hash(input["transcript.json"]!);
    const subtitle = { schemaVersion: 1, projectId: "test", baseTranscriptRevision: revision, style: {}, cues: [{ id: "c", text: "a", wordIds: ["missing"] }] };
    const visual = { ...createVisualDocument("test", revision), layers: [{ id: "v", module: "v.html", wordIds: ["missing"] }] };
    for (const [name, document] of [["subtitles.json", subtitle], ["visuals.json", visual]] as const) {
      expect(() => resolve({ ...input, [name]: JSON.stringify(document) }, { clipIds: ["s0"] })).toThrow("invalid word references");
    }
    for (const ids of [["missing"], ["a", "a"]]) {
      const cuts = JSON.stringify({ cutWordIds: ids });
      const changed = { ...input, "cut-selection.json": cuts,
        "edit-list.json": JSON.stringify({ ...JSON.parse(input["edit-list.json"]!), baseCutsRevision: hash(cuts) }) };
      expect(() => resolve(changed, { clipIds: ["s0"] })).toThrow("invalid word references");
    }
    expect(() => resolve(files([[word("outside", 9, 11)]]), { clipIds: ["s0"] })).toThrow("invalid word references");
    // No operationId, confirmation, deletion list, or animation replacement is needed.
    expect(resolve(input, { text: "同句" }).matches).toHaveLength(1);
  });

  test("strict selectors, unsupported v1, and malformed/mismatched related documents fail closed", () => {
    for (const query of [null, [], {}, { text: "" }, { text: "a", clipIds: ["s0"] }, { clipIds: ["s0", "s0"] },
      { clipIds: [" s0"] }, { paragraphs: { start: 0, end: 1 } }, { paragraphs: { start: 1, end: 101 } },
      { timeline: { start: 0, end: 1, extra: true } }, { timeline: { start: 0, end: Infinity } },
      { text: "a", expectedRevision: "bad" }, { text: "a", extra: true }]) expect(() => assertEditTargetQuery(query)).toThrow();
    expect(() => resolve(files(), { clipIds: ["unknown"] })).toThrow("Unknown clipId");
    const { sources, ...v2 } = document();
    const legacy = { ...v2, schemaVersion: 1, segments: v2.segments.map(({ instanceId, ...segment }) => segment) };
    expect(() => resolve({ ...files(), "edit-list.json": JSON.stringify(legacy) }, { text: "同句" })).toThrow("requires EDL schemaVersion 2");
    for (const name of ["subtitles.json", "visuals.json"] as const) {
      for (const bad of ["{", "false", "[]", "{}", '{"schemaVersion":999}']) expect(() => resolve({ ...files(), [name]: bad }, { text: "同句" })).toThrow();
    }
    expect(() => resolve({ ...files(), "visuals.json": JSON.stringify(createVisualDocument("wrong", "a".repeat(64))) }, { text: "同句" })).toThrow("identity mismatch");
  });

  test("100 matches and 512 KiB response limits never silently truncate", () => {
    const input = files(Array.from({ length: 101 }, (_, i) => [word(`w${i}`, 0, 1)]));
    expect(() => resolve(input, { text: "同句" })).toThrow("Too many matches");
    expect(resolve(input, { paragraphs: { start: 1, end: 100 } }).matches).toHaveLength(100);
    expect(() => resolve(files([[word("huge", 0, 1, "a.wav", "A", "x".repeat(512 * 1024))]]), { clipIds: ["s0"] })).toThrow("exceeds bound");
  });
});
