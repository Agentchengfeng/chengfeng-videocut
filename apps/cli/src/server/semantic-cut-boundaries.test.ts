import { describe, expect, it } from "bun:test";
import type { DeriveCutRangesInput } from "@video-workbench/core/node";
import { buildEditListFromCuts } from "@video-workbench/core";
import { deriveSemanticCutRanges } from "./semantic-cut-boundaries";

function fixture(): DeriveCutRangesInput {
  const candidate = { schemaVersion: 3 as const, cutWordIds: ["take"],
    cutRanges: [{ start: 26.04, end: 30.52 }, { start: 33.355, end: 33.385 }],
    reasons: [{ wordIds: ["take"], kind: "repeat", risk: "low" as const }], updatedAt: "fixed" };
  return { candidate, previous: structuredClone(candidate), sourceDuration: 35,
    words: [
      { id: "before", start: 25, end: 25.64 },
      { id: "gap-a", start: 25.64, end: 26.36, isGap: true },
      { id: "take", start: 26.36, end: 30.52 },
      { id: "gap-b", start: 30.52, end: 30.64, isGap: true },
      { id: "after", start: 30.64, end: 33.3 },
      { id: "short-gap", start: 33.3, end: 33.44, isGap: true },
      { id: "last", start: 33.44, end: 35 },
    ],
    previousEditList: buildEditListFromCuts({ projectId: "fixture", source: "source.wav",
      sourceDuration: 35, cutsRevision: "a".repeat(64), transcriptRevision: "b".repeat(64),
      cutRanges: candidate.cutRanges }),
  };
}

describe("semantic seam derivation", () => {
  it("repairs the full repeated take seam without changing separate pause decisions or selection", async () => {
    const input = fixture();
    const snapshot = structuredClone(input);
    const expected = [{ start: 25.72, end: 30.52 }, { start: 33.355, end: 33.385 }];
    expect(await deriveSemanticCutRanges(input)).toEqual(expected);
    expect(input).toEqual(snapshot);
    // Core reconstructs the generic candidate every time; previous repaired
    // ranges must not introduce a second source of policy on the next submit.
    input.previous!.cutRanges = [{ start: 0, end: 35 }];
    expect(await deriveSemanticCutRanges(input)).toEqual(expected);
    input.previous!.cutRanges = expected;
    input.candidate.cutRanges = expected;
    expect(await deriveSemanticCutRanges(input)).toEqual(expected);
  });

  it("does not rerun natural pause initialization for an ordinary short pause", async () => {
    const input = fixture();
    input.candidate.cutRanges = input.candidate.cutRanges.slice(0, 1);
    expect(await deriveSemanticCutRanges(input)).toEqual([{ start: 25.72, end: 30.52 }]);
    input.candidate.cutWordIds = [];
    const ranges = await deriveSemanticCutRanges(input, async () => { throw new Error("must not run"); });
    expect(ranges).toEqual(input.candidate.cutRanges);
  });

  it("applies acoustic placement only to semantic seams and caps it at selected/retained speech", async () => {
    const input = fixture();
    const result = await deriveSemanticCutRanges(input, async (kept) => {
      expect(kept).toEqual([{ start: 0, end: 25.72 }, { start: 30.52, end: 33.355 },
        { start: 33.385, end: 35 }]);
      return [{ start: 0.05, end: 27 }, { start: 31, end: 33.4 }, { start: 33.4, end: 35 }];
    });
    expect(result).toEqual([{ start: 26.36, end: 30.64 }, { start: 33.355, end: 33.385 }]);
  });

  it("rejects malformed placement and propagates probe failure", async () => {
    await expect(deriveSemanticCutRanges(fixture(), async () => [])).rejects.toThrow("invalid ranges");
    await expect(deriveSemanticCutRanges(fixture(), async (ranges) => ranges.map(() =>
      ({ start: NaN, end: 1 })))).rejects.toThrow("invalid ranges");
    await expect(deriveSemanticCutRanges(fixture(), async () => { throw new Error("probe failed"); }))
      .rejects.toThrow("probe failed");
  });

  it("does not let round3 action precision cut into adjacent retained speech", async () => {
    const input = fixture();
    input.words = [{ id: "before", start: 0, end: 1.0004 },
      { id: "take", start: 1.0004, end: 2.0006 }, { id: "after", start: 2.0006, end: 35 }];
    input.candidate.cutRanges = [{ start: 1.0004, end: 2.0006 }];
    expect(await deriveSemanticCutRanges(input)).toEqual([{ start: 1.0004, end: 2.0006 }]);
  });
});
