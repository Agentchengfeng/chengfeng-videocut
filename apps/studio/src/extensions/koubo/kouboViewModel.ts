import {
  buildTranscriptDisplayCues,
  type TranscriptCue,
  type TranscriptDisplayWord,
  type TranscriptWord,
} from "../../components/kouboTranscript";
import type { ManagedTimelineSegment } from "../../components/editListPlayback";

export interface KouboTimelineElement {
  start: number;
  playbackRate?: number;
  edlSegmentId?: string;
  edlSourceStart?: number;
  edlSourceEnd?: number;
}

export interface IndexedKouboWord {
  word: TranscriptDisplayWord;
  startIndex: number;
  endIndex: number;
}

export interface IndexedKouboCue extends Omit<TranscriptCue, "words"> {
  words: IndexedKouboWord[];
}

export interface KouboWordRange {
  start: number;
  end: number;
}

export interface KouboLaterExactDuplicate {
  sourceStart: number;
  sourceEnd: number;
}

export interface KouboActiveTranscriptPosition {
  cueId: string | null;
  wordId: string | null;
}

export interface KouboEditingAvailability {
  transcriptLoading: boolean;
  selectionLoading: boolean;
  selectionReady: boolean;
  editListLoading: boolean;
  editListReady: boolean;
  manualTimeline: boolean;
}

function findActiveTimedItemIndex<T>(
  items: readonly T[],
  time: number,
  getRange: (item: T) => { start: number; end: number },
): number {
  if (!Number.isFinite(time) || items.length === 0) return -1;
  let low = 0;
  let high = items.length - 1;
  let candidate = -1;

  // Transcript cues and words are ordered, non-overlapping half-open ranges.
  // Find the last range whose start is at or before the playhead, then verify
  // its end instead of scanning every transcript token on every player frame.
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const item = items[middle];
    if (item && getRange(item).start <= time) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const item = candidate >= 0 ? items[candidate] : undefined;
  return item && time < getRange(item).end ? candidate : -1;
}

function indexedCueRange(cue: IndexedKouboCue): IndexedKouboCue {
  return cue;
}

function indexedWordRange(indexedWord: IndexedKouboWord): TranscriptDisplayWord {
  return indexedWord.word;
}

export function resolveKouboActiveTranscriptPosition(
  cues: readonly IndexedKouboCue[],
  sourceTime: number,
): KouboActiveTranscriptPosition {
  const cueIndex = findActiveTimedItemIndex(cues, sourceTime, indexedCueRange);
  const cue = cueIndex >= 0 ? cues[cueIndex] : undefined;
  if (!cue) return { cueId: null, wordId: null };
  const wordIndex = findActiveTimedItemIndex(
    cue.words,
    sourceTime,
    indexedWordRange,
  );
  return {
    cueId: cue.id,
    wordId: wordIndex >= 0 ? cue.words[wordIndex]?.word.id ?? null : null,
  };
}

export function isSameKouboActiveTranscriptPosition(
  left: KouboActiveTranscriptPosition,
  right: KouboActiveTranscriptPosition,
): boolean {
  return left.cueId === right.cueId && left.wordId === right.wordId;
}

export function buildManagedTimelineSegments(
  elements: readonly KouboTimelineElement[],
): ManagedTimelineSegment[] {
  return elements.flatMap((element): ManagedTimelineSegment[] => {
    if (
      !element.edlSegmentId ||
      !Number.isFinite(element.start) ||
      !Number.isFinite(element.edlSourceStart) ||
      !Number.isFinite(element.edlSourceEnd)
    ) return [];
    const sourceStart = element.edlSourceStart as number;
    const sourceEnd = element.edlSourceEnd as number;
    const playbackRate = Number.isFinite(element.playbackRate)
      ? Math.max(element.playbackRate as number, 0.000001)
      : 1;
    if (sourceEnd <= sourceStart) return [];
    return [{
      sourceStart,
      sourceEnd,
      timelineStart: element.start,
      playbackRate,
    }];
  }).sort((left, right) => left.timelineStart - right.timelineStart);
}

