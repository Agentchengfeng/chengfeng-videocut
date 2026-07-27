import { VideocutError } from "./errors";

export interface TimedWord {
  id: string;
  start: number;
  end: number;
  isGap?: boolean;
  /** Present when the transcript carried one. Timing consumers ignore it. */
  text?: string;
  /**
   * The transcript cue this word came from.
   *
   * Transcription groups words into utterances, and after the cut those groups
   * line up with sentences often enough to be worth reading — but only in
   * combination with a pause, because streaming recognition also ends a cue
   * mid-word when it revises a hypothesis. Cutting decisions ignore this.
   */
  cueId?: string;
}

export interface CutTimeRange {
  start: number;
  end: number;
}

/**
 * Why a set of words was cut.
 *
 * The reason hangs off the *decision* — the words someone chose — not off
 * `cutRanges`. Ranges are derived from the words and get merged and widened
 * across enclosed gaps, so one range can span several unrelated decisions and
 * would have nowhere honest to put a single reason.
 *
 * Only what the caller declared is recorded. Nothing here can verify it.
 */
export interface CutSelectionReason {
  wordIds: string[];
  kind: string;
  risk: "low" | "high";
}

export type JsonObject = Record<string, unknown>;

export type CutSelectionDocument = JsonObject & {
  schemaVersion: 3;
  cutWordIds: string[];
  cutRanges: CutTimeRange[];
  /**
   * Absent on documents written before reasons existed, and absent when the
   * caller declared none. An empty array and a missing field mean the same
   * thing: nobody said why.
   */
  reasons?: CutSelectionReason[];
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
      const cueId = typeof cue.id === "string" ? cue.id.trim() : "";
      words.push({
        id,
        start,
        end,
        isGap: word.isGap === true,
        ...(typeof word.text === "string" ? { text: word.text } : {}),
        ...(cueId ? { cueId } : {}),
      });
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

/**
 * How much silence a kept word may borrow back at each edge, in seconds.
 *
 * Transcription marks where it *recognised* a word, not where the sound stops. A
 * real measurement: 「叉」 is written 164.300–164.340 — forty milliseconds, which no
 * one can say — while the audio runs to 164.42 and is still loud at 164.40. Cutting
 * at the written end takes the last eighty milliseconds of the word with it, and
 * what is left sounds like nothing at all.
 */
const KEEP_MARGIN_SECONDS = 0.1;

/**
 * Turn cut words into the ranges actually removed.
 *
 * The edges are pulled inward wherever a deletion touches kept speech, so the kept
 * side keeps a little of the silence next to it — the room a word's tail needs.
 *
 * **Only ever borrowed from a pause.** A deletion that begins or ends on real speech
 * keeps its exact boundary: giving room back there would play the words the user
 * deleted, and no amount of polish is worth that.
 *
 * **A quarter of the pause per side at most**, so at least half of it is still
 * removed. A deletion that borrowed itself out of existence would leave the word
 * struck through on screen while it still played — the screen saying one thing and
 * the ears another is the failure this product refuses.
 */
export function buildCutTimeRanges(
  words: readonly TimedWord[],
  cutWordIds: ReadonlySet<string>,
): CutTimeRange[] {
  const spans: Array<{ from: number; to: number }> = [];
  let current: { from: number; to: number } | null = null;

  for (const [index, word] of words.entries()) {
    if (!cutWordIds.has(word.id)) {
      if (current) spans.push(current);
      current = null;
      continue;
    }
    if (!current) current = { from: index, to: index };
    else current.to = index;
  }
  if (current) spans.push(current);

  const ranges: CutTimeRange[] = [];
  for (const span of spans) {
    const first = words[span.from]!;
    const last = words[span.to]!;
    let start = first.start;
    let end = start;
    for (let index = span.from; index <= span.to; index += 1) {
      end = Math.max(end, words[index]!.end);
    }

    const previousKept = span.from > 0 && !cutWordIds.has(words[span.from - 1]!.id);
    const nextKept = span.to + 1 < words.length && !cutWordIds.has(words[span.to + 1]!.id);
    const borrow = (available: number) => Math.min(KEEP_MARGIN_SECONDS, Math.max(0, available) / 4);

    if (previousKept && first.isGap === true) start += borrow(first.end - first.start);
    if (nextKept && last.isGap === true) end -= borrow(last.end - last.start);

    // Rounded because these are written to disk and compared for equality; the
    // arithmetic above leaves the usual binary tails behind.
    const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    if (end > start) ranges.push({ start: round(start), end: round(end) });
  }
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
  /** As supplied by the caller; validated and narrowed to words actually cut. */
  reasons?: unknown;
}

/**
 * Narrow declared reasons to the ones still true of this document.
 *
 * A reason must never outlive the deletion it explains. `buildCutSelectionDocument`
 * spreads `previous`, so without this a reason would survive the word being
 * restored and the ledger would claim a cut that no longer exists. Every write
 * recomputes the list from scratch against the words actually cut.
 */
function buildCutSelectionReasons(
  declared: unknown,
  cutWordIds: ReadonlySet<string>,
): CutSelectionReason[] {
  if (declared === undefined || declared === null) return [];
  if (!Array.isArray(declared)) {
    throw new VideocutError("invalid_cut_selection", "reasons must be an array when present");
  }
  const reasons: CutSelectionReason[] = [];
  declared.forEach((entry, index) => {
    if (!isObject(entry)) {
      throw new VideocutError("invalid_cut_selection", `reasons[${index}] must be an object`);
    }
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    if (!kind) {
      throw new VideocutError("invalid_cut_selection", `reasons[${index}].kind must be a non-empty string`);
    }
    if (entry.risk !== "low" && entry.risk !== "high") {
      throw new VideocutError("invalid_cut_selection", `reasons[${index}].risk must be "low" or "high"`);
    }
    if (!Array.isArray(entry.wordIds)) {
      throw new VideocutError("invalid_cut_selection", `reasons[${index}].wordIds must be an array`);
    }
    const ids = parseCutWordIds(entry.wordIds);
    // Keep only the ids this document actually cuts. A reason naming words that
    // are not deleted would be a claim about something that did not happen.
    const kept = ids.filter((id) => cutWordIds.has(id));
    if (kept.length === 0) return;
    reasons.push({ wordIds: kept, kind, risk: entry.risk });
  });
  return reasons;
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

  const reasons = buildCutSelectionReasons(options.reasons, new Set(orderedIds));
  const { reasons: _staleReasons, ...carried } = previous;
  return {
    ...carried,
    ...overlay,
    schemaVersion: 3,
    cutWordIds: orderedIds,
    cutRanges: buildCutTimeRanges(options.words, cutWordIds),
    // Omit the key entirely when nobody said why, so a document with no reasons
    // reads the same as one written before reasons existed.
    ...(reasons.length > 0 ? { reasons } : {}),
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
    reasons: proposal.reasons,
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
