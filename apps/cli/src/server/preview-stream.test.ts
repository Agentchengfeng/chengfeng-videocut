import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreviewStream,
  mergeContiguousRanges,
  placeCutBoundaries,
  quietBoundaryAfter,
  soundSpillsInto,
  tailReleaseLevel,
} from "./preview-stream";

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

// ── How quiet a tail must get is the word's own business ─────────────────────
//
// Two measured leaks on one recording (floor 248) killed every absolute level:
// 「站」 peaks at 2468 and its tail was still an audible 「喔」 at 567 — floor x 2.5
// (620) called that quiet. 「到」 peaks at 2112 and its tail still simmered at 339
// — floor x 1.5 (372) called that quiet. Chasing the second with an even lower
// absolute would chase room noise. The only yardstick both share is the word.

// 「站」's real levels, 173.18s → 173.37s shifted to 0.00s: peak 2468, then the
// tail 955 → 776 → 668 → 567 → 402 → 413 → 294 → 307 → room.
const ZHAN = {
  step: 0.01, quiet: 372, floor: 248,
  rms: [1938, 2069, 2344, 2468, 1803, 1404, 1438, 1415, 955, 776, 668, 567, 402, 413, 294, 307, 256, 273, 256, 257],
};

test("a loud word's tail is not closed while an absolute threshold says it is", () => {
  // The release level scales with the word: 15% of 「站」's own peak, not a
  // project-wide constant. 370.2 is what floor x 1.5 (372) happened to be tuned
  // to by hand for this word — the relative rule derives it.
  const release = tailReleaseLevel(ZHAN, [{ start: 0, end: 0.2 }], 0.11);
  expect(release).toBeCloseTo(2468 * 0.15, 6);
  // The boundary that leaked sat at 567 — 23% of the peak, audibly still the
  // word. The cut moves to 294 (12% of peak, next to the room), 30ms later:
  // exactly where the accepted hand fix landed.
  expect(quietBoundaryAfter({ ...ZHAN, quiet: release }, 0.11)).toBe(0.14);
  // And this is the bug being fixed: the absolute 620 called 567 "quiet", so the
  // cut never moved and the tail was heard as a stray vowel.
  expect(quietBoundaryAfter({ ...ZHAN, quiet: 620 }, 0.11)).toBe(0.11);
});

test("a soft word's release never demands quieter than the room itself", () => {
  // 15% of a soft word's peak sits below the floor; waiting for that would wait
  // forever and the search would give up in the loudest spot. The room, at 1.2x
  // floor, is the lowest level the release may require.
  const soft = { step: 0.01, quiet: 372, floor: 248, rms: [900, 700, 400, 300, 260, 250] };
  expect(tailReleaseLevel(soft, [{ start: 0, end: 0.05 }], 0.05)).toBeCloseTo(248 * 1.2, 6);
});

test("with no word to tie to, the absolute fallback stands", () => {
  const map = { step: 0.01, quiet: 372, floor: 248, rms: [500, 500, 500] };
  // No transcript at all, and a boundary before the first word: both fall back.
  expect(tailReleaseLevel(map, [], 0.01)).toBe(372);
  expect(tailReleaseLevel(map, [{ start: 0.02, end: 0.03 }], 0.01)).toBe(372);
});

test("a dip inside a ringing tail is not a place to cut", () => {
  // 「到」's real tail, 185.58s → 185.67s shifted to 0.00s: it dips to 278 for a
  // single sample and rings back up to 426. A cut in that dip leaks the rest of
  // the ring, so closing requires two consecutive quiet samples — the landing is
  // 0.06 (185.64s, level 297), not 0.01 (185.59s).
  const dao = { step: 0.01, quiet: 316.8, floor: 248, rms: [403, 278, 426, 410, 296, 327, 297, 260, 276, 264] };
  expect(quietBoundaryAfter(dao, 0)).toBe(0.06);
});

