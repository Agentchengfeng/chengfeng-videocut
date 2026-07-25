import { VideocutError } from "./errors";

export interface TimedWord {
  id: string;
  start: number;
  end: number;
  isGap?: boolean;
}

export interface CutTimeRange {
  start: number;
  end: number;
}

export type JsonObject = Record<string, unknown>;

export type CutSelectionDocument = JsonObject & {
  schemaVersion: 3;
  cutWordIds: string[];
  cutRanges: CutTimeRange[];
  updatedAt: string;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireFiniteNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) {
    throw new VideocutError("invalid_transcript", `${field} must be a finite number`);
  }
  return number;
}

export function parseTranscriptWords(payload: unknown): TimedWord[] {
  if (!isObject(payload) || !Array.isArray(payload.cues)) {
    throw new VideocutError(
      "invalid_transcript",
      "transcript.json must contain a cues array",
    );
  }

  const words: TimedWord[] = [];
  const seenIds = new Set<string>();
  payload.cues.forEach((cue, cueIndex) => {
    if (!isObject(cue) || !Array.isArray(cue.words)) {
      throw new VideocutError(
        "invalid_transcript",
        `cues[${cueIndex}] must contain a words array`,
      );
    }
    cue.words.forEach((word, wordIndex) => {
      if (!isObject(word)) {
        throw new VideocutError(
          "invalid_transcript",
          `cues[${cueIndex}].words[${wordIndex}] must be an object`,
        );
      }
      const id = typeof word.id === "string" ? word.id.trim() : "";
      if (!id) {
        throw new VideocutError(
          "invalid_transcript",
          `cues[${cueIndex}].words[${wordIndex}].id is required`,
        );
      }
      if (seenIds.has(id)) {
        throw new VideocutError(
          "invalid_transcript",
          `Transcript word id is not unique: ${id}`,
          { wordId: id },
        );
      }
      const start = requireFiniteNumber(
        word.start,
        `cues[${cueIndex}].words[${wordIndex}].start`,
      );
      const end = requireFiniteNumber(
        word.end,
        `cues[${cueIndex}].words[${wordIndex}].end`,
      );
      if (start < 0 || end < start) {
        throw new VideocutError(
          "invalid_transcript",
          `Invalid word time range for ${id}: ${start} - ${end}`,
          { wordId: id, start, end },
        );
      }
      seenIds.add(id);
      words.push({ id, start, end, isGap: word.isGap === true });
    });
  });

  if (words.length === 0) {
    throw new VideocutError("invalid_transcript", "transcript.json has no words");
  }
  return words;
}

/**
 * ASR word boundaries can label the beginning of a spoken word as a tiny gap.
 * Keeping that gap as its own magnetic A-roll segment makes deleted syllables
 * flash through playback. When a contiguous gap run is enclosed by deleted
 * spoken words, the gap belongs to the same semantic deletion and must be cut.
 *
 * Deliberately key this rule off `isGap` rather than duration: a short real word
 * between two deletions still remains a separate retained segment.
 */
export function expandCutWordIdsAcrossEnclosedGaps(
  words: readonly TimedWord[],
  cutWordIds: ReadonlySet<string>,
): Set<string> {
  const expanded = new Set(cutWordIds);
  let index = 0;

  while (index < words.length) {
    if (words[index]?.isGap !== true) {
      index += 1;
      continue;
    }

    const gapStart = index;
    while (index < words.length && words[index]?.isGap === true) index += 1;
    const leftWord = words[gapStart - 1];
    const rightWord = words[index];
    if (!leftWord || !rightWord) continue;
    if (!expanded.has(leftWord.id) || !expanded.has(rightWord.id)) continue;

    for (let gapIndex = gapStart; gapIndex < index; gapIndex += 1) {
      const gapWord = words[gapIndex];
      if (gapWord) expanded.add(gapWord.id);
    }
  }

  return expanded;
}

export function buildCutTimeRanges(
  words: readonly TimedWord[],
  cutWordIds: ReadonlySet<string>,
): CutTimeRange[] {
  const ranges: CutTimeRange[] = [];
  let current: CutTimeRange | null = null;

  for (const word of words) {
    if (!cutWordIds.has(word.id)) {
      if (current) ranges.push(current);
      current = null;
      continue;
    }
    if (!current) {
      current = { start: word.start, end: word.end };
      continue;
    }
    current.end = Math.max(current.end, word.end);
  }

  if (current) ranges.push(current);
  return ranges;
}

function parseCutWordIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new VideocutError(
      "invalid_cut_selection",
      "cut-selection input must contain cutWordIds as an array",
    );
  }
  const ids = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new VideocutError(
        "invalid_cut_selection",
        `cutWordIds[${index}] must be a non-empty string`,
      );
    }
    return item.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new VideocutError(
      "invalid_cut_selection",
      "cutWordIds must not contain duplicates",
    );
  }
  return ids;
}

export interface BuildCutSelectionOptions {
  words: readonly TimedWord[];
  cutWordIds: readonly string[] | ReadonlySet<string>;
  previous?: unknown;
  overlay?: unknown;
  updatedAt?: string;
  rejectUnknownWordIds?: boolean;
}

export function buildCutSelectionDocument(
  options: BuildCutSelectionOptions,
): CutSelectionDocument {
  const previous = isObject(options.previous) ? options.previous : {};
  const overlay = isObject(options.overlay) ? options.overlay : {};
  const ids = parseCutWordIds([...options.cutWordIds]);
  const cutWordIds = new Set(ids);
  const knownIds = new Set(options.words.map((word) => word.id));
  if (knownIds.size !== options.words.length) {
    throw new VideocutError(
      "invalid_transcript",
      "Transcript word ids must be unique before building a cut selection",
    );
  }
  const unknownIds = ids.filter((id) => !knownIds.has(id));
  if (options.rejectUnknownWordIds !== false && unknownIds.length > 0) {
    throw new VideocutError(
      "invalid_cut_selection",
      `cutWordIds contains ${unknownIds.length} id(s) not present in transcript.json`,
      { unknownWordIds: unknownIds.slice(0, 20) },
    );
  }
  const orderedIds = options.words
    .filter((word) => cutWordIds.has(word.id))
    .map((word) => word.id);
  if (options.rejectUnknownWordIds === false) orderedIds.push(...unknownIds);

  return {
    ...previous,
    ...overlay,
    schemaVersion: 3,
    cutWordIds: orderedIds,
    cutRanges: buildCutTimeRanges(options.words, cutWordIds),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export function buildCutSelectionFromProposal(
  words: readonly TimedWord[],
  proposal: unknown,
  previous?: unknown,
  updatedAt?: string,
): CutSelectionDocument {
  if (!isObject(proposal)) {
    throw new VideocutError(
      "invalid_cut_selection",
      "cut-selection input must be a JSON object",
    );
  }
  return buildCutSelectionDocument({
    words,
    cutWordIds: parseCutWordIds(proposal.cutWordIds),
    previous,
    updatedAt,
  });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function semanticValue(document: unknown): unknown {
  if (!isObject(document)) return canonicalValue(document);
  const { updatedAt: _updatedAt, ...rest } = document;
  return canonicalValue(rest);
}

export function hasSameCutSelectionMeaning(left: unknown, right: unknown): boolean {
  return JSON.stringify(semanticValue(left)) === JSON.stringify(semanticValue(right));
}

export function totalCutDuration(ranges: readonly CutTimeRange[]): number {
  return ranges.reduce(
    (total, range) => total + Math.max(0, range.end - range.start),
    0,
  );
}
