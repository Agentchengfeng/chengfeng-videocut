import type { TimelineElement } from "../player";
import {
  buildCutTimeRanges,
  sourceTimeToEditedTime,
  type TranscriptCue,
  type TranscriptTimeRange,
  type TranscriptWord,
} from "./kouboTranscript";

export interface VisualPlanSegment {
  id: string;
  cueId: string | null;
  start: number;
  end: number;
  editedStart: number;
  editedEnd: number;
  transcript: string;
  editedTranscript: string;
  title: string;
  description: string;
  kind: string;
  clipIds: string[];
  wordIds: string[];
  syncState: "linked" | "fallback" | "unlinked";
  seekStart: number;
  fullyCut: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wordsText(words: TranscriptWord[]): string {
  return words
    .map((word) =>
      word.isGap
        ? `（停顿 ${(word.end - word.start).toFixed(1)}s）`
        : word.text,
    )
    .join("");
}

function cueText(cue: TranscriptCue | undefined): string {
  return cue ? wordsText(cue.words) : "";
}

function elementKey(element: TimelineElement): string {
  return element.key ?? element.id;
}

function elementLabel(element: TimelineElement | undefined): string {
  if (!element) return "";
  const explicit = element.label?.trim();
  if (explicit && explicit !== element.id) return explicit;
  return element.id
    .replace(/^clip-\d+-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function overlaps(element: TimelineElement, start: number, end: number): boolean {
  return element.start < end && element.start + element.duration > start;
}

function matchesClipId(element: TimelineElement, clipId: string): boolean {
  return (
    element.id === clipId ||
    elementKey(element) === clipId ||
    element.domId === clipId ||
    element.hfId === clipId
  );
}

function relatedElements(
  elements: TimelineElement[],
  clipIds: string[],
  start: number,
  end: number,
): TimelineElement[] {
  if (clipIds.length > 0) {
    return elements.filter((element) =>
      clipIds.some((clipId) => matchesClipId(element, clipId)),
    );
  }
  return elements.filter((element) => overlaps(element, start, end));
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

function anchoredWords(cues: TranscriptCue[], wordIds: string[]): TranscriptWord[] {
  if (wordIds.length === 0) return [];
  const anchorIds = new Set(wordIds);
  return cues.flatMap((cue) => cue.words.filter((word) => anchorIds.has(word.id)));
}

function cueForAnchors(
  cues: TranscriptCue[],
  cueId: string | null,
  wordIds: string[],
  index: number,
): TranscriptCue | undefined {
  const direct = cues.find((cue) => cue.id === cueId);
  if (direct) return direct;
  if (wordIds.length > 0) {
    const anchorIds = new Set(wordIds);
    const ranked = cues
      .map((cue) => ({
        cue,
        matches: cue.words.filter((word) => anchorIds.has(word.id)).length,
      }))
      .sort((left, right) => right.matches - left.matches);
    if ((ranked[0]?.matches ?? 0) > 0) return ranked[0]?.cue;
  }
  return cues[index];
}

function cutAwareFields(
  start: number,
  end: number,
  transcript: string,
  anchorWords: TranscriptWord[],
  cutWordIds: ReadonlySet<string>,
  cutRanges: TranscriptTimeRange[],
): Pick<
  VisualPlanSegment,
  "editedStart" | "editedEnd" | "editedTranscript" | "seekStart" | "fullyCut"
> {
  const survivingWords = anchorWords.filter((word) => !cutWordIds.has(word.id));
  const spokenWords = anchorWords.filter((word) => !word.isGap);
  const survivingSpokenWords = survivingWords.filter((word) => !word.isGap);
  return {
    editedStart: sourceTimeToEditedTime(start, cutRanges),
    editedEnd: sourceTimeToEditedTime(end, cutRanges),
    editedTranscript: anchorWords.length > 0 ? wordsText(survivingWords) : transcript,
    seekStart: survivingWords[0]?.start ?? start,
    fullyCut: spokenWords.length > 0 && survivingSpokenWords.length === 0,
  };
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].map(String).sort();
}

export function visualPlanMatchesCutSelection(
  payload: unknown,
  cutWordIds: ReadonlySet<string>,
): boolean {
  const current = sortedIds(cutWordIds);
  if (!isRecord(payload) || !isRecord(payload.cutSync)) return current.length === 0;
  const synced = normalizeIds(payload.cutSync.cutWordIds).sort();
  return synced.length === current.length && synced.every((id, index) => id === current[index]);
}

export function withVisualPlanCutSync(
  payload: unknown,
  cutWordIds: ReadonlySet<string>,
  appliedAt: string,
): UnknownRecord {
  const base = isRecord(payload)
    ? payload
    : { schemaVersion: 2, segments: [] };
  return {
    ...base,
    cutSync: {
      schemaVersion: 1,
      cutWordIds: sortedIds(cutWordIds),
      appliedAt,
    },
  };
}

export function isVisualTimelineElement(element: TimelineElement): boolean {
  const role = element.timelineRole?.toLowerCase();
  return !(
    role === "a-roll" ||
    role === "captions" ||
    role === "caption" ||
    role === "audio"
  );
}

export function resolveSegmentElement(
  segment: VisualPlanSegment,
  elements: TimelineElement[],
): TimelineElement | null {
  return (
    relatedElements(elements, segment.clipIds, segment.start, segment.end)
      .sort((left, right) => left.start - right.start || left.track - right.track)[0] ?? null
  );
}

export function buildVisualPlanSegments(
  payload: unknown,
  cues: TranscriptCue[],
  visualElements: TimelineElement[],
  cutWordIds: ReadonlySet<string> = new Set(),
): VisualPlanSegment[] {
  const rawSegments = isRecord(payload) && Array.isArray(payload.segments)
    ? payload.segments
    : [];
  const allWords = cues.flatMap((cue) => cue.words);
  const cutRanges = buildCutTimeRanges(allWords, cutWordIds);

  if (rawSegments.length === 0) {
    return cues.map((cue, index) => {
      const related = relatedElements(visualElements, [], cue.start, cue.end);
      const primary = related[0];
      const title = elementLabel(primary) || `画面 ${index + 1}`;
      const transcript = cueText(cue);
      return {
        id: `visual-${cue.id}`,
        cueId: cue.id,
        start: cue.start,
        end: cue.end,
        transcript,
        title,
        description: related.length > 0
          ? `展示 ${related.map(elementLabel).filter(Boolean).join("、")}`
          : "暂未安排对应画面",
        kind: primary?.timelineRole?.toUpperCase() || "B-ROLL",
        clipIds: related.map(elementKey),
        wordIds: cue.words.map((word) => word.id),
        syncState: "linked",
        ...cutAwareFields(
          cue.start,
          cue.end,
          transcript,
          cue.words,
          cutWordIds,
          cutRanges,
        ),
      };
    });
  }

  return rawSegments
    .map((value, index): VisualPlanSegment | null => {
      if (!isRecord(value)) return null;
      const cueId = value.cueId == null ? null : String(value.cueId);
      const wordIds = normalizeIds(value.wordIds);
      const directCue = cues.find((candidate) => candidate.id === cueId);
      const cue = cueForAnchors(cues, cueId, wordIds, index);
      const anchorWords = anchoredWords(cues, wordIds);
      const syncState = directCue || anchorWords.length > 0
        ? "linked"
        : cue
          ? "fallback"
          : "unlinked";
      const liveStart = anchorWords.length > 0
        ? Math.min(...anchorWords.map((word) => word.start))
        : cue?.start;
      const liveEnd = anchorWords.length > 0
        ? Math.max(...anchorWords.map((word) => word.end))
        : cue?.end;
      const fixedTiming = value.timing === "fixed";
      const authoredStart = Math.max(0, finiteNumber(value.start, liveStart ?? 0));
      const start = fixedTiming ? authoredStart : Math.max(0, liveStart ?? authoredStart);
      const authoredEnd = Math.max(start, finiteNumber(value.end, liveEnd ?? start));
      const end = fixedTiming ? authoredEnd : Math.max(start, liveEnd ?? authoredEnd);
      const clipIds = normalizeIds(value.clipIds);
      const related = relatedElements(visualElements, clipIds, start, end);
      const primary = related[0];
      const authoredTitle = String(value.title ?? "").trim();
      const authoredDescription = String(value.description ?? "").trim();
      const authoredKind = String(value.kind ?? "").trim();
      const transcript = String(
        value.transcript ??
          (anchorWords.length > 0 ? wordsText(anchorWords) : cueText(cue)),
      );
      const visualWords = anchorWords.length > 0 ? anchorWords : (cue?.words ?? []);
      return {
        id: String(value.id ?? `visual-${index + 1}`),
        cueId: cueId ?? cue?.id ?? null,
        start,
        end,
        transcript,
        title: authoredTitle || elementLabel(primary) || `画面 ${index + 1}`,
        description:
          authoredDescription ||
          (related.length > 0
            ? `展示 ${related.map(elementLabel).filter(Boolean).join("、")}`
            : "暂未安排对应画面"),
        kind: authoredKind || primary?.timelineRole?.toUpperCase() || "B-ROLL",
        clipIds,
        wordIds: wordIds.length > 0
          ? wordIds
          : (cue?.words.map((word) => word.id) ?? []),
        syncState,
        ...cutAwareFields(
          start,
          end,
          transcript,
          visualWords,
          cutWordIds,
          cutRanges,
        ),
      };
    })
    .filter((segment): segment is VisualPlanSegment => Boolean(segment))
    .sort((left, right) => left.start - right.start);
}
