import type { CaptionModel } from "../captions/types";
import {
  buildCutTimeRanges as buildCoreCutTimeRanges,
  type CutTimeRange,
} from "@video-workbench/core";

export const KOU_BO_TRANSCRIPT_COPY = {
  sectionLabel: "口播转录",
  loading: "正在载入转录文字",
  empty: "暂无转录文字",
  selectionActionsLabel: "转录文字选中操作",
} as const;

export type TranscriptSuggestion =
  | "silence"
  | "filler"
  | "repeat"
  | "stutter"
  | "incomplete";

export interface TranscriptWord {
  id: string;
  text: string;
  start: number;
  end: number;
  isGap: boolean;
  suggestion?: TranscriptSuggestion;
}

export interface TranscriptCue {
  id: string;
  start: number;
  end: number;
  words: TranscriptWord[];
}

export type TranscriptTimeRange = CutTimeRange;

export interface TranscriptDisplayWord extends TranscriptWord {
  sourceWordIds: string[];
}

export interface TranscriptDisplayCue {
  id: string;
  start: number;
  end: number;
  words: TranscriptDisplayWord[];
}

const ADJACENT_GAP_EPSILON = 0.001;

export function buildTranscriptDisplayCues(
  cues: TranscriptCue[],
  cutWordIds: ReadonlySet<string> = new Set(),
): TranscriptDisplayCue[] {
  const displayWords: Array<TranscriptDisplayWord & { sourceCueIndex: number }> = [];

  cues.forEach((cue, sourceCueIndex) => {
    cue.words.forEach((word) => {
      const previous = displayWords.at(-1);
      const joinsPreviousGap =
        word.isGap &&
        previous?.isGap === true &&
        word.start <= previous.end + ADJACENT_GAP_EPSILON &&
        cutWordIds.has(word.id) === cutWordIds.has(previous.sourceWordIds[0] ?? previous.id);

      if (joinsPreviousGap && previous) {
        previous.end = Math.max(previous.end, word.end);
        previous.sourceWordIds.push(word.id);
        if (!previous.suggestion && (word.suggestion || previous.end - previous.start >= 0.5)) {
          previous.suggestion = word.suggestion ?? "silence";
        }
        return;
      }

      displayWords.push({
        ...word,
        sourceWordIds: [word.id],
        sourceCueIndex,
      });
    });
  });

  const wordsByCue = new Map<number, TranscriptDisplayWord[]>();
  for (const displayWord of displayWords) {
    const { sourceCueIndex, ...word } = displayWord;
    const cueWords = wordsByCue.get(sourceCueIndex) ?? [];
    cueWords.push(word);
    wordsByCue.set(sourceCueIndex, cueWords);
  }

  return cues.flatMap((cue, cueIndex) => {
    const words = wordsByCue.get(cueIndex) ?? [];
    if (words.length === 0) return [];
    return [{
      id: cue.id,
      start: words[0]?.start ?? cue.start,
      end: words.at(-1)?.end ?? cue.end,
      words,
    }];
  });
}

export function captionModelToCues(model: CaptionModel | null): TranscriptCue[] {
  if (!model) return [];
  return model.groupOrder.flatMap((groupId, groupIndex) => {
    const group = model.groups.get(groupId);
    if (!group) return [];
    const words = group.segmentIds.flatMap((segmentId, wordIndex) => {
      const segment = model.segments.get(segmentId);
      if (!segment) return [];
      return [
        {
          id: segment.wordId ?? segment.id ?? `${groupId}-word-${wordIndex + 1}`,
          text: segment.text,
          start: segment.start,
          end: segment.end,
          isGap: false,
        } satisfies TranscriptWord,
      ];
    });
    if (words.length === 0) return [];
    return [
      {
        id: groupId || `caption-cue-${groupIndex + 1}`,
        start: words[0].start,
        end: words.at(-1)?.end ?? words[0].end,
        words,
      } satisfies TranscriptCue,
    ];
  });
}

export function mergeCaptionModelIntoCues(
  sourceCues: TranscriptCue[],
  model: CaptionModel | null,
): TranscriptCue[] {
  if (!model) return sourceCues;
  if (sourceCues.length === 0) return captionModelToCues(model);

  const segmentByWordId = new Map(
    [...model.segments.values()]
      .filter((segment) => Boolean(segment.wordId))
      .map((segment) => [segment.wordId as string, segment] as const),
  );

  return sourceCues.map((cue) => {
    const words = cue.words.map((word) => {
      const segment = segmentByWordId.get(word.id);
      if (!segment) return word;
      return {
        ...word,
        text: segment.text,
        start: segment.start,
        end: segment.end,
      };
    });
    return {
      ...cue,
      start: Math.min(...words.map((word) => word.start)),
      end: Math.max(...words.map((word) => word.end)),
      words,
    };
  });
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSuggestion(
  value: unknown,
  isGap: boolean,
  duration: number,
): TranscriptSuggestion | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized === "silence" ||
    normalized === "filler" ||
    normalized === "repeat" ||
    normalized === "stutter" ||
    normalized === "incomplete"
  ) {
    return normalized;
  }
  if (/静音|停顿/.test(normalized) || (isGap && duration >= 0.5)) {
    return "silence";
  }
  if (/口头禅|语气词|filler/.test(normalized)) return "filler";
  if (/重说|重复|repeat/.test(normalized)) return "repeat";
  if (/卡顿|结巴|stutter/.test(normalized)) return "stutter";
  if (/残句|incomplete/.test(normalized)) return "incomplete";
  return undefined;
}

