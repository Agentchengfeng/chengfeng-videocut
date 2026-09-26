import { buildNaturalPausePlan } from "@video-workbench/koubo-adapter";
import type { DeriveCutRangesInput } from "@video-workbench/core/node";

type Range = { start: number; end: number };
type PlaceBoundaries = (ranges: readonly Range[]) => Promise<Range[]>;

function merge(ranges: readonly Range[]): Range[] {
  const result: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/** Recompute only seams created by semantic deletions. Existing gap decisions
 * remain authoritative: don't rerun initialization or borrow generic gap margins
 * after the natural-pause policy has already placed the new seam. */
export async function deriveSemanticCutRanges(
  input: DeriveCutRangesInput,
  placeBoundaries?: PlaceBoundaries,
): Promise<Range[]> {
  const selected = new Set(input.candidate.cutWordIds);
  const indices = input.words.flatMap((word, index) =>
    !word.isGap && selected.has(word.id) ? [index] : []);
  if (!indices.length) return input.candidate.cutRanges.map((range) => ({ ...range }));
  const plan = buildNaturalPausePlan(input.words, indices, { timelineEnd: input.sourceDuration });
  const semantic = plan.actions.filter((action) => action.type === "semantic-delete").map((action) => {
    // actions are a millisecond-rounded report, not an exact ledger boundary.
    // Reconstruct the policy with source precision so touching words stay intact.
    const first = Number(action.firstIndex);
    const last = Number(action.lastIndex);
    const previous = input.words.slice(0, first).reverse().find((word) => !word.isGap);
    const next = input.words.slice(last + 1).find((word) => !word.isGap);
    return {
      start: previous ? previous.end + Math.min(plan.policy.keepAfterPreviousWord,
        Math.max(0, input.words[first]!.start - previous.end)) : 0,
      end: next ? next.start - Math.min(plan.policy.keepBeforeNextWord,
        Math.max(0, next.start - input.words[last]!.end)) : input.sourceDuration,
    };
  });
  const ranges = merge([
    ...input.candidate.cutRanges,
    ...semantic.map((action) => ({ start: action.start, end: action.end })),
  ]);
  if (!placeBoundaries) return ranges;

  const kept: Range[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) kept.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  if (cursor < input.sourceDuration) kept.push({ start: cursor, end: input.sourceDuration });
  const placed = await placeBoundaries(kept);
  if (placed.length !== kept.length || placed.some((range) =>
    !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start)) {
    throw new Error("Acoustic boundary placement returned invalid ranges");
  }
  return ranges.map((range) => {
    // Only semantic seams get acoustic refinement. Gap-only decisions elsewhere
    // must not change when the Agent resubmits the same speech selection.
    if (!semantic.some((action) => action.start < range.end && action.end > range.start)) return range;
    const deleted = input.words.filter((word) => !word.isGap && selected.has(word.id)
      && word.start < range.end && word.end > range.start);
    const left = kept.findIndex((keep) => keep.end === range.start);
    const right = kept.findIndex((keep) => keep.start === range.end);
    const nextKeptStart = Math.min(input.sourceDuration, ...input.words.filter((word) =>
      !word.isGap && !selected.has(word.id) && word.start >= range.end).map((word) => word.start));
    // Waveform adjustment can release a kept tail or remove deleted spill, but
    // never restore selected speech or enter the next retained word.
    const start = left < 0 ? range.start : Math.min(
      Math.max(range.start, placed[left]!.end), ...deleted.map((word) => word.start));
    const end = right < 0 ? range.end : Math.min(nextKeptStart,
      Math.max(range.end, placed[right]!.start));
    return { start, end };
  });
}
