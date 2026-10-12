import { expect, it } from 'vitest';
import type { SoundEffectCue } from '@video-workbench/core';
import { layoutSoundTracks, withTrackMove } from './soundEffectTracks';

const cue = (id: string, start: number, length: number, track?: number): SoundEffectCue => ({
  id, assetId: 'a'.repeat(64), label: id, start, sourceIn: 0, sourceOut: length, gainDb: 0, fadeIn: 0, fadeOut: 0, mute: false,
  ...(track === undefined ? {} : { track }),
});
const rows = (cues: SoundEffectCue[]) => Object.fromEntries(layoutSoundTracks(cues).rows);

it('separates a full-length bed from the effects it overlaps and packs the rest', () => {
  const cues = [cue('bed', 0, 200), cue('a', 3, 1), cue('b', 3.5, 1), cue('c', 10, 1)];
  expect(rows(cues)).toEqual({ bed: 0, a: 1, b: 2, c: 1 });
  expect(layoutSoundTracks(cues).count).toBe(3);
});

it('keeps explicit tracks, closes empty rows and pushes collisions down', () => {
  expect(rows([cue('a', 0, 2, 5), cue('b', 0, 2, 2)])).toEqual({ b: 0, a: 1 });
  expect(rows([cue('a', 0, 2, 0), cue('b', 1, 2, 0)])).toEqual({ a: 0, b: 1 });
  expect(rows([cue('a', 0, 2, 0), cue('b', 2, 2, 0)])).toEqual({ a: 0, b: 0 });
});

it('materializes rows when a cue changes track', () => {
  const moved = withTrackMove([cue('bed', 0, 200), cue('a', 3, 1)], 'a', 4, 2);
  expect(moved.map((c) => [c.id, c.start, c.track])).toEqual([['bed', 0, 0], ['a', 4, 2]]);
  expect(rows(moved)).toEqual({ bed: 0, a: 1 });
});
