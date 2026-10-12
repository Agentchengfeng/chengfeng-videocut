import type { SoundEffectCue } from '@video-workbench/core';

const EPSILON = 1e-6;

export interface SoundTrackLayout {
  /** Display row per cue id (0 = first audio track). */
  rows: Map<string, number>;
  count: number;
}

/**
 * Projects cues onto audio track rows so that no two cues overlap in one row.
 * Cues that carry a track keep it when the row is free; cues without one (old
 * documents) take the first free row in insertion order. Empty rows are closed
 * up, so the result is always rows 0..count-1.
 */
export function layoutSoundTracks(cues: readonly SoundEffectCue[]): SoundTrackLayout {
  const placed: { id: string; start: number; end: number; row: number }[] = [];
  const free = (row: number, start: number, end: number) =>
    placed.every((p) => p.row !== row || p.end <= start + EPSILON || end <= p.start + EPSILON);
  const place = (cue: SoundEffectCue, preferred: number) => {
    const end = cue.start + cue.sourceOut - cue.sourceIn;
    let row = preferred;
    while (!free(row, cue.start, end)) row++;
    placed.push({ id: cue.id, start: cue.start, end, row });
  };
  const tracked = cues.filter((c) => c.track !== undefined).sort((a, b) => a.track! - b.track! || a.start - b.start);
  for (const cue of tracked) place(cue, cue.track!);
  for (const cue of cues) if (cue.track === undefined) place(cue, 0);
  const used = [...new Set(placed.map((p) => p.row))].sort((a, b) => a - b);
  return { rows: new Map(placed.map((p) => [p.id, used.indexOf(p.row)])), count: used.length };
}

/** Writes the displayed rows into the cues, with one cue moved to another row. */
export function withTrackMove(cues: readonly SoundEffectCue[], id: string, start: number, row: number): SoundEffectCue[] {
  const { rows } = layoutSoundTracks(cues);
  return cues.map((c) => (c.id === id ? { ...c, start, track: row } : { ...c, track: rows.get(c.id) ?? 0 }));
}
