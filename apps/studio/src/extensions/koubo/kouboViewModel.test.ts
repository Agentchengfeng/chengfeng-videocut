import { describe, expect, it } from "vitest";
import type { TranscriptCue, TranscriptWord } from "../../components/kouboTranscript";
import {
  buildManagedTimelineSegments,
  indexKouboTranscript,
  isSameKouboActiveTranscriptPosition,
  resolveKouboActiveTranscriptPosition,
  resolveKouboEditingLockReason,
  updateKouboCutSelection,
} from "./kouboViewModel";

const words: TranscriptWord[] = [
  { id: "w1", text: "你", start: 0, end: 0.2, isGap: false },
  { id: "g1", text: "", start: 0.2, end: 0.8, isGap: true },
  { id: "g2", text: "", start: 0.8, end: 1.2, isGap: true },
  { id: "w2", text: "好", start: 1.2, end: 1.5, isGap: false },
];

const cues: TranscriptCue[] = [
  { id: "c1", start: 0, end: 0.8, words: words.slice(0, 2) },
  { id: "c2", start: 0.8, end: 1.5, words: words.slice(2) },
];

describe("koubo extension view model", () => {
  it("indexes merged silence without losing source word boundaries", () => {
    const indexed = indexKouboTranscript(cues, new Set());
    expect(indexed.words.map((word) => word.id)).toEqual(["w1", "g1", "g2", "w2"]);
    expect(indexed.cues[0]?.words).toEqual([
      expect.objectContaining({ startIndex: 0, endIndex: 0 }),
      expect.objectContaining({
        startIndex: 1,
        endIndex: 2,
        word: expect.objectContaining({ sourceWordIds: ["g1", "g2"] }),
      }),
    ]);
  });

  it("derives fallback source mapping only from valid EDL elements", () => {
    expect(buildManagedTimelineSegments([
      {
        start: 3,
        playbackRate: 1,
        edlSegmentId: "b",
        edlSourceStart: 8,
        edlSourceEnd: 12,
      },
      { start: 0 },
      {
        start: 0,
        edlSegmentId: "a",
        edlSourceStart: 0,
        edlSourceEnd: 3,
      },
    ])).toEqual([
      { sourceStart: 0, sourceEnd: 3, timelineStart: 0, playbackRate: 1 },
      { sourceStart: 8, sourceEnd: 12, timelineStart: 3, playbackRate: 1 },
    ]);
  });

  it("resolves active cue and word with half-open playback boundaries", () => {
    const indexed = indexKouboTranscript(cues, new Set());
    expect(resolveKouboActiveTranscriptPosition(indexed.cues, 0.1)).toEqual({
      cueId: "c1",
      wordId: "w1",
    });
    expect(resolveKouboActiveTranscriptPosition(indexed.cues, 1.2)).toEqual({
      cueId: "c2",
      wordId: "w2",
    });
    expect(resolveKouboActiveTranscriptPosition(indexed.cues, 1.5)).toEqual({
      cueId: null,
      wordId: null,
    });
  });

  it("only changes active transcript state when playback crosses a word boundary", () => {
    const indexed = indexKouboTranscript(cues, new Set());
    let current = { cueId: null as string | null, wordId: null as string | null };
    let updates = 0;
    const update = (time: number) => {
      const next = resolveKouboActiveTranscriptPosition(indexed.cues, time);
      if (isSameKouboActiveTranscriptPosition(current, next)) return;
      current = next;
      updates += 1;
    };

    for (let frame = 0; frame < 120; frame += 1) update(0.05 + frame * 0.001);
    expect(updates).toBe(1);

    update(0.21);
    expect(updates).toBe(2);
    update(0.7);
    expect(updates).toBe(2);
    update(1.21);
    expect(updates).toBe(3);
  });

  it("deletes a mixed range and restores a fully deleted range", () => {
    const deleted = updateKouboCutSelection(
      words,
      new Set(["g1"]),
      new Set(["g1"]),
      { start: 1, end: 2 },
    );
    expect([...deleted]).toEqual(["g1", "g2"]);

    const restored = updateKouboCutSelection(
      words,
      deleted,
      new Set(["g1", "g2"]),
      { start: 1, end: 2 },
    );
    expect([...restored]).toEqual([]);
  });

  it("does not lock Product EditList mutation after manual timeline editing", () => {
    expect(resolveKouboEditingLockReason({
      transcriptLoading: false,
      selectionLoading: false,
      selectionReady: true,
      editListLoading: false,
      editListReady: true,
      manualTimeline: true,
    })).toBeNull();
    expect(resolveKouboEditingLockReason({
      transcriptLoading: false,
      selectionLoading: false,
      selectionReady: true,
      editListLoading: false,
      editListReady: true,
      manualTimeline: false,
    })).toBeNull();
  });
});
