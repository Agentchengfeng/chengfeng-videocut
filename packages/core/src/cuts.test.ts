import { describe, expect, it } from "bun:test";
import {
  buildCutSelectionFromProposal,
  buildCutTimeRanges,
  expandCutWordIdsAcrossEnclosedGaps,
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

  it("absorbs ASR gap fragments enclosed by deleted spoken words", () => {
    const words = parseTranscriptWords({
      cues: [
        {
          words: [
            { id: "spoken-left", start: 47.8, end: 48.8 },
            { id: "false-silence-1", start: 48.8, end: 48.92, isGap: true },
            { id: "false-silence-2", start: 48.92, end: 49.12, isGap: true },
            { id: "spoken-right", start: 49.12, end: 49.61 },
          ],
        },
      ],
    });

    const semanticCutWordIds = expandCutWordIdsAcrossEnclosedGaps(
      words,
      new Set(["spoken-left", "spoken-right"]),
    );
    const document = buildCutSelectionFromProposal(
      words,
      { cutWordIds: [...semanticCutWordIds] },
      undefined,
      "2026-07-20T00:00:00.000Z",
    );

    expect(document.cutWordIds).toEqual([
      "spoken-left",
      "false-silence-1",
      "false-silence-2",
      "spoken-right",
    ]);
    expect(document.cutRanges).toEqual([{ start: 47.8, end: 49.61 }]);
  });

  it("keeps an enclosed gap when an exact full selection restores it", () => {
    const words = parseTranscriptWords({
      cues: [
        {
          words: [
            { id: "cut-left", start: 0, end: 1 },
            { id: "restored-gap", start: 1, end: 1.12, isGap: true },
            { id: "cut-right", start: 1.12, end: 2 },
          ],
        },
      ],
    });

    const document = buildCutSelectionFromProposal(words, {
      cutWordIds: ["cut-left", "cut-right"],
    });

    expect(document.cutWordIds).toEqual(["cut-left", "cut-right"]);
    expect(document.cutRanges).toEqual([
      { start: 0, end: 1 },
      { start: 1.12, end: 2 },
    ]);
  });

  it("does not absorb a short retained spoken word between deletions", () => {
    const words = parseTranscriptWords({
      cues: [
        {
          words: [
            { id: "cut-left", start: 0, end: 1 },
            { id: "kept-spoken", start: 1, end: 1.08 },
            { id: "cut-right", start: 1.08, end: 2 },
          ],
        },
      ],
    });

    expect(buildCutTimeRanges(words, new Set(["cut-left", "cut-right"]))).toEqual([
      { start: 0, end: 1 },
      { start: 1.08, end: 2 },
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