export function indexKouboTranscript(
  cues: readonly TranscriptCue[],
  displayedCutWordIds: ReadonlySet<string>,
): { cues: IndexedKouboCue[]; words: TranscriptWord[] } {
  const words = cues.flatMap((cue) => cue.words);
  const indexByWordId = new Map(words.map((word, index) => [word.id, index] as const));
  const indexedCues = buildTranscriptDisplayCues([...cues], displayedCutWordIds).map((cue) => ({
    ...cue,
    words: cue.words.map((word) => {
      const indexes = word.sourceWordIds
        .map((wordId) => indexByWordId.get(wordId))
        .filter((index): index is number => index !== undefined);
      const startIndex = indexes[0] ?? 0;
      return {
        word,
        startIndex,
        endIndex: indexes.at(-1) ?? startIndex,
      };
    }),
  }));
  return { cues: indexedCues, words };
}

export function isKouboWordInRange(
  start: number,
  end: number,
  range: KouboWordRange | null,
): boolean {
  if (!range) return false;
  const rangeStart = Math.min(range.start, range.end);
  const rangeEnd = Math.max(range.start, range.end);
  return start <= rangeEnd && end >= rangeStart;
}

export function updateKouboCutSelection(
  words: readonly TranscriptWord[],
  currentCutWordIds: ReadonlySet<string>,
  displayedCutWordIds: ReadonlySet<string>,
  range: KouboWordRange,
): Set<string> {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.min(words.length - 1, Math.max(range.start, range.end));
  const next = new Set(currentCutWordIds);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return next;
  const selected = words.slice(start, end + 1);
  const restore = selected.length > 0 && selected.every((word) => displayedCutWordIds.has(word.id));
  for (const word of selected) {
    if (restore) next.delete(word.id);
    else next.add(word.id);
  }
  return next;
}

const MIN_RESTORE_DEDUPLICATE_TOKENS = 8;

function spokenToken(word: TranscriptWord): string {
  if (word.isGap) return "";
  return word.text
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * Find complete, later text copies that are still physically retained in the
 * current EDL. This is deliberately exact and conservative: short phrases and
 * partly cut candidates never become an automatic deletion proposal.
 */
export function findLaterRetainedExactDuplicates(
  words: readonly TranscriptWord[],
  displayedCutWordIds: ReadonlySet<string>,
  range: KouboWordRange,
): KouboLaterExactDuplicate[] {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.min(words.length - 1, Math.max(range.start, range.end));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return [];
  const selected = words.slice(start, end + 1);
  const tokens = selected.map(spokenToken).filter(Boolean);
  if (tokens.length < MIN_RESTORE_DEDUPLICATE_TOKENS) return [];
  const restoredSourceEnd = Math.max(...selected.map((word) => word.end));
  const duplicates: KouboLaterExactDuplicate[] = [];

  for (let candidateStartIndex = end + 1; candidateStartIndex < words.length; candidateStartIndex += 1) {
    const first = words[candidateStartIndex];
    if (!first || displayedCutWordIds.has(first.id) || spokenToken(first) !== tokens[0]) continue;
    let cursor = candidateStartIndex;
    let tokenIndex = 0;
    let firstMatched: TranscriptWord | null = null;
    let lastMatched: TranscriptWord | null = null;
    let matched = true;
    while (cursor < words.length && tokenIndex < tokens.length) {
      const candidate = words[cursor];
      if (!candidate) break;
      const token = spokenToken(candidate);
      if (!token) {
        cursor += 1;
        continue;
      }
      if (displayedCutWordIds.has(candidate.id) || token !== tokens[tokenIndex]) {
        matched = false;
        break;
      }
      firstMatched ??= candidate;
      lastMatched = candidate;
      tokenIndex += 1;
      cursor += 1;
    }
    if (
      matched &&
      tokenIndex === tokens.length &&
      firstMatched &&
      lastMatched &&
      firstMatched.start >= restoredSourceEnd - 0.001
    ) {
      duplicates.push({ sourceStart: firstMatched.start, sourceEnd: lastMatched.end });
      candidateStartIndex = Math.max(candidateStartIndex, cursor - 1);
    }
  }
  return duplicates;
}

export function resolveKouboEditingLockReason(
  availability: KouboEditingAvailability,
): string | null {
  // A manual timeline still rejects Cuts' full rebase on the server, but it
  // must not lock the Product-owned EditList delete/restore commands used by
  // the transcript. Those commands preserve the current manual segment order.
  if (availability.transcriptLoading) return "正在读取逐词转录";
  if (availability.selectionLoading || !availability.selectionReady) {
    return "正在读取删词结果";
  }
  if (availability.editListLoading || !availability.editListReady) {
    return "正在同步剪辑时间线";
  }
  return null;
}

export function formatKouboTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}
