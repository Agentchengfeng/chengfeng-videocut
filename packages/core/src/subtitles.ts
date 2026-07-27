/**
 * The subtitle document: what appears on screen, and when.
 *
 * Two documents already decide things about the same words, so this one is
 * defined by what it is *not* allowed to decide:
 *
 * ```text
 * 剪口播 (edit-list)  which words play, and at what time   <- the only truth about time
 * 字幕   (this file)  what is written on screen            <- the only truth about display
 * ```
 *
 * A cue therefore stores **word ids, never seconds**. Timing is derived from
 * the transcript through the edit list every time it is needed. That is the one
 * rule that keeps the two documents from disagreeing: there is no second copy
 * of the timing to drift.
 *
 * It does store its own *text*, deliberately. An early sketch had subtitles
 * read straight from the transcript so there could not be two copies of the
 * words — but the transcript answers "what was said" and a subtitle answers
 * "what should a person read". Those differ on purpose: punctuation, dropped
 * fillers, a proper noun spelled the way its owner spells it. Forcing one
 * string to do both jobs means the subtitle can never carry a comma.
 *
 * Anchoring on word ids also makes going stale *specific*. When words are cut
 * away in 剪口播, we can say "screens 7 and 12 lost their words" instead of
 * "subtitles may be out of date" — a notice nobody can act on.
 */

import { VideocutError } from "./errors";
import type { EditListDocument, EditListSegment } from "./editList";
import type { TimedWord } from "./cuts";

export const SUBTITLE_SCHEMA_VERSION = 1 as const;

/**
 * Where a subtitle sits and what it looks like.
 *
 * Sizes are percentages of the video frame rather than pixels, so a document
 * survives being rendered at a different resolution than it was designed at.
 */
export interface SubtitleStyle {
  fontFamily: string;
  /** Cap height as a percentage of frame height. */
  fontSize: number;
  fontWeight: number;
  color: string;
  /** Outline drawn behind the glyphs. Width is a percentage of font size. */
  strokeColor: string;
  strokeWidth: number;
  /** CSS colour, or "" for no plate behind the text. */
  backgroundColor: string;
  anchor: "bottom" | "middle" | "top";
  /** Distance from the anchored edge, as a percentage of frame height. */
  offsetY: number;
  /** Multiple of font size between wrapped lines. */
  lineHeight: number;
  /** Widest a line may run, as a percentage of frame width. */
  maxLineWidth: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "PingFang SC, Noto Sans CJK SC, sans-serif",
  fontSize: 5.4,
  fontWeight: 500,
  color: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 6,
  backgroundColor: "",
  anchor: "bottom",
  offsetY: 8,
  lineHeight: 1.3,
  maxLineWidth: 86,
};

/**
 * The styles anyone actually picks.
 *
 * The individual fields above are what a renderer needs; they are not what a
 * person wants to decide. Choosing a font, a size, a weight, two colours, a
 * stroke width and an offset is eight decisions to get one look, and seven of
 * them only ever move together. So the surface offers whole looks, and the
 * fields stay as the thing a look is made of.
 *
 * Adding one here is how a new look ships. Nothing computes these.
 */
export interface SubtitleStylePreset {
  id: string;
  label: string;
  style: SubtitleStyle;
}

export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: "standard",
    label: "标准",
    style: DEFAULT_SUBTITLE_STYLE,
  },
  {
    id: "large",
    label: "大字",
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontSize: 7.2,
      fontWeight: 600,
      strokeWidth: 8,
      offsetY: 9,
    },
  },
  {
    id: "highlight",
    label: "重点",
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontSize: 6.2,
      fontWeight: 600,
      color: "#ffd60a",
      strokeWidth: 8,
    },
  },
  {
    id: "clean",
    label: "干净",
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontSize: 4.6,
      fontWeight: 400,
      strokeColor: "#000000",
      strokeWidth: 0,
      backgroundColor: "rgba(0, 0, 0, 0.55)",
      offsetY: 6,
    },
  },
];

