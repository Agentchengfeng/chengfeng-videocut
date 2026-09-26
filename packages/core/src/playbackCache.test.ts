import { describe, expect, spyOn, test } from "bun:test";
import { cachedPlaybackTranscript } from "./playbackCache";

const transcript = (text = "hello") => JSON.stringify({ cues: [{ id: "c", words: [{ id: "w", text, start: 0, end: 1 }] }] });
const edl = JSON.stringify({ schemaVersion: 1, projectId: "test", sourceDuration: 2,
  baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "b".repeat(64), mode: "manual", duration: 1,
  segments: [{ id: "s", source: "a.wav", sourceStart: 0, sourceEnd: 1, timelineStart: 0, playbackRate: 1, trackId: "a-roll" }] });

describe("exact-input bounded playback derivation cache", () => {
  test("hits clone results; raw content, EDL and project identity changes miss", () => {
    const raw = transcript(), key = crypto.randomUUID();
    const first = cachedPlaybackTranscript(key, "test", raw, edl);
    first.stream.length = 0;
    const parse = spyOn(JSON, "parse");
    try {
      const second = cachedPlaybackTranscript(key, "test", raw, edl);
      expect(parse).not.toHaveBeenCalled();
      expect(second.stream).toHaveLength(1);
      second.stream.length = 0;
      expect(cachedPlaybackTranscript(key, "test", raw, edl).stream).toHaveLength(1);
      for (const [directory, id, tr, edit] of [[key, "test", raw + " ", edl], [key, "test", raw, edl + " "],
        [key + "other", "test", raw, edl], [key, "other", raw, edl]] as const) {
        parse.mockClear();
        cachedPlaybackTranscript(directory, id, tr, edit);
        expect(parse).toHaveBeenCalled();
      }
      const changed = cachedPlaybackTranscript(key, "test", transcript("changed"), edl);
      expect(changed.stream[0]).toMatchObject({ text: "changed" });
      expect(() => cachedPlaybackTranscript(key, "test", "{", edl)).toThrow();
      expect(() => cachedPlaybackTranscript(key, "test", raw, "{")).toThrow();
    } finally { parse.mockRestore(); }
  });

  test("LRU evicts past sixteen entries and retains a recently read key", () => {
    const base = crypto.randomUUID(), raw = transcript();
    for (let i = 0; i < 16; i++) cachedPlaybackTranscript(`${base}/${i}`, "test", raw, edl);
    cachedPlaybackTranscript(`${base}/0`, "test", raw, edl);
    cachedPlaybackTranscript(`${base}/16`, "test", raw, edl);
    const parse = spyOn(JSON, "parse");
    try {
      cachedPlaybackTranscript(`${base}/0`, "test", raw, edl);
      expect(parse).not.toHaveBeenCalled();
      cachedPlaybackTranscript(`${base}/1`, "test", raw, edl);
      expect(parse).toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  test("16 MiB aggregate bound evicts even below entry limit; oversized values are not cached", () => {
    const base = crypto.randomUUID(), raw = transcript("x".repeat(6 * 1024 * 1024));
    for (let i = 0; i < 3; i++) cachedPlaybackTranscript(`${base}/${i}`, "test", raw, edl);
    const parse = spyOn(JSON, "parse");
    try {
      cachedPlaybackTranscript(`${base}/2`, "test", raw, edl);
      expect(parse).not.toHaveBeenCalled();
      cachedPlaybackTranscript(`${base}/0`, "test", raw, edl);
      expect(parse).toHaveBeenCalled();
      const huge = transcript("x".repeat(17 * 1024 * 1024));
      cachedPlaybackTranscript(base, "test", huge, edl);
      parse.mockClear();
      cachedPlaybackTranscript(base, "test", huge, edl);
      expect(parse).toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
});
