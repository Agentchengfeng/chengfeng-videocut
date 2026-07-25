import { describe, expect, it } from "vitest";
import {
  formatTimelineClipRange,
  formatTimelineTickLabel,
  generateTimelineTicks,
} from "./timelineTicks";

describe("Product Timeline ruler contract", () => {
  it("keeps major labels readable and minor marks no denser than 8px", () => {
    const ticks = generateTimelineTicks(210, 7);
    expect(ticks.majorInterval * 7).toBeGreaterThanOrEqual(88);
    expect(ticks.major.slice(0, 3)).toEqual([0, 15, 30]);
    expect(ticks.minor[0]! * 7).toBeGreaterThanOrEqual(8);
  });

  it("uses exact multiples without accumulated floating-point drift", () => {
    const ticks = generateTimelineTicks(2, 1000);
    for (let index = 0; index < ticks.major.length; index += 1) {
      expect(ticks.major[index]).toBeCloseTo(index * ticks.majorInterval, 9);
    }
  });

  it("formats subsecond, clock and clip labels", () => {
    expect(formatTimelineTickLabel(1.25, 0.05)).toBe("00:01.25");
    expect(formatTimelineTickLabel(61.2, 0.5)).toBe("01:01.2");
    expect(formatTimelineTickLabel(3661, 60)).toBe("1:01:01");
    expect(formatTimelineClipRange(2, 7.8)).toBe("00:02–00:07");
  });

  it("fails closed for invalid durations", () => {
    expect(generateTimelineTicks(0, 7).major).toEqual([]);
    expect(generateTimelineTicks(Number.POSITIVE_INFINITY, 7).minor).toEqual([]);
  });
});