/**
 * Which preset a style is, or null when it is none of them.
 *
 * Nothing records the choice: a style *is* its fields, and storing "this is the
 * large one" alongside them creates a second copy that can disagree with the
 * first. Reading the answer back costs a comparison of eleven values.
 */
export function matchSubtitleStylePreset(style: SubtitleStyle): SubtitleStylePreset | null {
  return SUBTITLE_STYLE_PRESETS.find((preset) => (
    Object.keys(preset.style) as Array<keyof SubtitleStyle>
  ).every((key) => preset.style[key] === style[key])) ?? null;
}

/**
 * One screenful of subtitle.
 *
 * There is deliberately no per-screen style. One document, one look: a second
 * place to set the same thing is a second place for it to be wrong, and the
 * thing it bought — an emphasised line here and there — was not worth the
 * column of controls, the override markers, and the way back that all had to
 * exist for it.
 */
export interface SubtitleCue {
  id: string;
  /**
   * The transcript words this screen covers, in spoken order. These are what
   * give the cue its timing; the cue itself holds no seconds.
   */
  wordIds: string[];
  /** What is displayed. Starts as the words joined up, then is edited freely. */
  text: string;
}

export interface SubtitleDocument {
  schemaVersion: typeof SUBTITLE_SCHEMA_VERSION;
  projectId: string;
  /**
   * The transcript these cues were built against. Not a gate — the document
   * stays usable when it moves on. It is here so a mismatch can be *explained*
   * rather than guessed at.
   */
  baseTranscriptRevision: string;
  style: SubtitleStyle;
  cues: SubtitleCue[];
}

/* ------------------------------------------------------------------ timing */

const EPSILON = 0.0005;

function orderedSegments(editList: EditListDocument | null): EditListSegment[] {
  return [...(editList?.segments ?? [])].sort(
    (left, right) => left.timelineStart - right.timelineStart,
  );
}

/**
 * Where a moment of the source lands on the edited timeline, or null if it was
 * cut away. A source time is only meaningful inside a retained segment.
 */
export function timelineTimeForSourceTime(
  segments: readonly EditListSegment[],
  sourceTime: number,
): number | null {
  for (const segment of segments) {
    if (sourceTime >= segment.sourceStart - EPSILON && sourceTime <= segment.sourceEnd + EPSILON) {
      const clamped = Math.min(Math.max(sourceTime, segment.sourceStart), segment.sourceEnd);
      return segment.timelineStart + (clamped - segment.sourceStart) / segment.playbackRate;
    }
  }
  return null;
}

/** True when any part of the word survives into the edit. */
export function wordPlays(
  segments: readonly EditListSegment[],
  word: { start: number; end: number },
): boolean {
  return segments.some(
    (segment) => segment.sourceStart < word.end - EPSILON
      && segment.sourceEnd > word.start + EPSILON,
  );
}

/**
 * How fast a person can comfortably read, in display columns per second.
 *
 * A Han character is one column, a Latin character half of one — the same
 * convention terminals use, and close enough to how much room the glyphs take.
 * Broadcast subtitle guidelines land around 9 Han characters a second; above
 * that a screen is gone before it is finished.
 */
export const COMFORTABLE_COLUMNS_PER_SECOND = 9;

/** A screen shorter than this reads as a flash even when it has few words. */
export const MINIMUM_SCREEN_SECONDS = 0.7;

/**
 * How wide a character is, as a fraction of a Han character.
 *
 * Measured in the browser at subtitle size in PingFang SC, not assumed: a flat
 * one-half for everything Latin under-counted a real line by 17%, and the line
 * that was supposed to fit wrapped.
 */
const COLUMN_WIDTHS = { han: 1, upper: 0.7, lower: 0.55 } as const;