// ── The full placement, on the project that leaked ───────────────────────────
//
// Real numbers from 20260724grok-cloud-runtime: the kept range opened at 185.53,
// inside the pause after a deleted 「找到」, and 「到」's tail (339-426 against a
// floor of 248) leaked through the cut as an 「喔」 before 「比」.

/** The measured loudness 185.00s → 186.00s; everything else is room tone. */
const CASE2_RMS = (() => {
  const rms = new Array<number>(18700).fill(248);
  const measured = [
    1318, 1429, 1107, 989, 943, 749, 477, 365, 442, 425, 392, 1860, 2421, 2142, 2196, 2347,
    1796, 1700, 1680, 1648, 1241, 833, 642, 592, 513, 938, 1515, 1637, 1675, 1657, 1678, 2112,
    1850, 2035, 2077, 1818, 1821, 1835, 1687, 1872, 1755, 1455, 1114, 927, 944, 883, 881, 702,
    441, 339, 473, 462, 397, 339, 393, 349, 396, 391, 403, 278, 426, 410, 296, 327, 297, 260,
    276, 264, 273, 258, 248, 274, 260, 339, 864, 930, 1227, 1388, 1502, 1756, 1735, 2106, 2230,
    1804, 1863, 1737, 1919, 1968, 1672, 1720, 1728, 1569, 1226, 1308, 1377, 1495, 1285, 1161,
    880, 611, 553,
  ];
  rms.splice(18500, measured.length, ...measured);
  return rms;
})();

async function writeCase2Project(root: string): Promise<void> {
  const streamDir = join(root, ".chengfeng-videocut", "preview-stream");
  await mkdir(streamDir, { recursive: true });
  await writeFile(join(streamDir, "case2.keyframes.json"), JSON.stringify([0]), "utf8");
  await writeFile(
    join(streamDir, "case2.loudness.json"),
    JSON.stringify({ step: 0.01, rms: CASE2_RMS, floor: 248, quiet: 372 }),
    "utf8",
  );
  // The words as transcribed: 「找」「到」 deleted, then a pause, then 「比如」 kept.
  await writeFile(join(root, "transcript.json"), JSON.stringify({
    schemaVersion: 1,
    cues: [{ id: "cue-1", start: 184.97, end: 185.97, words: [
      { id: "w1", text: "能", start: 184.97, end: 185.13 },
      { id: "w2", text: "找", start: 185.13, end: 185.29 },
      { id: "w3", text: "到", start: 185.29, end: 185.45 },
      { id: "g1", text: "", start: 185.45, end: 185.69, isGap: true },
      { id: "w4", text: "比", start: 185.69, end: 185.85 },
      { id: "w5", text: "如", start: 185.85, end: 185.97 },
    ] }],
  }), "utf8");
}

