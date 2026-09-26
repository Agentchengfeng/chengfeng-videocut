import type { EditListDocument, EditListSegment } from "@video-workbench/contracts";
import type { TimedWord } from "./cuts";
import { parseEditListDocument, EDIT_LIST_MIN_SEGMENT_SECONDS } from "./editList";
import { VideocutError } from "./errors";
import { assertSubtitleDocument, subtitleCueTimings, segmentMatchesWord, wordPlays, type SubtitleDocument } from "./subtitles";
import { assertVisualDocument, visualLayerTimings, type VisualDocument, type VisualAnimationBinding } from "./visuals";

/** Only placement/authoring fields change; the existing layer identity and styling survive. */
export interface ReviewedVisualReplacement {
  layerId: string;
  module: string;
  expectedModuleDigest: string;
  wordIds: string[];
  animation: VisualAnimationBinding;
}

export function assertReviewedVisualReplacements(value: unknown): asserts value is ReviewedVisualReplacement[] {
  if (!Array.isArray(value) || value.length > 32) return fail("Require at most 32 reviewed visual replacements", { reason: "invalid_reviewed_visual_replacements" });
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(k => !["layerId", "module", "expectedModuleDigest", "wordIds", "animation"].includes(k))
      || typeof item.layerId !== "string" || !item.layerId.trim() || seen.has(item.layerId)
      || typeof item.module !== "string" || !/^modules\/published\/[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}\//.test(item.module)
      || typeof item.expectedModuleDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.expectedModuleDigest)
      || !Array.isArray(item.wordIds) || !item.wordIds.length || item.wordIds.length > 500
      || item.wordIds.some((id: unknown) => typeof id !== "string" || !id.trim()) || new Set(item.wordIds).size !== item.wordIds.length
      || !item.animation || typeof item.animation !== "object" || Array.isArray(item.animation)
      || Object.keys(item.animation).some(k => !["schemaVersion", "clock", "authoredDuration", "anchorWordIds", "canvas"].includes(k))
      || !Array.isArray(item.animation.anchorWordIds) || !item.animation.anchorWordIds.length
      || item.animation.anchorWordIds.length > 500) fail("Invalid reviewed visual replacement", { reason: "invalid_reviewed_visual_replacement", layerId: item?.layerId });
    try {
      assertVisualDocument({ schemaVersion: 1, projectId: "validation", baseTranscriptRevision: "a".repeat(64), animationStyle: "xiaohei",
        layers: [{ id: item.layerId, module: item.module, wordIds: item.wordIds, animation: item.animation }] });
    } catch {
      fail("Invalid reviewed animation binding", { reason: "invalid_reviewed_animation_binding", layerId: item.layerId,
        nextActions: ["provide_complete_local0_animation_binding"] });
    }
    seen.add(item.layerId);
  }
}

export type MultisourceCutSelection = Record<string, unknown> & {
  cutWordIds: string[];
  cutRanges?: Array<{ start: number; end: number; source?: string; instanceId?: string }>;
  reasons?: Array<{ wordIds: string[]; kind: string; risk: "low" | "high"; [key: string]: unknown }>;
};
export interface MultisourceWordCutsInput {
  editList: EditListDocument;
  words: readonly TimedWord[];
  cutSelection: MultisourceCutSelection;
  subtitles: SubtitleDocument | null;
  visuals: VisualDocument | null;
  wordIds: readonly string[];
  operationId: string;
  reviewedVisualReplacements?: readonly ReviewedVisualReplacement[];
}
type Interval = { start: number; end: number };
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const EPS = 0.000001;
const fail = (message: string, details?: Record<string, unknown>): never => { throw new VideocutError("invalid_argument", message, details); };
function union(ranges: Interval[]): Interval[] {
  const output: Interval[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = output.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else output.push({ ...range });
  }
  return output;
}
function subtract(range: Interval, cuts: Interval[]): Interval[] {
  const output: Interval[] = [];
  let cursor = range.start;
  for (const cut of cuts) {
    if (cut.end <= cursor || cut.start >= range.end) continue;
    if (cut.start > cursor) output.push({ start: cursor, end: Math.min(cut.start, range.end) });
    cursor = Math.max(cursor, Math.min(cut.end, range.end));
  }
  if (cursor < range.end) output.push({ start: cursor, end: range.end });
  return output;
}
const size = (ranges: Interval[]) => ranges.reduce((n, r) => n + r.end - r.start, 0);