export function displayColumns(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    if (/[\u{2E80}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FF60}]/u.test(character)) {
      columns += COLUMN_WIDTHS.han;
    } else if (/[A-Z]/u.test(character)) {
      columns += COLUMN_WIDTHS.upper;
    } else {
      columns += COLUMN_WIDTHS.lower;
    }
  }
  return columns;
}

export interface SubtitleCueTiming {
  cueId: string;
  /** Position on the edited timeline, in seconds. */
  start: number;
  end: number;
  duration: number;
  columns: number;
  columnsPerSecond: number;
  /** More text than the duration allows a person to read. */
  tooFast: boolean;
  /** On screen so briefly it registers as a flicker. */
  tooShort: boolean;
  /** Every word of this cue is gone from the edit; it cannot be placed at all. */
  orphaned: boolean;
}

/**
 * When each screen shows and for how long, computed fresh from the edit list.
 *
 * Words the edit removed are skipped rather than failing the cue: a screen that
 * lost its middle word still shows, just shorter. A screen that lost *every*
 * word is reported as orphaned — that is a thing a person has to decide about,
 * not something to silently drop.
 */
export function subtitleCueTimings(
  document: SubtitleDocument,
  words: readonly TimedWord[],
  editList: EditListDocument | null,
): SubtitleCueTiming[] {
  const segments = orderedSegments(editList);
  const byId = new Map(words.map((word) => [word.id, word]));
  return document.cues.map((cue) => {
    const times: number[] = [];
    for (const wordId of cue.wordIds) {
      const word = byId.get(wordId);
      if (!word || !wordPlays(segments, word)) continue;
      const start = timelineTimeForSourceTime(segments, word.start);
      const end = timelineTimeForSourceTime(segments, word.end);
      if (start !== null) times.push(start);
      if (end !== null) times.push(end);
    }
    const columns = displayColumns(cue.text);
    if (times.length === 0) {
      return {
        cueId: cue.id,
        start: 0,
        end: 0,
        duration: 0,
        columns,
        columnsPerSecond: Number.POSITIVE_INFINITY,
        tooFast: true,
        tooShort: true,
        orphaned: true,
      };
    }
    const start = Math.min(...times);
    const end = Math.max(...times);
    const duration = Math.max(0, end - start);
    const columnsPerSecond = duration > 0 ? columns / duration : Number.POSITIVE_INFINITY;
    return {
      cueId: cue.id,
      start,
      end,
      duration,
      columns,
      columnsPerSecond,
      tooFast: columnsPerSecond > COMFORTABLE_COLUMNS_PER_SECOND,
      tooShort: duration < MINIMUM_SCREEN_SECONDS,
      orphaned: false,
    };
  });
}

/* --------------------------------------------------------------- staleness */

export interface SubtitleCueStaleness {
  cueId: string;
  /** Position in the document, so the interface can jump straight to it. */
  index: number;
  /** Words the transcript no longer has at all. */
  missingWordIds: string[];
  /** Words still in the transcript but cut out of the edit. */
  cutWordIds: string[];
  /** The text of those cut words, so the notice can say what was lost. */
  cutText: string;
  /** Nothing of this screen survives. */
  orphaned: boolean;
}

/**
 * Which screens the edit broke, and how.
 *
 * The product is forbidden from saying "subtitles may be out of date" — a
 * notice with nothing behind it, which was removed once already on 2026-07-26.
 * Anchoring cues on word ids is what makes the honest version possible: the
 * answer is always a list of specific screens, and it is empty when nothing
 * broke.
 */
