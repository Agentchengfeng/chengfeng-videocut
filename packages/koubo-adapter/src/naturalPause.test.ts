import { describe, expect, test } from "bun:test";
import { buildNaturalPausePlan } from "./naturalPause";

describe("natural-pause-v4-delete-all-gaps", () => {
  test("merges adjacent ASR gap tokens before deleting a long pause in full", () => {
    const plan = buildNaturalPausePlan(
      [
        { start: 0, end: 0.2 },
        { start: 0.2, end: 0.7, isGap: true },
        { start: 0.7, end: 1.2, isGap: true },
        { start: 1.2, end: 1.5 },
      ],
      [],
      { timelineEnd: 1.5 },
    );

    expect(plan.deleteSegments).toEqual([{ start: 0.2, end: 1.2 }]);
    expect(plan.summary.pausesDeleted).toBe(1);
    expect(plan.actions.find((action) => action.type === "pause-delete")).toMatchObject({
      indices: [1, 2],
      originalDuration: 1,
      deleteStart: 0.2,
      deleteEnd: 1.2,
      targetDuration: 0,
    });
  });

  test("deletes short natural pauses as well as untranscribed head and tail", () => {
    const plan = buildNaturalPausePlan(
      [
        { start: 0, end: 0.5, isGap: true },
        { start: 0.5, end: 0.8 },
        { start: 0.8, end: 1.1, isGap: true },
        { start: 1.1, end: 1.4 },
        { start: 1.4, end: 2, isGap: true },
      ],
      [],
      { timelineEnd: 2 },
    );

    expect(plan.deleteSegments).toEqual([
      { start: 0, end: 0.5 },
      { start: 0.8, end: 1.1 },
      { start: 1.4, end: 2 },
    ]);
    expect(plan.summary.pausesDeleted).toBe(1);
    expect(plan.summary.headTailDeleted).toBe(2);
    expect(plan.actions.map((action) => action.type)).toEqual([
      "head-tail-delete",
      "pause-delete",
      "head-tail-delete",
    ]);
    expect(plan.actions.find((action) => action.type === "pause-delete")).toMatchObject({
      start: 0.8,
      end: 1.1,
      targetDuration: 0,
    });
  });

  test("semantic deletion keeps a small breathing boundary", () => {
    const plan = buildNaturalPausePlan(
      [
        { start: 0, end: 0.3 },
        { start: 0.3, end: 0.7, isGap: true },
        { start: 0.7, end: 1 },
        { start: 1, end: 1.5, isGap: true },
        { start: 1.5, end: 1.8 },
      ],
      [2],
      { timelineEnd: 1.8 },
    );

    expect(plan.deleteSegments[0]).toEqual({ start: 0.38, end: 1.34 });
    expect(plan.summary.semanticGroups).toBe(1);
  });
});
