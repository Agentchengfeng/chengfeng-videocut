import { expect, test } from "bun:test";
import { mergeContiguousRanges, quietBoundaryAfter, soundSpillsInto } from "./preview-stream";

test("ranges still adjacent in the source become one, so the seam never exists", () => {
  // What an undone cut leaves behind: restore inserts a range instead of growing
  // its neighbour, so the edit list holds a boundary where the speaker never paused.
  expect(mergeContiguousRanges([
    { start: 1, end: 3 },
    { start: 3, end: 5 },
    { start: 9, end: 11 },
  ])).toEqual([
    { start: 1, end: 5 },
    { start: 9, end: 11 },
  ]);
});

test("a real cut is left alone", () => {
  const ranges = [{ start: 0, end: 2 }, { start: 5, end: 7 }];
  expect(mergeContiguousRanges(ranges)).toEqual(ranges);
});

test("a run of adjacent ranges collapses to one", () => {
  expect(mergeContiguousRanges([
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ])).toEqual([{ start: 0, end: 3 }]);
});

test("sub-millisecond drift still counts as adjacent", () => {
  expect(mergeContiguousRanges([
    { start: 1, end: 3 },
    { start: 3.0002, end: 5 },
  ])).toEqual([{ start: 1, end: 5 }]);
});

test("a gap wider than the slack is a real cut and stays", () => {
  const ranges = [{ start: 1, end: 3 }, { start: 3.05, end: 5 }];
  expect(mergeContiguousRanges(ranges)).toEqual(ranges);
});

test("empty ranges are dropped rather than merged into their neighbour", () => {
  expect(mergeContiguousRanges([
    { start: 1, end: 3 },
    { start: 4, end: 4 },
  ])).toEqual([{ start: 1, end: 3 }]);
});

// 10ms per sample. Loud from 0.00–0.05, then silence.
const MAP = { step: 0.01, quiet: 100, rms: [900, 900, 900, 900, 900, 50, 50, 50, 900, 900] };

test("a boundary inside a word moves past the end of the sound", () => {
  // This is the whole point: transcription writes 40ms for a syllable that takes
  // 180ms, so the written boundary lands mid-word. Cutting there takes the rest of
  // the word with it, and the listener hears nothing rather than a short word.
  expect(quietBoundaryAfter(MAP, 0.02)).toBe(0.05);
});

test("a boundary already in silence does not move", () => {
  expect(quietBoundaryAfter(MAP, 0.06)).toBe(0.06);
});

test("it only ever moves later, never earlier", () => {
  // Earlier would clip the word instead of completing it — the direction is the rule,
  // not an implementation detail.
  expect(quietBoundaryAfter(MAP, 0.04)).toBeGreaterThanOrEqual(0.04);
});

test("it gives up rather than run into whatever comes next", () => {
  // Sound with no silence after it inside the search window: the boundary stays put.
  // Extending indefinitely would swallow the next take, which is deleted speech.
  const solid = { step: 0.01, quiet: 100, rms: Array.from({ length: 100 }, () => 900) };
  expect(quietBoundaryAfter(solid, 0.2, 0.25)).toBe(0.2);
});

test("a boundary never moves into the next kept range", () => {
  // The deleted stretch here is 20ms — shorter than the search window. Moving the
  // full quarter second would replay speech that is kept later anyway, so the
  // available room, not the window, is the limit.
  const solid = { step: 0.01, quiet: 100, rms: Array.from({ length: 100 }, () => 900) };
  expect(quietBoundaryAfter(solid, 0.2, 0.02)).toBe(0.2);
});

test("a boundary never reaches into the next thing said", () => {
  // The boundary sits exactly where a deleted word starts, so it is loud — and
  // searching forward for silence would walk straight through that word. This is
  // what made 「我们」 play twice: the tail ran into a deleted 「我们」 and the next
  // kept range opened with 「我们」 as well.
  const speaking = { step: 0.01, quiet: 100, rms: Array.from({ length: 100 }, () => 900) };
  expect(quietBoundaryAfter(speaking, 0.2, 0)).toBe(0.2);
});

// Loud 0.00–0.05 (a take that was cut), quiet 0.05–0.09, loud again from 0.09.
const SPILL = { step: 0.01, quiet: 100, rms: [900, 900, 900, 900, 900, 50, 50, 50, 50, 900, 900, 900] };

test("sound left over from the previous take counts as spilling in", () => {
  expect(soundSpillsInto(SPILL, 0.03)).toBe(true);
});

test("a word starting out of silence is not spilling in", () => {
  // 0.09 is loud, but 0.07 before it was quiet: this is an onset, and moving the
  // boundary past it would cut the word off at its own beginning.
  expect(soundSpillsInto(SPILL, 0.09)).toBe(false);
});

test("silence is never spilling in", () => {
  expect(soundSpillsInto(SPILL, 0.06)).toBe(false);
});

test("a range made entirely of leftover sound is not trimmed away", () => {
  // Half its own length is the limit. A range the user restored on purpose must
  // stay audible: marked kept on screen and silent in the ears is the one mismatch
  // this product refuses.
  const spill = { step: 0.01, quiet: 100, rms: Array.from({ length: 60 }, () => 900) };
  expect(quietBoundaryAfter(spill, 0.1, 0.06)).toBe(0.1);
});