export function subtitleStaleness(
  document: SubtitleDocument,
  words: readonly TimedWord[],
  editList: EditListDocument | null,
): SubtitleCueStaleness[] {
  const segments = orderedSegments(editList);
  const byId = new Map(words.map((word) => [word.id, word]));
  const stale: SubtitleCueStaleness[] = [];
  document.cues.forEach((cue, index) => {
    const missingWordIds: string[] = [];
    const cutWordIds: string[] = [];
    const cutWords: TimedWord[] = [];
    let surviving = 0;
    for (const wordId of cue.wordIds) {
      const word = byId.get(wordId);
      if (!word) {
        missingWordIds.push(wordId);
        continue;
      }
      if (!wordPlays(segments, word)) {
        cutWordIds.push(wordId);
        cutWords.push(word);
        continue;
      }
      surviving += 1;
    }
    if (missingWordIds.length === 0 && cutWordIds.length === 0) return;
    stale.push({
      cueId: cue.id,
      index,
      missingWordIds,
      cutWordIds,
      cutText: joinWordText(cutWords),
      orphaned: surviving === 0,
    });
  });
  return stale;
}

/* ---------------------------------------------------------------- building */

/**
 * Join transcript words into readable text.
 *
 * The transcript is per-character for Chinese and per-word for Latin, so the
 * rule is: a space only where two Latin runs meet. Anywhere else a space is an
 * artefact of how the transcriber tokenised, not something anyone said.
 */
export function joinWordText(words: readonly TimedWord[]): string {
  let out = "";
  for (const word of words) {
    const text = (word.text ?? "").trim();
    if (!text) continue;
    if (out && /[A-Za-z0-9]$/u.test(out) && /^[A-Za-z0-9]/u.test(text)) out += " ";
    out += text;
  }
  return out;
}

export interface BuildSubtitleCuesOptions {
  /** Widest a screen may get, in display columns. One screen is one line. */
  maxColumns?: number;
  /**
   * A heard pause at least this long ends the screen. Anything shorter is a
   * breath inside a sentence, and breaking there splits phrases in half.
   */
  breakPauseSeconds?: number;
  /** Prefix for generated cue ids; index is appended. */
  idPrefix?: string;
  /** See `TIGHT_BREAK_COST`. Exposed so the trade-off can be measured, not tuned by feel. */
  tightBreakCost?: number;
}

/**
 * How wide one screen gets, in display columns.
 *
 * One screen is one line, so this is what a line can hold. At the standard look
 * — 5.4% of frame height, 86% of frame width — a 4:3 frame fits 21 Han
 * characters across. Eighteen leaves room for the wider looks without
 * re-splitting, and reads as one glance.
 */
const DEFAULT_MAX_COLUMNS = 17;
const DEFAULT_BREAK_PAUSE_SECONDS = 0.32;

/**
 * What it costs to break at a tight junction, in units of squared columns.
 *
 * Nine is three columns of imbalance: the splitter will accept a screen three
 * columns off-balance in exchange for landing the break on a real pause, and
 * will not accept four. That trade is the whole point — the pause is where a
 * person would have put the break themselves.
 */
const TIGHT_BREAK_COST = 9;

/** One stretch of speech that has to be split into screens by itself. */
interface SpeechRun {
  words: TimedWord[];
  /** Timeline seconds of silence before words[k]; index 0 is the run's start. */
  gapBefore: number[];
  /** Speech was cut out between the previous run and this one. */
  afterDeletion: boolean;
}

/**
 * Narrower than this and a screen is a stub, not a screen.
 *
 * Four columns is two Han characters plus a little. Below it the eye registers
 * a flicker rather than a line, whatever the timing says.
 */
const MINIMUM_SCREEN_COLUMNS = 4;

/**
 * The shortest silence that makes a transcript cue boundary a sentence end.
 *
 * Transcription groups words into utterances, and after the cut those groups
 * mostly are sentences — but not reliably, because streaming recognition also
 * closes a cue when it revises its hypothesis, and that happens mid-word with
 * no silence at all. Measured on a real recording:
 *
 * ```text
 * 每天早上Codex都会调用Grok │ 查询最新信息再筛选…   0.88s   a sentence
 * 我看一眼就能看到他和我现在正 │ 在做的事情有什么关系  0.00s   a revision, splitting 正/在
 * ```
 *
 * So neither signal is enough alone: the pause says "something ended", the cue
 * boundary says "the recogniser thought so too". Requiring both is what tells a
 * sentence from an artefact, and it is why this threshold can be far below the
 * one a pause needs to break a sentence open from the inside.
 */
