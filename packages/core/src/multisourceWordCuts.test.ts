import { describe, expect, test } from "bun:test";
import { buildMultisourceWordCuts, buildMultisourceSegmentCuts, type MultisourceWordCutsInput } from "./multisourceWordCuts";
import { parseEditListDocument } from "./editList";
import { createSubtitleDocument } from "./subtitles";
import type { TimedWord } from "./cuts";

const w = (id: string, instanceId: string, start: number, end: number, source = "a.wav"): TimedWord =>
  ({ id, instanceId, source, sourceWordId: `source-${start}`, start, end, text: id, isGap: false });
function fixture(): MultisourceWordCutsInput {
  const words = [w("new", "new", 0, 1, "b.wav"), w("a0", "old", 0, 1), w("a1", "old", 1, 2), w("a2", "old", 2, 3), w("repeat", "repeat", 0, 1)];
  const editList = parseEditListDocument({ schemaVersion: 2, projectId: "p", sourceDuration: 10,
    sources: ["a.wav", "b.wav"].map(path => ({ path, sha256: "a".repeat(64), duration: 10, mediaKind: "audio" })),
    baseTranscriptRevision: "b".repeat(64), baseCutsRevision: "c".repeat(64), mode: "manual", duration: 5,
    segments: [
      { id: "head", source: "b.wav", instanceId: "new", sourceStart: 0, sourceEnd: 1, timelineStart: 0 },
      { id: "body", source: "a.wav", instanceId: "old", sourceStart: 0, sourceEnd: 3, timelineStart: 1 },
      { id: "again", source: "a.wav", instanceId: "repeat", sourceStart: 0, sourceEnd: 1, timelineStart: 4 },
    ].map(s => ({ ...s, trackId: "a-roll", playbackRate: 1 })) });
  return { editList, words, cutSelection: { schemaVersion: 3, cutWordIds: ["historic"], cutRanges: [{ start: 7, end: 8, source: "a.wav", instanceId: "old" }],
    reasons: [{ wordIds: ["historic"], kind: "manual", risk: "high" }], extra: { preserved: true } },
    subtitles: null, visuals: null, wordIds: ["a1"], operationId: "op" };
}
function media(input: MultisourceWordCutsInput, wordIds = ["a0", "a1", "a2"]) {
  input.visuals = { schemaVersion: 1, projectId: "p", baseTranscriptRevision: "b".repeat(64), animationStyle: "xiaohei",
    layers: [{ id: "video", wordIds, media: { assetId: "d".repeat(64), sourceIn: 5, sourceOut: 8, fit: "cover", muted: true } }] };
}
describe("instance-aware word cuts preserve current manual EDL", () => {
  test("explicit segment deletion includes untranscribed gaps and preserves other instances", () => {
    const input = fixture(); input.words = [...input.words, { ...w("gap", "old", 1.2, 1.4), isGap: true }];
    media(input); input.subtitles = createSubtitleDocument("p", "b".repeat(64), input.words, input.editList);
    input.subtitles.cues = [{ id: "gone", wordIds: ["a0", "a1", "a2"], text: "人工整屏" }, { id: "stay", wordIds: ["repeat"], text: "保留" }];
    const frozen = JSON.stringify(input), result = buildMultisourceSegmentCuts({ ...input, clipIds: ["body"] });
    expect(JSON.stringify(input)).toBe(frozen);
    expect(result.editList.segments.map(s => s.id)).toEqual(["head", "again"]);
    expect(result.editList.segments[1]).toMatchObject({ sourceStart: 0, sourceEnd: 1, instanceId: "repeat", timelineStart: 1 });
    expect(result.summary.removedDuration).toBe(3);
    expect(result.summary.removedRanges).toEqual([{ start: 0, end: 3, source: "a.wav", instanceId: "old" }]);
    expect(result.summary.removedWords!.find(w => w.wordId === "gap")!.isGap).toBe(true);
    expect(result.summary.removedVisualIds).toEqual(["video"]);
    expect(result.summary.removedSubtitleIds).toEqual(["gone"]);
    expect(result.subtitles!.cues).toEqual([input.subtitles.cues[1]!]);
    expect(result.subtitles!.style).toEqual(input.subtitles.style);
    expect(result.cutSelection.cutWordIds).not.toContain("repeat");
    for (const clipIds of [[], ["missing"], ["body", "body"], ["head", "body", "again"]]) expect(() => buildMultisourceSegmentCuts({ ...input, clipIds })).toThrow();
  });
  test("segment boundaries cannot bypass partial subtitle or internal media guards", () => {
    const input = fixture();
    const body = input.editList.segments[1]!;
    input.editList.segments.splice(1, 1, ...[0, 1, 2].map(i => ({ ...body, id: `body-${i}`, sourceStart: i, sourceEnd: i + 1, timelineStart: i + 1 })));
    media(input);
    expect(() => buildMultisourceSegmentCuts({ ...input, clipIds: ["body-1"] })).toThrow("Internal media deletion");
    const explicit = buildMultisourceSegmentCuts({ ...input, clipIds: ["body-1"], removeVisualLayerIds: ["video"] });
    expect(explicit.visuals!.layers).toEqual([]);
    expect(explicit.summary.visualChanges).toMatchObject([{ layerId: "video", action: "remove", after: null }]);
    expect(() => buildMultisourceSegmentCuts({ ...input, clipIds: ["head"], removeVisualLayerIds: ["video"] })).toThrow("affected by the selected clips");
    expect(() => buildMultisourceSegmentCuts({ ...input, clipIds: ["body-1"], removeVisualLayerIds: ["missing"] })).toThrow("affected by the selected clips");
    expect(() => buildMultisourceSegmentCuts({ ...input, clipIds: ["body-1"], removeVisualLayerIds: ["video", "video"] })).toThrow("unique");
    expect(buildMultisourceSegmentCuts({ ...input, clipIds: ["body-0"] }).visuals!.layers[0]!.media).toMatchObject({ sourceIn: 6, sourceOut: 8 });
    input.visuals = null; input.subtitles = createSubtitleDocument("p", "b".repeat(64), input.words, input.editList);
    input.subtitles.cues = [{ id: "partial", wordIds: ["a0", "a1"], text: "不可重写" }];
    expect(() => buildMultisourceSegmentCuts({ ...input, clipIds: ["body-0"] })).toThrow("Partial subtitle");
  });
  test("same source and original word ids do not cut another instance; head and old cuts preserved", () => {
    const input = fixture(); input.wordIds = ["a0"];
    const frozen = JSON.stringify(input), result = buildMultisourceWordCuts(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(result.editList.segments[0]).toEqual(input.editList.segments[0]);
    expect(result.editList.segments[1]).toMatchObject({ id: "body", sourceStart: 1, sourceEnd: 3, instanceId: "old", timelineStart: 1 });
    expect(result.editList.segments[2]).toMatchObject({ id: "again", sourceStart: 0, sourceEnd: 1, instanceId: "repeat", timelineStart: 3 });
    expect(result.cutSelection.cutWordIds).toEqual(["historic", "a0"]);
    expect(result.cutSelection.cutRanges![0]).toEqual(input.cutSelection.cutRanges![0]);
    expect(result.cutSelection.reasons![0]).toEqual(input.cutSelection.reasons![0]);
    expect(result.cutSelection.cutRanges![1]).toEqual({ start: 0, end: 1, source: "a.wav", instanceId: "old" });
    expect(result.summary.removedDuration).toBe(1);
    expect(result.editList.baseCutsRevision).toBe(input.editList.baseCutsRevision);
  });
  test("manual trim and reordered clips survive, splits deterministic", () => {
    const input = fixture(); input.editList.segments[1]!.sourceStart = 0.25;
    input.editList.segments[1]!.sourceEnd = 2.75; input.editList.segments[2]!.timelineStart = 3.5; input.editList.duration = 4.5;
    const result = buildMultisourceWordCuts(input);
    expect(result.editList.segments.map(s => [s.id, s.sourceStart, s.sourceEnd])).toEqual([
      ["head", 0, 1], ["body", 0.25, 1], ["wordcut-op:body:1", 2, 2.75], ["again", 0, 1],
    ]);
    expect(buildMultisourceWordCuts(input)).toEqual(result);
    const reverse = fixture(); reverse.editList.segments = [reverse.editList.segments[2]!, reverse.editList.segments[1]!, reverse.editList.segments[0]!];
    reverse.editList.segments.forEach((s, i) => s.timelineStart = [0, 1, 4][i]!);
    expect(buildMultisourceWordCuts(reverse).editList.segments.map(s => s.id)).toEqual(["again", "body", "wordcut-op:body:1", "head"]);
  });
  test("whole subtitle deletion preserves unaffected manual text and partial refuses", () => {
    const input = fixture(); input.subtitles = createSubtitleDocument("p", "b".repeat(64), input.words, input.editList);
    input.subtitles.cues = [{ id: "gone", wordIds: ["a1"], text: "人工整屏" }, { id: "stay", wordIds: ["new"], text: "保留改字" }];
    const result = buildMultisourceWordCuts(input);
    expect(result.subtitles!.cues).toEqual([input.subtitles.cues[1]!]);
    expect(result.subtitles!.style).toEqual(input.subtitles.style);
    input.subtitles.cues[0]!.wordIds.push("a2");
    expect(() => buildMultisourceWordCuts(input)).toThrow("Partial subtitle");
  });
  test("MP4 prefix/suffix preserve source clock; internal hole rejects", () => {
    const input = fixture(); media(input); input.wordIds = ["a0"];
    expect(buildMultisourceWordCuts(input).visuals!.layers[0]!.media).toMatchObject({ sourceIn: 6, sourceOut: 8 });
    input.wordIds = ["a2"];
    expect(buildMultisourceWordCuts(input).visuals!.layers[0]!.media).toMatchObject({ sourceIn: 5, sourceOut: 7 });
    input.wordIds = ["a1"];
    expect(() => buildMultisourceWordCuts(input)).toThrow("Internal media deletion");
    input.wordIds = ["a0", "a1", "a2"];
    expect(buildMultisourceWordCuts(input).visuals!.layers).toEqual([]);
  });
  test("HTML partial rejects and whole layer deletes", () => {
    const input = fixture(); media(input); delete input.visuals!.layers[0]!.media; input.visuals!.layers[0]!.module = "modules/scene.html";
    expect(() => buildMultisourceWordCuts(input)).toThrow("Partial HTML");
    input.wordIds = ["a0", "a1", "a2"];
    expect(buildMultisourceWordCuts(input).visuals!.layers).toEqual([]);
  });
  test("gap-only deletion inside subtitle/media interval cannot evade guards", () => {
    const input = fixture(); input.words = [...input.words, { ...w("gap", "old", 1.4, 1.6), isGap: true }]; input.wordIds = ["gap"];
    media(input, ["a0", "a2"]);
    expect(() => buildMultisourceWordCuts(input)).toThrow("Internal media deletion");
    input.visuals = null; input.subtitles = createSubtitleDocument("p", "b".repeat(64), input.words, input.editList);
    input.subtitles.cues = [{ id: "bridges-gap", wordIds: ["a0", "a2"], text: "人工" }];
    expect(() => buildMultisourceWordCuts(input)).toThrow("Partial subtitle");
  });
  test("bad requests, empty hits, all removed, duplicate ids and v1 reject", () => {
    for (const ids of [[], ["a0", "a0"], ["missing"], Array.from({ length: 501 }, (_, i) => `id${i}`)]) {
      const input = fixture(); input.wordIds = ids; expect(() => buildMultisourceWordCuts(input)).toThrow();
    }
    const input = fixture(); input.words = [...input.words, w("absent", "old", 8, 9)]; input.wordIds = ["absent"];
    expect(() => buildMultisourceWordCuts(input)).toThrow("no actual kept");
    input.wordIds = ["new", "a0", "a1", "a2", "repeat"];
    expect(() => buildMultisourceWordCuts(input)).toThrow("all retained");
    input.words = [...input.words, input.words[0]!]; expect(() => buildMultisourceWordCuts(input)).toThrow("ambiguous");
    const legacy = fixture(); legacy.editList = { ...legacy.editList, schemaVersion: 1, sources: undefined, segments: legacy.editList.segments.map(({ instanceId, ...s }) => s) };
    expect(() => buildMultisourceWordCuts(legacy)).toThrow("v2");
  });
});
