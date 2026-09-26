import { createHash } from "node:crypto";
import { parseEditListDocument } from "./editList";
import { parseTranscriptWords } from "./cuts";
import { VideocutError } from "./errors";
import { assertVisualDocument, visualLayerTimings } from "./visuals";
import { assertSubtitleDocument, subtitleCueTimings } from "./subtitles";
import { projectFilesRevision, type ProjectFiles } from "./projectTransaction";
import { cachedPlaybackTranscript } from "./playbackCache";

export interface EditTargetQuery {
  clipIds?: string[];
  paragraphs?: { start: number; end: number };
  timeline?: { start: number; end: number };
  text?: string;
  expectedRevision?: string;
}
const fail = (message: string, details: Record<string, unknown> = {}): never => { throw new VideocutError("invalid_argument", message, details); };
export function assertEditTargetQuery(value: unknown): asserts value is EditTargetQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Target query must be an object");
  const q = value as Record<string, any>;
  if (Object.keys(q).some(k => !["clipIds", "paragraphs", "timeline", "text", "expectedRevision"].includes(k)) ||
    [q.clipIds, q.paragraphs, q.timeline, q.text].filter(v => v !== undefined).length !== 1) fail("Choose exactly one of clipIds, paragraphs, timeline or text");
  if (q.expectedRevision !== undefined && (typeof q.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(q.expectedRevision))) fail("Invalid expectedRevision");
  if (q.clipIds !== undefined && (!Array.isArray(q.clipIds) || !q.clipIds.length || q.clipIds.length > 100 ||
    q.clipIds.some((id: unknown) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256) || new Set(q.clipIds).size !== q.clipIds.length)) fail("Require 1..100 unique clipIds");
  if (q.text !== undefined && (typeof q.text !== "string" || !q.text.trim() || q.text.length > 200)) fail("Search text must contain 1..200 characters");
  for (const field of ["paragraphs", "timeline"] as const) if (q[field] !== undefined) {
    const range = q[field];
    if (!range || typeof range !== "object" || Array.isArray(range) || Object.keys(range).sort().join() !== "end,start" ||
      !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < (field === "paragraphs" ? 1 : 0) || range.end < range.start) fail(`Invalid ${field} range`);
    if (field === "paragraphs" && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.end - range.start >= 100)) fail("Select at most 100 one-based paragraphs");
    if (field === "timeline" && range.end <= range.start) fail("Timeline end must follow start");
  }
}