const SENTENCE_PAUSE_SECONDS = 0.1;

/**
 * Split one run into screens, balancing their lengths and preferring pauses.
 *
 * The obvious approach — fill a screen up to the limit, start a new one — was
 * what this did first, and on a real recording it produced:
 *
 * ```text
 * 叉是很多国内外AI团队发布最新进展
 * 的第一站                          0.36s on screen
 * ```
 *
 * The tail is short because greedy filling puts *all* the slack in the last
 * screen. Splitting the same words evenly gives two readable halves. So this
 * costs a screen by how far it is from full, squared, which spreads the slack
 * across every screen instead of dumping it on one — and adds a penalty for
 * breaking where no pause exists, so a break slides onto a real one when that
 * is nearly as balanced. Every arrangement is considered; the runs are short
 * enough that this is instant.
 */
function splitRun(
  run: SpeechRun,
  maxColumns: number,
  breakPause: number,
  tightBreakCost: number,
): TimedWord[][] {
  const { words, gapBefore } = run;
  const count = words.length;
  if (count === 0) return [];

  const columns: number[] = words.map((word) => displayColumns(word.text ?? ""));
  // best[i] = cheapest way to cover words[i..], with the break taken at from[i].
  const best = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Array<number>(count + 1).fill(count);
  best[count] = 0;
  for (let start = count - 1; start >= 0; start -= 1) {
    let width = 0;
    for (let end = start + 1; end <= count; end += 1) {
      width += columns[end - 1] ?? 0;
      // One word can be wider than the limit on its own; a screen must still
      // exist for it, so only reject an overrun that has an alternative.
      if (width > maxColumns && end > start + 1) break;
      const slack = maxColumns - width;
      const tail = best[end];
      if (tail === undefined || !Number.isFinite(tail)) continue;
      // Breaking at the run's own end is free — that boundary is already a pause.
      const gap = end < count ? (gapBefore[end] ?? 0) : breakPause;
      const tightness = breakPause > 0 ? Math.min(gap, breakPause) / breakPause : 1;
      const cost = slack * slack + (1 - tightness) * tightBreakCost + tail;
      if (cost < (best[start] ?? Number.POSITIVE_INFINITY)) {
        best[start] = cost;
        from[start] = end;
      }
    }
  }

  const screens: TimedWord[][] = [];
  let cursor = 0;
  while (cursor < count) {
    const end = from[cursor] ?? count;
    screens.push(words.slice(cursor, end));
    cursor = end <= cursor ? cursor + 1 : end;
  }
  return screens;
}

/**
 * Cut the retained speech into screens.
 *
 * Three things end a run of speech outright, before any balancing:
 *
 * 1. **Speech was deleted here.** Two words either side of a removed sentence
 *    are neighbours on the timeline but have nothing to do with each other.
 *    A deleted *silence* is not a break — trimming a pause out of the middle of
 *    a sentence must not split the sentence.
 * 2. **A sentence ended.** The transcript's own cue boundary, but only where
 *    the audience also hears a pause — see `SENTENCE_PAUSE_SECONDS` for why one
 *    without the other is not evidence.
 * 3. **The audience hears a long pause**, anywhere. A break inside what
 *    transcription called one utterance needs more silence to justify itself.
 *
 * Whatever is left over is longer than one screen, and `splitRun` divides it.
 *
 * The result is a starting point, not an answer. Splitting is the part a person
 * will always want to adjust, so this aims to be predictable rather than clever.
 */