test("a deleted word's simmering tail is escaped, stopping short of the next word", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-stream-case2-"));
  try {
    await writeCase2Project(root);
    const placed = await placeCutBoundaries({
      projectDir: root,
      proxySource: "input/proxy.mp4",
      proxyCacheKey: "case2",
      ranges: [{ start: 185.53, end: 187.19 }],
    });
    // 「到」 peaks at 2112, so its tail closes at 316.8 — the levels 339-426 that
    // every absolute threshold waved through are still the word. The landing is
    // 185.64 (level 297, next to the room's 248), skipping the one-sample dip to
    // 278 at 185.59 that rings back to 426.
    expect(placed).toEqual([{ start: 185.64, end: 187.19 }]);
    // And it must stop before 「比」 starts at 185.69 — moving into the next
    // spoken word is the one thing a boundary may never do.
    expect(placed[0]!.start).toBeLessThan(185.69);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a range opening on its own word's onset does not move, however loud it is", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-stream-case2-"));
  try {
    await writeCase2Project(root);
    // 185.85 is 「如」's own onset: 1863 there, 1804 twenty milliseconds earlier —
    // by level alone that is indistinguishable from a spilling tail. The
    // transcript says a word starts here, and that veto wins: moving would clip
    // the word off at its own beginning.
    const placed = await placeCutBoundaries({
      projectDir: root,
      proxySource: "input/proxy.mp4",
      proxyCacheKey: "case2",
      ranges: [{ start: 185.85, end: 187.19 }],
    });
    expect(placed[0]!.start).toBe(185.85);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore seam's start never moves — the source is continuous there", async () => {
  // Real numbers from the same project: a restored range starts at 187.19,
  // continuing the previous range without any cut — the seam is merged away
  // before cutting. 187.19 sits in 「踪」's decay (415 → 324 → 289 → 318 against a
  // floor of 248), exactly the shape the spill test looks for; moving the start
  // would tear a 40ms hole in speech the user kept. Contiguity, not the level,
  // decides: nothing was deleted here, so nothing can be spilling in.
  const root = await mkdtemp(join(tmpdir(), "preview-stream-seam-"));
  try {
    const streamDir = join(root, ".chengfeng-videocut", "preview-stream");
    await mkdir(streamDir, { recursive: true });
    const rms = new Array<number>(18760).fill(248);
    // The measured loudness 187.00s → 187.40s: 「跟踪」 ending, its tail, then Codex.
    rms.splice(18700, 41, ...[
      1801, 1746, 1713, 1401, 1293, 1222, 1208, 1268, 1281, 1175, 1178, 1175, 1145, 929, 708,
      470, 386, 415, 324, 289, 318, 375, 331, 297, 329, 1129, 1677, 1809, 2050, 1910, 1961,
      1507, 1481, 1031, 823, 575, 523, 621, 1050, 2006, 2205,
    ]);
    await writeFile(join(streamDir, "seam.keyframes.json"), JSON.stringify([0]), "utf8");
    await writeFile(
      join(streamDir, "seam.loudness.json"),
      JSON.stringify({ step: 0.01, rms, floor: 248, quiet: 372 }),
      "utf8",
    );
    await writeFile(join(root, "transcript.json"), JSON.stringify({
      schemaVersion: 1,
      cues: [{ id: "cue-1", start: 186.85, end: 187.61, words: [
        { id: "w1", text: "跟", start: 186.85, end: 187.01 },
        { id: "w2", text: "踪", start: 187.01, end: 187.09 },
        { id: "g1", text: "", start: 187.09, end: 187.25, isGap: true },
        { id: "w3", text: "Codex", start: 187.25, end: 187.61 },
      ] }],
    }), "utf8");
    const placed = await placeCutBoundaries({
      projectDir: root,
      proxySource: "input/proxy.mp4",
      proxyCacheKey: "seam",
      ranges: [{ start: 186.0, end: 187.19 }, { start: 187.19, end: 187.53 }],
    });
    expect(placed).toEqual([{ start: 186.0, end: 187.19 }, { start: 187.19, end: 187.53 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two builds racing for the same fragment do not fight over one scratch file", async () => {
  // One edit plus a poll is enough to line two builds up on the same fragment. They
  // used to write it through a scratch path named only after the process id — the
  // same path for both — so the first rename won and the second failed with ENOENT.
  // The endpoint answered 500 for work that had in fact just completed, and the
  // player, seeing a failure, stopped asking.
  const root = await mkdtemp(join(tmpdir(), "preview-stream-race-"));
  try {
    const input = {
      projectDir: root,
      proxySource: "missing.mp4",
      proxyCacheKey: "race",
      segments: [{ start: 0, end: 1 }],
    };
    // Both fail — there is no media here — but they must fail on the *media*, never
    // on each other's temporary files.
    const outcomes = await Promise.allSettled([
      buildPreviewStream(input),
      buildPreviewStream(input),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      const reason = String((outcome as PromiseRejectedResult).reason);
      expect(reason).not.toContain("ENOENT");
      expect(reason).not.toContain("rename");
    }
    // No scratch file left behind either.
    const directory = join(root, ".chengfeng-videocut", "preview-stream");
    const left = await readdir(directory).catch(() => [] as string[]);
    expect(left.filter((name) => name.includes(".tmp-"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
