/** Product-owned pure fork of HyperFrames Studio 0.7.60 timelineSnapping.ts. */

export type TimelineSnapType = "playhead" | "clip-edge";

export interface TimelineSnapTarget {
  time: number;
  type: TimelineSnapType;
}

export const TIMELINE_SNAP_PX = 8;

const TYPE_PRIORITY: Record<TimelineSnapType, number> = {
  playhead: 0,
  "clip-edge": 1,
};

export function collectTimelineSnapTargets(input: {
  elements: ReadonlyArray<{
    id: string;
    start: number;
    duration: number;
  }>;
  playheadTime: number | null;
  excludeElementId?: string | null;
}): TimelineSnapTarget[] {
  const byTime = new Map<number, TimelineSnapTarget>();
  const add = (time: number, type: TimelineSnapType) => {
    if (!Number.isFinite(time) || time < 0) return;
    const rounded = Math.round(time * 1000) / 1000;
    const existing = byTime.get(rounded);
    if (!existing || TYPE_PRIORITY[type] < TYPE_PRIORITY[existing.type]) {
      byTime.set(rounded, { time: rounded, type });
    }
  };

  for (const element of input.elements) {
    if (input.excludeElementId === element.id) continue;
    add(element.start, "clip-edge");
    add(element.start + element.duration, "clip-edge");
  }
  if (input.playheadTime !== null) add(input.playheadTime, "playhead");
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function snapTimelineTime(
  time: number,
  targets: readonly TimelineSnapTarget[],
  thresholdSeconds: number,
): { time: number; target: TimelineSnapTarget | null } {
  let best: TimelineSnapTarget | null = null;
  let bestDistance = thresholdSeconds;
  for (const target of targets) {
    const distance = Math.abs(target.time - time);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best &&
        TYPE_PRIORITY[target.type] < TYPE_PRIORITY[best.type])
    ) {
      bestDistance = distance;
      best = target;
    }
  }
  return best ? { time: best.time, target: best } : { time, target: null };
}