export function buildSubtitleCues(
  words: readonly TimedWord[],
  editList: EditListDocument | null,
  options: BuildSubtitleCuesOptions = {},
): SubtitleCue[] {
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const breakPause = options.breakPauseSeconds ?? DEFAULT_BREAK_PAUSE_SECONDS;
  const prefix = options.idPrefix ?? "sub";
  const tightBreakCost = options.tightBreakCost ?? TIGHT_BREAK_COST;
  const segments = orderedSegments(editList);
  const ordered = [...words].sort((left, right) => left.start - right.start);

  const runs: SpeechRun[] = [];
  let run: SpeechRun = { words: [], gapBefore: [], afterDeletion: false };
  let previousEndTimeline: number | null = null;
  let previousCueId: string | null = null;
  let speechDeletedSinceLastKept = false;

  const endRun = (afterDeletion = false) => {
    if (run.words.length > 0) runs.push(run);
    run = { words: [], gapBefore: [], afterDeletion };
  };

  for (const word of ordered) {
    if (!wordPlays(segments, word)) {
      if (word.isGap !== true && (word.text ?? "").trim()) speechDeletedSinceLastKept = true;
      continue;
    }
    const startOnTimeline = timelineTimeForSourceTime(segments, word.start);
    const endOnTimeline = timelineTimeForSourceTime(segments, word.end);

    if (word.isGap === true || !(word.text ?? "").trim()) {
      // A retained gap is silence the audience sits through. Long enough and it
      // is a sentence boundary; it never becomes part of a screen either way.
      const heard = startOnTimeline !== null && endOnTimeline !== null
        ? endOnTimeline - startOnTimeline
        : 0;
      if (heard >= breakPause) endRun();
      // Deliberately not advancing `previousEndTimeline`: a short retained gap
      // is silence the next word is preceded by, and moving the mark past it
      // would report that word as following immediately on the last one.
      continue;
    }

    if (speechDeletedSinceLastKept) endRun(true);
    speechDeletedSinceLastKept = false;

    const gap = previousEndTimeline !== null && startOnTimeline !== null
      ? Math.max(0, startOnTimeline - previousEndTimeline)
      : 0;
    const sentenceEnded = previousCueId !== null
      && word.cueId !== undefined
      && word.cueId !== previousCueId
      && gap >= SENTENCE_PAUSE_SECONDS;
    if (run.words.length > 0 && (sentenceEnded || gap >= breakPause)) endRun();
    previousCueId = word.cueId ?? previousCueId;

    run.gapBefore.push(run.words.length === 0 ? breakPause : gap);
    run.words.push(word);
    if (endOnTimeline !== null) previousEndTimeline = endOnTimeline;
  }
  endRun();

  // Screens, each carrying whether anything was cut away just before it.
  const screens: Array<{ words: TimedWord[]; afterDeletion: boolean }> = [];
  for (const item of runs) {
    for (const [index, words] of splitRun(item, maxColumns, breakPause, tightBreakCost).entries()) {
      if (!joinWordText(words)) continue;
      screens.push({ words, afterDeletion: item.afterDeletion && index === 0 });
    }
  }

  return mergeStubScreens(screens, maxColumns).map((words, index) => ({
    id: `${prefix}-${String(index + 1).padStart(4, "0")}`,
    wordIds: words.map((word) => word.id),
    text: joinWordText(words),
  }));
}

/**
 * Absorb one- and two-character screens into the line they came off.
 *
 * A sentence break is worth taking when it produces two screens; when it
 * produces a screen and a stub it was not a sentence break at all. On a real
 * recording this is what streaming recognition looks like from the outside:
 *
 * ```text
 * 已经被我外包给了Codex和 │ Grok      the recogniser revised, 0.12s apart
 * 布任务让它继续去给我深   │ 挖
 * ```
 *
 * The alternative was to keep raising the pause threshold until those stopped
 * appearing — but the threshold that removes them is the one that also removes
 * the real sentence breaks, because the two are only 0.12s and 0.88s apart in
 * *one* recording and nothing says the next one is spaced the same. Judging the
 * result instead of the signal does not have that problem.
 *
 * Always backwards: a stub is the tail of the phrase before it. Never across a
 * deletion — the screens either side of removed speech have nothing to do with
 * each other, which is the whole reason they were separated.
 */
