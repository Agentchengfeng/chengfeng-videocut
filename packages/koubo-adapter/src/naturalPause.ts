export interface NaturalPauseWord {
  start: number;
  end: number;
  isGap?: boolean;
}

export interface NaturalPausePolicy {
  version: string;
  shortPauseMax: number;
  mediumPauseMax: number;
  mediumPauseTarget: number;
  longPauseTarget: number;
  keepAfterPreviousWord: number;
  keepBeforeNextWord: number;
}

export interface NaturalPauseDeleteSegment {
  start: number;
  end: number;
}

export interface NaturalPauseAction extends Record<string, unknown> {
  type:
    | "semantic-delete"
    | "explicit-gap-delete"
    | "pause-keep"
    | "pause-compress"
    | "head-tail-delete";
  start: number;
  end: number;
}

export interface NaturalPausePlan {
  policy: NaturalPausePolicy;
  deleteSegments: NaturalPauseDeleteSegment[];
  actions: NaturalPauseAction[];
  summary: {
    policy: string;
    selectedCount: number;
    semanticSelectedWords: number;
    semanticGroups: number;
    pausesKept: number;
    pausesCompressed: number;
    explicitGapsDeleted: number;
    headTailDeleted: number;
    deleteSegments: number;
    totalDeletedSeconds: number;
    sourceDuration: number;
    expectedDuration: number;
  };
}

export const DEFAULT_NATURAL_PAUSE_POLICY: Readonly<NaturalPausePolicy> = Object.freeze({
  version: "natural-pause-v2",
  shortPauseMax: 0.35,
  mediumPauseMax: 0.65,
  mediumPauseTarget: 0.22,
  longPauseTarget: 0.28,
  keepAfterPreviousWord: 0.08,
  keepBeforeNextWord: 0.16,
});

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePolicy(policy: Partial<NaturalPausePolicy> = {}): NaturalPausePolicy {
  return {
    version: policy.version || DEFAULT_NATURAL_PAUSE_POLICY.version,
    shortPauseMax: finiteNumber(
      policy.shortPauseMax,
      DEFAULT_NATURAL_PAUSE_POLICY.shortPauseMax,
    ),
    mediumPauseMax: finiteNumber(
      policy.mediumPauseMax,
      DEFAULT_NATURAL_PAUSE_POLICY.mediumPauseMax,
    ),
    mediumPauseTarget: finiteNumber(
      policy.mediumPauseTarget,
      DEFAULT_NATURAL_PAUSE_POLICY.mediumPauseTarget,
    ),
    longPauseTarget: finiteNumber(
      policy.longPauseTarget,
      DEFAULT_NATURAL_PAUSE_POLICY.longPauseTarget,
    ),
    keepAfterPreviousWord: finiteNumber(
      policy.keepAfterPreviousWord,
      DEFAULT_NATURAL_PAUSE_POLICY.keepAfterPreviousWord,
    ),
    keepBeforeNextWord: finiteNumber(
      policy.keepBeforeNextWord,
      DEFAULT_NATURAL_PAUSE_POLICY.keepBeforeNextWord,
    ),
  };
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}

function targetForPause(
  duration: number,
  policy: NaturalPausePolicy,
): { action: "keep" | "compress"; targetDuration: number } {
  if (duration <= policy.shortPauseMax) return { action: "keep", targetDuration: duration };
  if (duration <= policy.mediumPauseMax) {
    return { action: "compress", targetDuration: policy.mediumPauseTarget };
  }
  return { action: "compress", targetDuration: policy.longPauseTarget };
}