export function resolveEditTargets(directory: string, projectId: string, files: ProjectFiles, query: unknown) {
  assertEditTargetQuery(query);
  const revision = projectFilesRevision(files);
  if (query.expectedRevision !== undefined && query.expectedRevision !== revision) throw new VideocutError("revision_conflict", "Target snapshot changed; inspect the new targets before planning");
  const transcript = JSON.parse(files["transcript.json"] ?? "null");
  const words = parseTranscriptWords(transcript);
  const edl = parseEditListDocument(JSON.parse(files["edit-list.json"] ?? "null"));
  if (edl.projectId !== projectId) fail("Project identity mismatch");
  // This locator exposes precise playback instances. Do not infer v2 identity
  // from legacy rows whose playback stream does not carry segment positions.
  if (edl.schemaVersion !== 2) fail("Precise target lookup currently requires EDL schemaVersion 2", { reason: "target_schema_unsupported" });
  // A snapshot hash identifies bytes; it does not prove the documents agree.
  // Apply the existing multisource binding baseline before deriving targets,
  // without importing mutation-only planning/authorization requirements.
  const hash = (raw: string | null) => createHash("sha256").update(raw ?? "").digest("hex");
  const transcriptRevision = hash(files["transcript.json"]);
  const assertBinding = (document: string, field: string, actual: unknown, expected: string) => {
    if (actual !== expected) fail(`${document} has a stale ${field} binding`, {
      reason: "target_document_binding_stale", document, field, expectedRevision: expected,
      actualRevision: actual ?? null, nextActions: ["reconcile_project_document_bindings", "query_targets_again"],
    });
  };
  assertBinding("edit-list.json", "baseTranscriptRevision", edl.baseTranscriptRevision, transcriptRevision);
  assertBinding("edit-list.json", "baseCutsRevision", edl.baseCutsRevision, hash(files["cut-selection.json"]));
  const wordById = new Map(words.map(w => [w.id, w]));
  const badReference = (document: string, wordId?: string): never => fail(`${document} has invalid word references`, {
    reason: "target_document_binding_invalid", document, ...(wordId ? { wordId } : {}),
  });
  const instanceSources = new Map(edl.segments.map(s => [s.instanceId!, s.source]));
  for (const word of words) {
    const source = edl.sources!.find(s => s.path === word.source);
    if (!source || word.end > source.duration + .001 || !word.instanceId?.trim() || !word.sourceWordId?.trim()
      || (instanceSources.has(word.instanceId) && instanceSources.get(word.instanceId) !== word.source)) badReference("transcript.json", word.id);
    instanceSources.set(word.instanceId!, word.source!);
  }
  const cuts = JSON.parse(files["cut-selection.json"] ?? "null");
  if (!Array.isArray(cuts?.cutWordIds) || cuts.cutWordIds.some((id: unknown) => typeof id !== "string" || !wordById.has(id))
    || new Set(cuts.cutWordIds).size !== cuts.cutWordIds.length) badReference("cut-selection.json");
  if (cuts.projectId !== undefined && cuts.projectId !== projectId) fail("Cut selection project identity mismatch");
  const subtitles = files["subtitles.json"] === null ? null : JSON.parse(files["subtitles.json"]!);
  const visuals = files["visuals.json"] === null ? null : JSON.parse(files["visuals.json"]!);
  if (subtitles !== null) {
    assertSubtitleDocument(subtitles);
    if (subtitles.projectId !== projectId) fail("Subtitle project identity mismatch");
    assertBinding("subtitles.json", "baseTranscriptRevision", subtitles.baseTranscriptRevision, transcriptRevision);
    for (const cue of subtitles.cues) for (const id of cue.wordIds) if (!wordById.has(id)) badReference("subtitles.json", id);
  }
  if (visuals !== null) {
    assertVisualDocument(visuals);
    if (visuals.projectId !== projectId) fail("Visual project identity mismatch");
    assertBinding("visuals.json", "baseTranscriptRevision", visuals.baseTranscriptRevision, transcriptRevision);
    for (const layer of visuals.layers) for (const id of layer.wordIds) if (!wordById.has(id)) badReference("visuals.json", id);
  }
  const playback = cachedPlaybackTranscript(directory, projectId, files["transcript.json"]!, files["edit-list.json"]);
  const entries = playback.stream.filter((v): v is Extract<typeof v, { id: string }> => "id" in v);
  // Match Studio's canonical word-cue order, adjacent-gap merging and hidden
  // short-pause rows. No text-only/fallback transcript is accepted for editing.
  const cutIds = new Set(words.filter(w => !edl.segments.some(s => s.source === w.source && s.instanceId === w.instanceId &&
    w.start + (w.end - w.start) / 2 >= s.sourceStart && w.start + (w.end - w.start) / 2 < s.sourceEnd)).map(w => w.id));
  type Group = { cueId: string; wordIds: string[]; visible: boolean; text: string };
  const groups: Group[] = [];
  let previous: { id: string; source?: string; instanceId?: string; start: number; end: number; isGap?: boolean; group: Group } | undefined;
  for (const [i, cue] of transcript.cues.entries()) {
    const group: Group = { cueId: typeof cue.id === "string" ? cue.id : `cue-${i + 1}`, wordIds: [], visible: false, text: "" };
    groups.push(group);
    for (const raw of cue.words) {
      const parsed = wordById.get(raw.id.trim())!;
      // Studio treats a nonempty silent interval as a gap even without the
      // explicit flag, and drops empty zero-length display tokens.
      const word = { ...parsed, isGap: parsed.isGap || (!parsed.text?.trim() && parsed.end > parsed.start) };
      if (!word.isGap && !word.text?.trim()) continue;
      const joins = word.isGap && previous?.isGap && word.source === previous.source && word.instanceId === previous.instanceId &&
        word.start <= previous.end + .001 && cutIds.has(word.id) === cutIds.has(previous.id);
      if (joins && previous) {
        previous.end = Math.max(previous.end, word.end); previous.group.wordIds.push(word.id);
        if (previous.end - previous.start >= .35 || cutIds.has(word.id)) previous.group.visible = true;
      } else {
        group.wordIds.push(word.id); group.text += word.isGap ? "" : word.text ?? "";
        if (!word.isGap || word.end - word.start >= .35 || cutIds.has(word.id)) group.visible = true;
        previous = { ...word, group };
      }
    }
  }
  const paragraphs = groups.filter(g => g.wordIds.length && g.visible).map((g, i) => ({ ...g, paragraph: i + 1 }));
  const candidates: Array<{ paragraph?: number; cueId?: string; clipId?: string; entries: typeof entries; wordIds: string[]; text?: string }> = [];
  if (query.paragraphs || query.text !== undefined) {
    if (query.paragraphs && query.paragraphs.end > paragraphs.length) fail("Paragraph range exceeds the current Studio transcript", { totalParagraphs: paragraphs.length });
    for (const group of paragraphs) if (query.paragraphs ? group.paragraph >= query.paragraphs.start && group.paragraph <= query.paragraphs.end : group.text.includes(query.text!)) {
      const selectedIds = new Set(group.wordIds);
      candidates.push({ paragraph: group.paragraph, cueId: group.cueId, text: group.text,
        wordIds: group.wordIds, entries: entries.filter(entry => selectedIds.has(entry.id)) });
    }
  } else {
    if (query.clipIds) for (const id of query.clipIds) if (!edl.segments.some(s => s.id === id)) fail("Unknown clipId", { clipId: id });
    for (const segment of edl.segments) if (query.clipIds ? query.clipIds.includes(segment.id) :
      segment.timelineStart < query.timeline!.end && segment.timelineStart + segment.sourceEnd - segment.sourceStart > query.timeline!.start) {
      // Playback reconnects contiguous pieces of one word across split clips.
      // A clip locator must not leak the other half (or its segment identity).
      const selected = entries.filter(e => e.segmentIds?.includes(segment.id)).flatMap(e => {
        const precise = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
        const start = Math.max(e.timelineStart!, segment.timelineStart);
        const end = Math.min(e.timelineEnd!, segment.timelineStart + segment.sourceEnd - segment.sourceStart);
        if (end <= start || (query.timeline && (start >= query.timeline.end || end <= query.timeline.start))) return [];
        return [{ ...e, timelineStart: precise(start), timelineEnd: precise(end), sourceStart: precise(segment.sourceStart + start - segment.timelineStart),
          sourceEnd: precise(segment.sourceStart + end - segment.timelineStart), seconds: precise(end - start), segmentIds: [segment.id] }];
      });
      candidates.push({ clipId: segment.id, entries: selected, wordIds: [...new Set(selected.map(e => e.id))] });
    }
  }
  if (candidates.length > 100) fail("Too many matches; narrow the target", { reason: "target_query_too_broad", matches: candidates.length });
  const subtitleTimings = subtitles ? subtitleCueTimings(subtitles, words, edl) : [];
  const visualTimings = visuals ? visualLayerTimings(visuals, words, edl) : [];
  const matches = candidates.map(candidate => {
    const selected = new Set(candidate.wordIds), retained = new Set(candidate.entries.map(e => e.id));
    const related = (items: { id: string; wordIds: string[] }[], timingId: "cueId" | "layerId", timings: any[]) => items.filter(item => item.wordIds.some((w: string) => selected.has(w)))
      .map(item => ({ id: item.id, wordIds: item.wordIds, timing: timings.find(t => t[timingId] === item.id),
        selection: item.wordIds.every((w: string) => selected.has(w)) ? "full" : "partial" }));
    const { entries: resultEntries, ...identity } = candidate;
    return { ...identity, wordIds: candidate.wordIds.filter(id => retained.has(id)), removedWordIds: candidate.wordIds.filter(id => !retained.has(id)),
      clipIds: candidate.clipId ? [candidate.clipId] : [...new Set(resultEntries.flatMap(e => e.segmentIds ?? []))],
      playback: resultEntries, subtitleCues: related(subtitles?.cues ?? [], "cueId", subtitleTimings),
      visualLayers: related(visuals?.layers ?? [], "layerId", visualTimings) };
  });
  const result = { schemaVersion: 1, projectId, revision, editListSchemaVersion: edl.schemaVersion, duration: edl.duration,
    totalParagraphs: paragraphs.length, matches, requiresSelection: query.text !== undefined && matches.length > 1,
    note: "Read-only targets, not a deletion plan. Paragraph numbers follow the current canonical Studio transcript (including struck-through speech); review returned text/IDs. Text search matches whole paragraphs, not an automatic substring deletion. Timeline queries return intersecting words/clips without authorizing extra ranges. Use this revision in the subsequent transaction plan." };
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) fail("Target response exceeds bound; narrow the query", { reason: "target_query_too_broad" });
  return result;
}