function mergeStubScreens(
  screens: ReadonlyArray<{ words: TimedWord[]; afterDeletion: boolean }>,
  maxColumns: number,
): TimedWord[][] {
  const out: Array<{ words: TimedWord[]; afterDeletion: boolean }> = [];
  for (const screen of screens) {
    const previous = out.at(-1);
    const columns = displayColumns(joinWordText(screen.words));
    const merged = previous
      ? displayColumns(joinWordText([...previous.words, ...screen.words]))
      : 0;
    if (
      previous
      && !screen.afterDeletion
      && columns < MINIMUM_SCREEN_COLUMNS
      && merged <= maxColumns
    ) {
      previous.words = [...previous.words, ...screen.words];
      continue;
    }
    out.push({ words: [...screen.words], afterDeletion: screen.afterDeletion });
  }
  return out.map((screen) => screen.words);
}

export function createSubtitleDocument(
  projectId: string,
  baseTranscriptRevision: string,
  words: readonly TimedWord[],
  editList: EditListDocument | null,
  options: BuildSubtitleCuesOptions & { style?: Partial<SubtitleStyle> } = {},
): SubtitleDocument {
  return {
    schemaVersion: SUBTITLE_SCHEMA_VERSION,
    projectId,
    baseTranscriptRevision,
    style: { ...DEFAULT_SUBTITLE_STYLE, ...(options.style ?? {}) },
    cues: buildSubtitleCues(words, editList, options),
  };
}

/* ---------------------------------------------------------------- validation */

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new VideocutError("invalid_subtitles", message, details);
}

/**
 * Reject a subtitle document that would misbehave rather than fail.
 *
 * The one invariant worth enforcing is that cues own disjoint words. Two
 * screens claiming the same word means two things on screen at once, and it is
 * the kind of fault that shows up as a rendering glitch three steps later.
 *
 * This raises `VideocutError`, not `TypeError`, because the callers that matter
 * are an HTTP handler and a CLI: a malformed document supplied by a client is
 * that client's fault and must come back as 400. Thrown as a plain TypeError it
 * arrived as a 500, which reads as "the product broke".
 */
export function assertSubtitleDocument(value: unknown): asserts value is SubtitleDocument {
  if (!isObject(value)) invalid("Subtitle document must be an object");
  if (value.schemaVersion !== SUBTITLE_SCHEMA_VERSION) {
    invalid(`Unsupported subtitle schema: ${String(value.schemaVersion)}`);
  }
  if (typeof value.projectId !== "string" || !value.projectId.trim()) {
    invalid("Subtitle document requires projectId");
  }
  if (!isObject(value.style)) invalid("Subtitle document requires a style object");
  if (!Array.isArray(value.cues)) invalid("Subtitle document requires a cues array");
  const seenCueIds = new Set<string>();
  const claimedWords = new Map<string, string>();
  value.cues.forEach((cue, index) => {
    if (!isObject(cue)) invalid(`cues[${index}] must be an object`);
    const id = typeof cue.id === "string" ? cue.id.trim() : "";
    if (!id) invalid(`cues[${index}].id is required`);
    if (seenCueIds.has(id)) invalid(`Subtitle cue id is not unique: ${id}`);
    seenCueIds.add(id);
    if (typeof cue.text !== "string") invalid(`cues[${index}].text must be a string`);
    if (!Array.isArray(cue.wordIds)) {
      invalid(`cues[${index}].wordIds must be an array`);
    }
    for (const wordId of cue.wordIds) {
      if (typeof wordId !== "string" || !wordId.trim()) {
        invalid(`cues[${index}].wordIds must contain word ids`);
      }
      const owner = claimedWords.get(wordId);
      if (owner) {
        invalid(
          `Word ${wordId} is claimed by two subtitle cues: ${owner} and ${id}`,
      );
      }
      claimedWords.set(wordId, id);
    }
  });
}