function normalizeWord(
  value: unknown,
  fallbackId: string,
  fallbackStart: number,
  fallbackEnd: number,
): TranscriptWord | null {
  if (!isRecord(value)) return null;
  const text = String(value.text ?? "");
  const start = Math.max(0, finiteNumber(value.start, fallbackStart));
  const end = Math.max(start, finiteNumber(value.end, fallbackEnd));
  const isGap = Boolean(value.isGap) || (!text.trim() && end > start);
  if (!isGap && !text.trim()) return null;
  return {
    id: String(value.id ?? value.wordId ?? fallbackId),
    text,
    start,
    end,
    isGap,
    suggestion: normalizeSuggestion(
      value.suggestion ?? value.reason ?? value.kind,
      isGap,
      end - start,
    ),
  };
}

function tokenizeCueText(text: string): string[] {
  return (
    text.match(/[A-Za-z0-9][A-Za-z0-9+.#_-]*|[\u3400-\u9fff]|[^\s]/gu) ?? []
  );
}

function wordsFromText(
  cueId: string,
  text: string,
  start: number,
  end: number,
): TranscriptWord[] {
  const tokens = tokenizeCueText(text);
  const step = tokens.length > 0 ? Math.max(0, end - start) / tokens.length : 0;
  return tokens.map((token, index) => ({
    id: `${cueId}-word-${index + 1}`,
    text: token,
    start: start + step * index,
    end: index === tokens.length - 1 ? end : start + step * (index + 1),
    isGap: false,
  }));
}

function normalizeCue(value: unknown, index: number): TranscriptCue | null {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? `cue-${index + 1}`);
  const start = Math.max(0, finiteNumber(value.start, 0));
  const end = Math.max(start, finiteNumber(value.end, start));
  const rawWords = Array.isArray(value.words) ? value.words : null;
  const words = rawWords
    ? rawWords
        .map((word, wordIndex) =>
          normalizeWord(
            word,
            `${id}-word-${wordIndex + 1}`,
            start,
            end,
          ),
        )
        .filter((word): word is TranscriptWord => Boolean(word))
    : wordsFromText(id, String(value.text ?? ""), start, end);
  if (words.length === 0) return null;
  return {
    id,
    start: words[0]?.start ?? start,
    end: words.at(-1)?.end ?? end,
    words,
  };
}

function cuesFromWordArray(values: unknown[]): TranscriptCue[] {
  const words = values
    .map((word, index) => normalizeWord(word, `word-${index + 1}`, 0, 0))
    .filter((word): word is TranscriptWord => Boolean(word));
  const cues: TranscriptCue[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      id: `cue-${cues.length + 1}`,
      start: current[0].start,
      end: current.at(-1)?.end ?? current[0].end,
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    current.push(word);
    const longGap = word.isGap && word.end - word.start >= 0.5;
    const sentenceEnd = !word.isGap && /[。！？!?]$/.test(word.text);
    if (longGap || sentenceEnd || current.length >= 24) flush();
  }
  flush();
  return cues;
}

export function parseTranscriptPayload(payload: unknown): TranscriptCue[] {
  if (Array.isArray(payload)) return cuesFromWordArray(payload);
  if (!isRecord(payload)) return [];
  const rawCues = Array.isArray(payload.cues) ? payload.cues : [];
  return rawCues
    .map(normalizeCue)
    .filter((cue): cue is TranscriptCue => Boolean(cue))
    .sort((left, right) => left.start - right.start);
}

export function buildCutTimeRanges(
  words: TranscriptWord[],
  cutWordIds: ReadonlySet<string>,
): TranscriptTimeRange[] {
  return buildCoreCutTimeRanges(words, cutWordIds);
}

export function sourceTimeToEditedTime(
  sourceTime: number,
  cutRanges: TranscriptTimeRange[],
): number {
  const safeSourceTime = Math.max(0, sourceTime);
  const removedBefore = cutRanges.reduce((total, range) => {
    if (safeSourceTime <= range.start) return total;
    return total + Math.max(0, Math.min(safeSourceTime, range.end) - range.start);
  }, 0);
  return Math.max(0, safeSourceTime - removedBefore);
}

export function totalTimeRangeDuration(ranges: TranscriptTimeRange[]): number {
  return ranges.reduce(
    (total, range) => total + Math.max(0, range.end - range.start),
    0,
  );
}
