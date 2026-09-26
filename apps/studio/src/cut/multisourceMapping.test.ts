import { describe, expect, it } from "vitest";
import { applyEditListOperation, type EditListDocument } from "@video-workbench/core";
import { deriveActualCutWordIds, resolveTranscriptSeekTime, resolveEditListPlaybackTransition } from "../components/editListPlayback";
import { parseTranscriptPayload, buildTranscriptDisplayCues } from "../components/kouboTranscript";
import { indexKouboTranscript, resolveKouboActiveTranscriptPosition } from "../extensions/koubo/kouboViewModel";
import { resolveEdlTimelinePosition, resolveEdlRevisionTransition } from "./player/edlTransport";

const revision = "a".repeat(64);
const sources = ["input/a.wav", "input/b.wav"];
const document: EditListDocument = {
  schemaVersion: 2, projectId: "multi", sourceDuration: 4,
  baseCutsRevision: revision, baseTranscriptRevision: revision, mode: "manual", duration: 6,
  sources: sources.map(path => ({ path, duration: 4, sha256: revision, mediaKind: "audio" })),
  segments: [0, 1, 0].map((sourceIndex, index) => ({
    id: `s${index}`, source: sources[sourceIndex], instanceId: `i${index}`,
    sourceStart: 0, sourceEnd: 2, timelineStart: index * 2, trackId: "a-roll", playbackRate: 1,
  })),
};
const words = document.segments.map((segment, index) => ({
  id: `import${index}:w1`, sourceWordId: "w1", source: segment.source, instanceId: segment.instanceId,
  text: `词${index}`, start: 0, end: 1, isGap: false,
}));

describe("Studio multisource source-local clocks", () => {
  it("seeks each source and repeated use independently and fails closed without identity", () => {
    expect(words.map(word => resolveTranscriptSeekTime(document, 0.5, [], word))).toEqual([0.5, 2.5, 4.5]);
    expect(resolveTranscriptSeekTime(document, 0.5)).toBeNaN();
    expect(resolveTranscriptSeekTime(document, 0.5, [], { source: sources[0], instanceId: "missing" })).toBeNaN();
    expect(resolveEdlTimelinePosition(document, 4.5)).toMatchObject({ source: sources[0], instanceId: "i2", sourceTime: 0.5 });
  });

  it("marks only the matching use, not another source at the same seconds", () => {
    const cues = parseTranscriptPayload(words);
    expect(cues).toHaveLength(3);
    expect(cues[2].words[0]).toMatchObject(words[2]);
    const indexed = indexKouboTranscript(cues, new Set());
    expect(resolveKouboActiveTranscriptPosition(indexed.cues, 0.5, words[2])).toEqual({ cueId: cues[2].id, wordId: words[2].id });
    expect(resolveKouboActiveTranscriptPosition(indexed.cues, 0.5, {})).toEqual({ cueId: null, wordId: null });
  });

  it("retains source identity across manual reorder and never reanchors to a different use", () => {
    const moved = applyEditListOperation(document, { type: "move", clipId: "s2", start: 0 });
    expect(resolveEdlRevisionTransition({ oldDocument: document, newDocument: moved,
      oldRevision: revision, newRevision: "b".repeat(64), currentTimelineTime: 4.5, wasPlaying: true,
    })).toMatchObject({ timelineTime: 0.5, targetSegmentId: "s2", disposition: "retained" });
    expect(resolveEditListPlaybackTransition({ oldEditList: document, newEditList: moved,
      currentTimelineTime: 4.5, wasPlaying: true,
    })).toEqual({ timelineTime: 0.5, keepPlaying: true });
    const deleted = applyEditListOperation(document, { type: "delete", clipId: "s2" });
    expect(deriveActualCutWordIds(words, new Set(), deleted)).toEqual(new Set([words[2].id]));
    expect(resolveEdlRevisionTransition({ oldDocument: document, newDocument: deleted,
      oldRevision: revision, newRevision: "b".repeat(64), currentTimelineTime: 4.5, wasPlaying: true,
    })).toMatchObject({ disposition: "deleted-tail", keepPlaying: false, timelineTime: 4 });
  });

  it("does not globally sort identified cues or merge gaps across sources", () => {
    const cues = parseTranscriptPayload({ cues: [
      { id: "first", words: [{ ...words[0], start: 1, end: 2, text: "", isGap: true }] },
      { id: "second", words: [{ ...words[1], start: 0, end: 1, text: "", isGap: true }] },
    ] });
    expect(cues.map(cue => cue.id)).toEqual(["first", "second"]);
    expect(buildTranscriptDisplayCues(cues)).toHaveLength(2);
  });
});
