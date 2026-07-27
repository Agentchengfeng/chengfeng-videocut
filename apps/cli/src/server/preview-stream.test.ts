import { expect, test } from "bun:test";
import { mergeContiguousRanges, quietBoundaryAfter } from "./preview-stream";

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