/** Deterministic geometry only. The transaction owner binds serialized Cuts revision and assets. */
export function buildMultisourceWordCuts(input: MultisourceWordCutsInput) {
  return buildMultisourceCuts(input);
}

export type MultisourceSegmentCutsInput = Omit<MultisourceWordCutsInput, "wordIds"> & { clipIds: readonly string[]; removeVisualLayerIds?: readonly string[] };
/** Explicit whole clips, including their gaps. Never inferred from a word selection. */
export function buildMultisourceSegmentCuts(input: MultisourceSegmentCutsInput) {
  return buildMultisourceCuts({ ...input, wordIds: [] }, input.clipIds, input.removeVisualLayerIds);
}

function buildMultisourceCuts(input: MultisourceWordCutsInput, clipIds?: readonly string[], removeVisualLayerIds: readonly string[] = []) {
  const replacements = input.reviewedVisualReplacements ?? [];
  assertReviewedVisualReplacements(replacements);
  const before = parseEditListDocument(input.editList);
  if (before.schemaVersion !== 2) fail("Word cuts require edit-list v2");
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(input.operationId)) fail("Invalid word-cuts operationId");
  if (clipIds !== undefined && (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > 500 || clipIds.some(id => typeof id !== "string" || !id.trim()) || new Set(clipIds).size !== clipIds.length)) fail("Require 1..500 unique clipIds");
  if (!Array.isArray(removeVisualLayerIds) || removeVisualLayerIds.length > 500 || removeVisualLayerIds.some(id => typeof id !== "string" || !id.trim()) || new Set(removeVisualLayerIds).size !== removeVisualLayerIds.length) fail("Require at most 500 unique removeVisualLayerIds");
  if (clipIds === undefined && (!Array.isArray(input.wordIds) || input.wordIds.length === 0 || input.wordIds.length > 500
    || input.wordIds.some(id => typeof id !== "string" || !id.trim()) || new Set(input.wordIds).size !== input.wordIds.length)) fail("Require 1..500 unique wordIds");
  for (const id of clipIds ?? []) if (!before.segments.some(s => s.id === id)) fail("Unknown clipId", { clipId: id });
  if (!input.cutSelection || !Array.isArray(input.cutSelection.cutWordIds)
    || input.cutSelection.cutWordIds.some(id => typeof id !== "string")
    || input.cutSelection.cutRanges !== undefined && !Array.isArray(input.cutSelection.cutRanges)
    || input.cutSelection.reasons !== undefined && !Array.isArray(input.cutSelection.reasons)) fail("Invalid cut selection");
  const byId = new Map<string, TimedWord>();
  const instanceSources = new Map(before.segments.map(s => [s.instanceId!, s.source]));
  for (const word of input.words) {
    const source = before.sources!.find(s => s.path === word.source);
    if (!word.id?.trim() || byId.has(word.id) || !word.sourceWordId?.trim() || !word.instanceId?.trim() || !source
      || instanceSources.has(word.instanceId) && instanceSources.get(word.instanceId) !== word.source
      || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > source.duration + EPS) fail("Invalid or ambiguous multisource word identity", { wordId: word.id });
    byId.set(word.id, word);
  }
  const selected = input.wordIds.map(id => byId.get(id) ?? fail("Unknown wordId", { wordId: id }));
  const removedTimeline: Interval[] = [];
  const addedRanges: NonNullable<MultisourceCutSelection["cutRanges"]> = [];
  const nextSegments: EditListSegment[] = [];
  const reservedIds = new Set(before.segments.map(s => s.id));
  let cursor = 0;
  for (const segment of before.segments) {
    const cuts = clipIds !== undefined ? (clipIds.includes(segment.id) ? [{ start: segment.sourceStart, end: segment.sourceEnd }] : []) : union(selected.filter(w => segmentMatchesWord(segment, w)).map(w => ({
      start: Math.max(segment.sourceStart, w.start), end: Math.min(segment.sourceEnd, w.end),
    })).filter(r => r.end > r.start));
    for (const cut of cuts) {
      addedRanges.push({ ...cut, source: segment.source, instanceId: segment.instanceId });
      removedTimeline.push({ start: round(segment.timelineStart + cut.start - segment.sourceStart), end: round(segment.timelineStart + cut.end - segment.sourceStart) });
    }
    const pieces = subtract({ start: segment.sourceStart, end: segment.sourceEnd }, cuts);
    for (const [i, piece] of pieces.entries()) {
      if (piece.end - piece.start < EDIT_LIST_MIN_SEGMENT_SECONDS - EPS) fail("Word cut would leave a sub-minimum fragment; select an explicit reviewed range instead", { segmentId: segment.id });
      const id = i === 0 ? segment.id : `wordcut-${input.operationId}:${segment.id}:${i}`;
      if (i > 0 && reservedIds.has(id)) fail("Word cut segment namespace collision", { segmentId: id });
      reservedIds.add(id);
      nextSegments.push({ ...segment, id, sourceStart: round(piece.start), sourceEnd: round(piece.end), timelineStart: round(cursor) });
      cursor = round(cursor + piece.end - piece.start);
    }
  }
  if (!addedRanges.length) fail("Selected words have no actual kept intersections");
  if (!nextSegments.length) fail("Word cuts cannot remove all retained content");
  const editList = parseEditListDocument({ ...before, mode: "manual", segments: nextSegments, duration: cursor });
  const cuts = union(removedTimeline);
  const mapTime = (time: number) => round(time - cuts.reduce((sum, cut) => sum + Math.max(0, Math.min(time, cut.end) - cut.start), 0));
  const intersects = (range: Interval) => size(subtract(range, cuts)) < range.end - range.start - EPS;
  const oldVisualTimings = input.visuals ? visualLayerTimings(input.visuals, input.words, before) : [];
  const interval = (t: Interval) => ({ start: round(t.start), end: round(t.end), duration: round(t.end - t.start) });
  const visualDetails = (reason: string, layerId: string, old: Interval, expected: Interval, actual?: Interval, extra?: Record<string, unknown>) => ({
    reason, layerId, timings: { before: interval(old), expected: interval(expected), ...(actual ? { actual: interval(actual),
      delta: { start: round(actual.start - expected.start), end: round(actual.end - expected.end) } } : {}) },
    nextActions: reason === "partial_html_requires_reviewed_animation" ? ["publish_and_review_replacement_animation", "resubmit_same_selection_with_reviewedVisualReplacements"]
      : ["inspect_reported_visual_boundaries", "review_animation_mapping_before_replanning"], ...extra,
  });
  for (const replacement of replacements) {
    const layer = input.visuals?.layers.find(l => l.id === replacement.layerId);
    const timing = oldVisualTimings.find(t => t.layerId === replacement.layerId);
    if (!layer || layer.media || !timing || timing.orphaned || !intersects(timing) || !subtract(timing, cuts).length
      || removeVisualLayerIds.includes(replacement.layerId)
      || !layer.wordIds.some(id => { const w = byId.get(id); return w && wordPlays(editList.segments, w); }))
      return fail("Replacement must name a partially affected retained HTML layer", { reason: "replacement_outside_cut_scope", layerId: replacement.layerId,
        nextActions: ["replace_only_partially_affected_html_layers"] });
    // Keep the exact surviving anchor set and order: this is not a general visual rebind endpoint.
    const retainedIds = layer.wordIds.filter(id => { const w = byId.get(id); return w && wordPlays(editList.segments, w); });
    if (JSON.stringify(replacement.wordIds) !== JSON.stringify(retainedIds)) fail("Replacement wordIds must be the original layer's surviving words in order", {
      reason: "replacement_anchor_scope_mismatch", layerId: replacement.layerId, expectedWordIds: retainedIds, nextActions: ["use_exact_surviving_layer_wordIds"] });
  }
  for (const id of removeVisualLayerIds) {
    const timing = input.visuals && visualLayerTimings(input.visuals, input.words, before).find(t => t.layerId === id);
    if (!timing || timing.orphaned || !intersects(timing)) fail("Explicit visual removal must name a layer affected by the selected clips", { layerId: id });
  }
  const removedSubtitleIds: string[] = [], removedVisualIds: string[] = [], trimmedMediaIds: string[] = [];
  let subtitles: SubtitleDocument | null = null;
  if (input.subtitles) {
    assertSubtitleDocument(input.subtitles);
    const timings = subtitleCueTimings(input.subtitles, input.words, before);
    subtitles = { ...input.subtitles, cues: input.subtitles.cues.filter((cue, i) => {
      const old = timings[i]!;
      if (old.orphaned) return true;
      if (!cue.wordIds.some(id => { const w = byId.get(id); return w && wordPlays(editList.segments, w); })) { removedSubtitleIds.push(cue.id); return false; }
      if (intersects(old)) fail("Partial subtitle deletion requires reviewed text", { cueId: cue.id });
      return true;
    }) };
    const next = new Map(subtitleCueTimings(subtitles, input.words, editList).map(t => [t.cueId, t]));
    for (const old of timings) {
      if (old.orphaned || removedSubtitleIds.includes(old.cueId)) continue;
      const now = next.get(old.cueId)!;
      if (now.orphaned || Math.abs(now.start - mapTime(old.start)) > EPS || Math.abs(now.end - mapTime(old.end)) > EPS) fail("Cannot preserve subtitle mapping", { cueId: old.cueId });
    }
  }
  let visuals: VisualDocument | null = null;
  const expectedVisuals = new Map<string, Interval>();
  if (input.visuals) {
    assertVisualDocument(input.visuals);
    const timings = oldVisualTimings;
    visuals = { ...input.visuals, layers: input.visuals.layers.flatMap((layer, i) => {
      const old = timings[i]!;
      if (old.orphaned) return [layer];
      if (removeVisualLayerIds.includes(layer.id)) { removedVisualIds.push(layer.id); return []; }
      if (!layer.wordIds.some(id => { const w = byId.get(id); return w && wordPlays(editList.segments, w); })) { removedVisualIds.push(layer.id); return []; }
      const surviving = subtract(old, cuts);
      if (!surviving.length) { removedVisualIds.push(layer.id); return []; }
      if (!intersects(old)) { expectedVisuals.set(layer.id, { start: mapTime(old.start), end: mapTime(old.end) }); return [layer]; }
      const expected = { start: mapTime(old.start), end: mapTime(old.end) };
      const replacement = replacements.find(r => r.layerId === layer.id);
      if (replacement) {
        expectedVisuals.set(layer.id, expected);
        return [{ ...layer, module: replacement.module, wordIds: [...replacement.wordIds], animation: replacement.animation }];
      }
      const media = layer.media ?? fail("Partial HTML deletion requires a reviewed animation", visualDetails("partial_html_requires_reviewed_animation", layer.id, old, expected));
      if (surviving.length !== 1) fail("Internal media deletion cannot preserve source clock", { layerId: layer.id });
      const kept = surviving[0]!;
      expectedVisuals.set(layer.id, { start: mapTime(kept.start), end: mapTime(kept.end) });
      trimmedMediaIds.push(layer.id);
      return [{ ...layer, media: { ...media, sourceIn: round(media.sourceIn + kept.start - old.start),
        sourceOut: round(media.sourceIn + kept.end - old.start) } }];
    }) };
    assertVisualDocument(visuals);
    for (const now of visualLayerTimings(visuals, input.words, editList)) {
      const expected = expectedVisuals.get(now.layerId);
      const old = timings.find(t => t.layerId === now.layerId)!;
      if (expected && (now.orphaned || Math.abs(now.start - expected.start) > EPS || Math.abs(now.end - expected.end) > EPS)) fail("Cannot preserve visual mapping and internal clock",
        visualDetails("visual_mapping_changed", now.layerId, old, expected, now, { directlyIntersectsCut: intersects(old),
          possibleGapAbsorption: !input.visuals.layers.find(l => l.id === now.layerId)?.animation && !input.visuals.layers.find(l => l.id === now.layerId)?.media }));
      if (replacements.some(r => r.layerId === now.layerId) && (!now.animation || now.animation.issues.length
        || Math.abs(now.animation.authoredDuration - now.duration) > EPS)) fail("Reviewed animation does not match the retained visual clock",
        visualDetails("replacement_animation_clock_mismatch", now.layerId, old, expected!, now, { issues: now.animation?.issues ?? ["missing_animation"], authoredDuration: now.animation?.authoredDuration }));
    }
  }
  const deletedWordIds = clipIds === undefined ? [...input.wordIds] : input.words.filter(w => wordPlays(before.segments, w) && !wordPlays(editList.segments, w)).map(w => w.id);
  const cutSelection: MultisourceCutSelection = { ...input.cutSelection,
    cutWordIds: [...new Set([...input.cutSelection.cutWordIds, ...deletedWordIds])],
    cutRanges: [...(input.cutSelection.cutRanges ?? []), ...addedRanges],
    reasons: [...(input.cutSelection.reasons ?? []), { wordIds: deletedWordIds, kind: clipIds === undefined ? "multisource-word-delete" : "multisource-segment-delete", risk: "low", operationId: input.operationId,
      ...(replacements.length ? { reviewedVisualReplacements: replacements } : {}),
      ...(clipIds === undefined ? {} : { clipIds: [...clipIds], removeVisualLayerIds: [...removeVisualLayerIds] }) }],
  };
  const affectedInstances = [...new Map(addedRanges.map(r => [JSON.stringify([r.source, r.instanceId]), { source: r.source!, instanceId: r.instanceId! }])).values()];
  return { editList, cutSelection, subtitles, visuals, summary: { removedDuration: round(before.duration - editList.duration),
    previousDuration: before.duration, duration: editList.duration, wordIds: deletedWordIds, affectedInstances,
    ...(clipIds === undefined ? {} : { clipIds: [...clipIds], removeVisualLayerIds: [...removeVisualLayerIds], removedSegments: before.segments.filter(s => clipIds.includes(s.id)), removedRanges: addedRanges,
      retainedVisualRemainders: trimmedMediaIds.map(id => { const expected = expectedVisuals.get(id)!; return { layerId: id, duration: round(expected.end - expected.start), ...expected }; }),
      warnings: trimmedMediaIds.filter(id => { const t = expectedVisuals.get(id)!; return t.end - t.start <= 0.1 + EPS; }).map(id => ({ code: "short_visual_remainder", layerId: id, duration: round(expectedVisuals.get(id)!.end - expectedVisuals.get(id)!.start), message: "Short visual remainder retained; explicitly select removeVisualLayerIds to remove the affected layer." })),
      visualChanges: [...removedVisualIds, ...trimmedMediaIds].map(id => ({ layerId: id, action: removedVisualIds.includes(id) ? "remove" : "trim", before: input.visuals!.layers.find(l => l.id === id), after: visuals!.layers.find(l => l.id === id) ?? null })),
      removedWords: input.words.flatMap(w => { const ranges = addedRanges.filter(r => r.source === w.source && r.instanceId === w.instanceId).map(r => ({ start: Math.max(r.start, w.start), end: Math.min(r.end, w.end) })).filter(r => r.end > r.start); return ranges.length ? [{ wordId: w.id, source: w.source, instanceId: w.instanceId, text: w.text, isGap: !!w.isGap, ranges }] : []; }) }),
    removedSubtitleIds, removedVisualIds, trimmedMediaIds,
    ...(replacements.length ? { reviewedVisualReplacements: replacements.map(r => ({ layerId: r.layerId, module: r.module, expectedModuleDigest: r.expectedModuleDigest,
      timing: expectedVisuals.get(r.layerId), animation: r.animation })) } : {}) } };
}