export function buildNaturalPausePlan(
  words: readonly NaturalPauseWord[],
  selectedIndices: Iterable<number>,
  options: {
    timelineStart?: number;
    timelineEnd?: number;
    policy?: Partial<NaturalPausePolicy>;
  } = {},
): NaturalPausePlan {
  const policy = normalizePolicy(options.policy);
  const selected = new Set(
    [...selectedIndices]
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < words.length),
  );
  const timelineStart = finiteNumber(options.timelineStart, 0);
  const timelineEnd = finiteNumber(
    options.timelineEnd,
    words.length > 0
      ? finiteNumber(words.at(-1)?.end, timelineStart)
      : timelineStart,
  );
  const rawSegments: Array<NaturalPauseDeleteSegment & { reason: string }> = [];
  const actions: NaturalPauseAction[] = [];
  const consumedGapIndices = new Set<number>();

  const isGap = (index: number): boolean => Boolean(words[index]?.isGap);
  const isSelectedSpeech = (index: number): boolean => selected.has(index) && !isGap(index);
  const nearestSpeech = (index: number, direction: -1 | 1): number => {
    for (let cursor = index + direction; cursor >= 0 && cursor < words.length; cursor += direction) {
      if (!isGap(cursor)) return cursor;
    }
    return -1;
  };
  const addSegment = (startValue: number, endValue: number, reason: string): void => {
    const start = finiteNumber(startValue, 0);
    const end = finiteNumber(endValue, start);
    if (end > start) rawSegments.push({ start, end, reason });
  };

  const semanticGroups: Array<{ first: number; last: number }> = [];
  let currentGroup: { first: number; last: number } | null = null;
  for (let index = 0; index < words.length; index += 1) {
    if (!isSelectedSpeech(index)) continue;
    if (!currentGroup) {
      currentGroup = { first: index, last: index };
      continue;
    }
    let hasRetainedSpeech = false;
    for (let between = currentGroup.last + 1; between < index; between += 1) {
      if (!isGap(between) && !selected.has(between)) {
        hasRetainedSpeech = true;
        break;
      }
    }
    if (hasRetainedSpeech) {
      semanticGroups.push(currentGroup);
      currentGroup = { first: index, last: index };
    } else {
      currentGroup.last = index;
    }
  }
  if (currentGroup) semanticGroups.push(currentGroup);

  for (const group of semanticGroups) {
    const previousSpeech = nearestSpeech(group.first, -1);
    const nextSpeech = nearestSpeech(group.last, 1);
    const firstWordStart = finiteNumber(words[group.first]?.start, timelineStart);
    const lastWordEnd = finiteNumber(words[group.last]?.end, firstWordStart);
    let start = firstWordStart;
    let end = lastWordEnd;
    const gapIndices: number[] = [];
    const leftBoundary = previousSpeech === -1 ? 0 : previousSpeech + 1;
    const rightBoundary = nextSpeech === -1 ? words.length : nextSpeech;
    for (let index = leftBoundary; index < rightBoundary; index += 1) {
      if (!isGap(index)) continue;
      consumedGapIndices.add(index);
      gapIndices.push(index);
    }
    if (previousSpeech === -1) {
      start = timelineStart;
    } else {
      const previousEnd = finiteNumber(words[previousSpeech]?.end, firstWordStart);
      start = previousEnd + Math.min(
        policy.keepAfterPreviousWord,
        Math.max(0, firstWordStart - previousEnd),
      );
    }
    if (nextSpeech === -1) {
      end = timelineEnd;
    } else {
      const nextStart = finiteNumber(words[nextSpeech]?.start, lastWordEnd);
      end = nextStart - Math.min(
        policy.keepBeforeNextWord,
        Math.max(0, nextStart - lastWordEnd),
      );
    }
    addSegment(start, end, "semantic-delete");
    actions.push({
      type: "semantic-delete",
      firstIndex: group.first,
      lastIndex: group.last,
      gapIndices,
      start: roundTime(start),
      end: roundTime(end),
      retainedBeforeSeconds: roundTime(Math.max(
        0,
        start - (previousSpeech === -1
          ? timelineStart
          : finiteNumber(words[previousSpeech]?.end, start)),
      )),
      retainedAfterSeconds: roundTime(Math.max(
        0,
        (nextSpeech === -1
          ? timelineEnd
          : finiteNumber(words[nextSpeech]?.start, end)) - end,
      )),
    });
  }

  for (let index = 0; index < words.length;) {
    if (!isGap(index) || !selected.has(index) || consumedGapIndices.has(index)) {
      index += 1;
      continue;
    }
    const indices = [index];
    let endIndex = index;
    while (
      endIndex + 1 < words.length &&
      isGap(endIndex + 1) &&
      selected.has(endIndex + 1) &&
      !consumedGapIndices.has(endIndex + 1)
    ) {
      endIndex += 1;
      indices.push(endIndex);
    }
    const start = finiteNumber(words[index]?.start, timelineStart);
    const end = finiteNumber(words[endIndex]?.end, start);
    addSegment(start, end, "explicit-gap-delete");
    actions.push({
      type: "explicit-gap-delete",
      indices,
      start: roundTime(start),
      end: roundTime(end),
      originalDuration: roundTime(Math.max(0, end - start)),
      targetDuration: 0,
    });
    index = endIndex + 1;
  }

  for (let index = 0; index < words.length;) {
    if (!isGap(index) || selected.has(index) || consumedGapIndices.has(index)) {
      index += 1;
      continue;
    }
    const indices = [index];
    let endIndex = index;
    while (
      endIndex + 1 < words.length &&
      isGap(endIndex + 1) &&
      !selected.has(endIndex + 1) &&
      !consumedGapIndices.has(endIndex + 1)
    ) {
      endIndex += 1;
      indices.push(endIndex);
    }
    const start = finiteNumber(words[index]?.start, timelineStart);
    const end = finiteNumber(words[endIndex]?.end, start);
    const duration = Math.max(0, end - start);
    const previousSpeech = nearestSpeech(index, -1);
    const nextSpeech = nearestSpeech(endIndex, 1);
    if (previousSpeech === -1 || nextSpeech === -1) {
      addSegment(start, end, "head-tail-dead-air");
      actions.push({
        type: "head-tail-delete",
        indices,
        start: roundTime(start),
        end: roundTime(end),
        originalDuration: roundTime(duration),
        targetDuration: 0,
      });
      index = endIndex + 1;
      continue;
    }
    const decision = targetForPause(duration, policy);
    if (decision.action === "keep") {
      actions.push({
        type: "pause-keep",
        indices,
        start: roundTime(start),
        end: roundTime(end),
        originalDuration: roundTime(duration),
        targetDuration: roundTime(duration),
      });
      index = endIndex + 1;
      continue;
    }
    const targetDuration = Math.min(duration, decision.targetDuration);
    const deleteEnd = end - targetDuration;
    addSegment(start, deleteEnd, "pause-compress");
    actions.push({
      type: "pause-compress",
      indices,
      start: roundTime(start),
      end: roundTime(end),
      deleteStart: roundTime(start),
      deleteEnd: roundTime(deleteEnd),
      originalDuration: roundTime(duration),
      targetDuration: roundTime(targetDuration),
    });
    index = endIndex + 1;
  }

  rawSegments.sort((left, right) => left.start - right.start || left.end - right.end);
  const deleteSegments: NaturalPauseDeleteSegment[] = [];
  for (const segment of rawSegments) {
    const clean = { start: roundTime(segment.start), end: roundTime(segment.end) };
    const previous = deleteSegments.at(-1);
    if (previous && clean.start <= previous.end + 0.001) {
      previous.end = roundTime(Math.max(previous.end, clean.end));
    } else {
      deleteSegments.push(clean);
    }
  }
  const totalDeletedSeconds = deleteSegments.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  );
  const sourceDuration = Math.max(0, timelineEnd - timelineStart);
  return {
    policy,
    deleteSegments,
    actions,
    summary: {
      policy: policy.version,
      selectedCount: selected.size,
      semanticSelectedWords: [...selected].filter((index) => !isGap(index)).length,
      semanticGroups: semanticGroups.length,
      pausesKept: actions.filter((action) => action.type === "pause-keep").length,
      pausesCompressed: actions.filter((action) => action.type === "pause-compress").length,
      explicitGapsDeleted: actions.filter((action) => action.type === "explicit-gap-delete").length,
      headTailDeleted: actions.filter((action) => action.type === "head-tail-delete").length,
      deleteSegments: deleteSegments.length,
      totalDeletedSeconds: roundTime(totalDeletedSeconds),
      sourceDuration: roundTime(sourceDuration),
      expectedDuration: roundTime(Math.max(0, sourceDuration - totalDeletedSeconds)),
    },
  };
}
