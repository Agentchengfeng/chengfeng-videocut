import { describe, expect, test } from "bun:test";
import { buildNaturalPausePlan } from "./naturalPause";

describe("natural-pause-v5-compress-long-gaps", () => {
  test("merges adjacent ASR gap tokens and only removes the excess of a long pause", () => {
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

    expect(plan.deleteSegments).toEqual([{ start: 0.5, end: 1.2 }]);
    expect(plan.summary).toMatchObject({ pausesDeleted: 0, pausesCompressed: 1, pausesKept: 0 });
    expect(plan.actions.find((action) => action.type === "pause-compress")).toMatchObject({
      indices: [1, 2],
      originalDuration: 1,
      deleteStart: 0.5,
      deleteEnd: 1.2,
      targetDuration: 0.3,
    });
  });

  test("keeps a short natural pause while still removing untranscribed head and tail", () => {
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
      { start: 1.4, end: 2 },
    ]);
    expect(plan.summary).toMatchObject({ pausesDeleted: 0, pausesCompressed: 0, pausesKept: 1 });
    expect(plan.summary.headTailDeleted).toBe(2);
    expect(plan.actions.map((action) => action.type)).toEqual([
      "head-tail-delete",
      "pause-keep",
      "head-tail-delete",
    ]);
    expect(plan.actions.find((action) => action.type === "pause-keep")).toMatchObject({
      start: 0.8,
      end: 1.1,
      targetDuration: 0.3,
    });
  });

  test("keeps ordinary 30fps breaths and makes long-pause cuts land on the frame grid", () => {
    const plan = buildNaturalPausePlan(
      [
        { start: 0, end: 0.3 },
        { start: 0.3, end: 0.5, isGap: true }, // six 30fps frames: retain
        { start: 0.5, end: 0.8 },
        { start: 0.8, end: 1.6, isGap: true }, // 24 frames: retain 9, cut 15
        { start: 1.6, end: 1.9 },
      ],
      [],
      { timelineEnd: 1.9 },
    );

    expect(plan.deleteSegments).toEqual([{ start: 1.1, end: 1.6 }]);
    expect(plan.deleteSegments.every((segment) =>
      Number.isInteger(segment.start * 30) && Number.isInteger(segment.end * 30),
    )).toBe(true);
    expect(plan.summary).toMatchObject({ pausesCompressed: 1, pausesKept: 1 });
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
