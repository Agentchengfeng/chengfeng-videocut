import { expect, test } from "bun:test";
import { planPreviewStreamSegments, type GridChunk } from "./preview-stream";

// A 2s grid, the way the segment muxer reports it: keyframe-aligned, so not exactly
// on the pitch.
const GRID: GridChunk[] = [
  { name: "00000.m4s", start: 0, end: 2.266667 },
  { name: "00001.m4s", start: 2.266667, end: 4.266667 },
  { name: "00002.m4s", start: 4.266667, end: 6.266667 },
  { name: "00003.m4s", start: 6.266667, end: 8.266667 },
];

const source = (chunk: GridChunk) => chunk.name;

test("a range inside one chunk keeps that chunk and trims it to the range", () => {
  const { segments, totalSeconds } = planPreviewStreamSegments(
    GRID, [{ start: 5, end: 6 }], source,
  );
  expect(segments).toEqual([
    // The chunk starts 0.733s before the wanted speech, so its own zero lands
    // *before* the timeline start and the window discards the difference.
    { source: "00002.m4s", offset: -0.733333, start: 0, end: 1 },
  ]);
  expect(totalSeconds).toBe(1);
});

test("a range spanning chunks keeps every one of them under a single window", () => {
  const { segments } = planPreviewStreamSegments(GRID, [{ start: 1, end: 7 }], source);
  expect(segments.map((segment) => segment.source))
    .toEqual(["00000.m4s", "00001.m4s", "00002.m4s", "00003.m4s"]);
  // One window for the whole range: what is kept is decided once, per range, and
  // each chunk only differs in where its own zero lands.
  expect(segments.every((segment) => segment.start === 0 && segment.end === 6)).toBe(true);
  expect(segments.map((segment) => segment.offset))
    .toEqual([-1, 1.266667, 3.266667, 5.266667]);
});

test("a chunk that only touches a boundary is left out", () => {
  // [2.266667, 4.266667) begins exactly where the range ends: it holds nothing of it.
  const { segments } = planPreviewStreamSegments(GRID, [{ start: 0, end: 2.266667 }], source);
  expect(segments.map((segment) => segment.source)).toEqual(["00000.m4s"]);
});

test("later ranges land right after earlier ones, with the gap between them gone", () => {
  const { segments, totalSeconds } = planPreviewStreamSegments(
    GRID, [{ start: 0, end: 2 }, { start: 6, end: 7 }], source,
  );
  const second = segments.filter((segment) => segment.start > 0);
  // The deleted 4 seconds do not exist on the assembled timeline: the second range
  // starts at 2, not at 6. This is what the player relies on to never seek.
  // Both chunks it touches carry that same window — one range, one decision.
  expect(second.map((segment) => [segment.source, segment.start, segment.end])).toEqual([
    ["00002.m4s", 2, 3],
    ["00003.m4s", 2, 3],
  ]);
  expect(second.map((segment) => segment.offset)).toEqual([
    2 + 4.266667 - 6,
    2 + 6.266667 - 6,
  ]);
  expect(totalSeconds).toBe(3);
});

test("a zero-length range contributes nothing and does not move the timeline", () => {
  const { segments, totalSeconds } = planPreviewStreamSegments(
    GRID, [{ start: 3, end: 3 }, { start: 5, end: 6 }], source,
  );
  expect(segments.map((segment) => segment.start)).toEqual([0]);
  expect(totalSeconds).toBe(1);
});
