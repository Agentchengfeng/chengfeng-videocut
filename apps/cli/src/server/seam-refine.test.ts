import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditListDocument } from "@video-workbench/contracts";
import { audibleSeams, refineSeams } from "./seam-refine";

let dir = "";
// 0–1.0 kept word A · 1.0–1.3 deleted retake tail (loud) · 1.3–1.5 silence · 1.5–2.5 kept word C · then quiet
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seam-refine-"));
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=4:sample_rate=16000",
    "-af", "volume=enable='between(t,1.3,1.5)+gte(t,2.5)':volume=0,volume=0.3", "-ar", "16000", join(dir, "voice.wav")]);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const words = [
  { id: "a", start: 0, end: 1.0, text: "A" }, { id: "b", start: 1.0, end: 1.2, text: "B" },
  { id: "c", start: 1.5, end: 2.5, text: "C" },
];
const doc = (segments: Array<[string, number, number]>): EditListDocument => {
  let t = 0;
  return { schemaVersion: 1, projectId: "p", sourceDuration: 4, baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "a".repeat(64),
    mode: "manual", duration: 0, segments: segments.map(([id, s, e]) => { const seg = { id, source: "voice.wav", sourceStart: s, sourceEnd: e,
      timelineStart: t, trackId: "a-roll", playbackRate: 1 }; t += e - s; return seg; }) } as EditListDocument;
};

test("a new seam carrying a deleted retake's tail moves inward to the silence", async () => {
  const before = doc([["x", 0, 4]]);
  const after = doc([["x", 0, 0.95], ["y", 1.25, 2.6]]);
  const out = await refineSeams({ projectDir: dir, before, after, words });
  const y = out.segments.find((s) => s.id === "y")!;
  expect(y.sourceStart).toBeGreaterThanOrEqual(1.3);
  expect(y.sourceStart).toBeLessThanOrEqual(1.5);
  expect(out.segments[1]!.timelineStart).toBeCloseTo(0.95, 6);
});

test("a seam the edit did not create is left exactly as it was", async () => {
  const same = doc([["x", 0, 0.95], ["y", 1.25, 2.6]]);
  const out = await refineSeams({ projectDir: dir, before: same, after: same, words });
  expect(out.segments.map((s) => s.sourceStart)).toEqual([0, 1.25]);
});

test("never re-admits audible removed audio to reach a quiet point", async () => {
  // The start sits in the kept word's run-up with loud removed audio before it: moving earlier would re-admit it.
  const before = doc([["x", 0, 4]]);
  const after = doc([["y", 1.1, 2.6]]);
  const out = await refineSeams({ projectDir: dir, before, after, words: [...words, { id: "d", start: 1.1, end: 1.25, text: "D" }] });
  expect(out.segments[0]!.sourceStart).toBeGreaterThanOrEqual(1.1);
});

test("audible seams are reported for listening", async () => {
  const seams = await audibleSeams(dir, doc([["x", 0, 0.95], ["y", 1.25, 2.6]]));
  expect(seams.some((s) => s.segmentId === "y" && s.edge === "start")).toBe(true);
});
