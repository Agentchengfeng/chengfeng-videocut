const NICE_INTERVALS = [
  0.02,
  0.05,
  0.1,
  0.2,
  0.5,
  1,
  2,
  5,
  10,
  15,
  30,
  60,
  120,
  300,
  600,
  900,
  1800,
  3600,
] as const;

const TARGET_MAJOR_PX = 88;
const MIN_MINOR_PX = 8;
const MAX_TICKS = 2000;

function roundedTick(time: number): number {
  return Math.round(time * 1_000_000) / 1_000_000;
}

function majorIntervalFor(pixelsPerSecond: number): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 10;
  return NICE_INTERVALS.find((candidate) => candidate * pixelsPerSecond >= TARGET_MAJOR_PX) ?? 3600;
}

function minorSubdivisions(majorInterval: number, pixelsPerSecond: number): number {
  for (const parts of [4, 2]) {
    if ((majorInterval / parts) * pixelsPerSecond >= MIN_MINOR_PX) return parts;
  }
  return 0;
}

export interface TimelineTicks {
  major: number[];
  minor: number[];
  majorInterval: number;
}

/**
 * Product-owned copy of HyperFrames' 1-2-5 ruler density contract.
 * Values are calculated from exact multiples rather than accumulated deltas,
 * so long rulers do not drift away from the playhead or clip geometry.
 */
export function generateTimelineTicks(
  duration: number,
  pixelsPerSecond: number,
): TimelineTicks {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14_400) {
    return { major: [], minor: [], majorInterval: 10 };
  }

  const majorInterval = majorIntervalFor(pixelsPerSecond);
  const subdivisions = minorSubdivisions(majorInterval, pixelsPerSecond);
  const minorInterval = subdivisions > 0 ? majorInterval / subdivisions : 0;
  const major: number[] = [];
  const minor: number[] = [];

  for (let index = 0; major.length + minor.length < MAX_TICKS; index += 1) {
    const time = index * majorInterval;
    if (time > duration + 0.001) break;
    major.push(roundedTick(time));
    for (let part = 1; part < subdivisions; part += 1) {
      const candidate = time + part * minorInterval;
      if (candidate > duration + 0.001 || major.length + minor.length >= MAX_TICKS) break;
      minor.push(roundedTick(candidate));
    }
  }

  return { major, minor, majorInterval };
}

function formatClock(seconds: number): string {
  const wholeSeconds = Math.floor(Math.max(0, seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const rest = wholeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function formatTimelineTickLabel(time: number, majorInterval: number): string {
  const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
  if (majorInterval < 0.1) {
    const hundredths = Math.round(safeTime * 100);
    return `${formatClock(Math.floor(hundredths / 100))}.${String(hundredths % 100).padStart(2, "0")}`;
  }
  if (majorInterval < 1) {
    const tenths = Math.round(safeTime * 10);
    return `${formatClock(Math.floor(tenths / 10))}.${tenths % 10}`;
  }
  return formatClock(safeTime);
}

export function formatTimelineClipRange(start: number, end: number): string {
  return `${formatClock(start)}–${formatClock(end)}`;
}
