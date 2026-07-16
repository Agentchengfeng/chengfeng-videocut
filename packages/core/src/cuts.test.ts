import { describe, expect, it } from "bun:test";
import {
  buildCutSelectionFromProposal,
  buildCutTimeRanges,
  parseTranscriptWords,
} from "./cuts";

const transcript = {
  schemaVersion: 1,
  cues: [
    {
      id: "cue-1",
      words: [
        { id: "w-1", start: 0, end: 1 },
        { id: "w-2", start: 1, end: 2 },
        { id: "w-3", start: 2, end: 3 },
      ],
    },
  ],
};

describe("cut selection contract", () => {
  it("derives ranges from word ids and preserves existing metadata", () => {
    const words = parseTranscriptWords(transcript);
    const document = buildCutSelectionFromProposal(
      words,
      {
        cutWordIds: ["w-2", "w-1"],
        cutRanges: [{ start: 99, end: 100 }],
        schemaVersion: 999,
        updatedAt: "attacker-controlled",
        initialization: { mode: "replace-the-real-initialization" },
        productMetadata: { owner: "attacker" },
        injectedMetadata: { shouldNotSurvive: true },
      },
      {
        schemaVersion: 3,
        initialization: { mode: "delete-or-keep-v1" },
        productMetadata: { owner: "studio" },
        preservedMetadata: { source: "previous-document" },
      },
      "2026-07-16T00:00:00.000Z",
    );

    expect(document.schemaVersion).toBe(3);
    expect(document.cutRanges).toEqual([{ start: 0, end: 2 }]);
    expect(document.cutWordIds).toEqual(["w-1", "w-2"]);
    expect(document.updatedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(document.initialization).toEqual({ mode: "delete-or-keep-v1" });
    expect(document.productMetadata).toEqual({ owner: "studio" });
    expect(document.preservedMetadata).toEqual({ source: "previous-document" });
    expect(document).not.toHaveProperty("injectedMetadata");
  });

  it("keeps separated selections as separate time ranges", () => {
    const words = parseTranscriptWords(transcript);
    expect(buildCutTimeRanges(words, new Set(["w-1", "w-3"]))).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });

  it("rejects cut ids that are absent from the transcript", () => {
    const words = parseTranscriptWords(transcript);
    expect(() =>
      buildCutSelectionFromProposal(words, { cutWordIds: ["missing"] }),
    ).toThrow("not present in transcript.json");
  });

  it("rejects duplicate transcript word ids", () => {
    expect(() =>
      parseTranscriptWords({
        cues: [
          { words: [{ id: "same", start: 0, end: 1 }] },
          { words: [{ id: "same", start: 1, end: 2 }] },
        ],
      }),
    ).toThrow("not unique");
  });
});
