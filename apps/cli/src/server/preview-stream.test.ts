import { expect, test } from "bun:test";
import { mergeContiguousRanges } from "./preview-stream";

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
    { start: 3, end: 4 },
  ])).toEqual([{ start: 0, end: 4 }]);
});

test("sub-millisecond drift still counts as adjacent", () => {
  // These boundaries come from word timestamps that have been through several
  // conversions. A frame is 33ms; a millisecond of slack cannot swallow speech.
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
    { start: 6, end: 8 },
  ])).toEqual([
    { start: 1, end: 3 },
    { start: 6, end: 8 },
  ]);
});
