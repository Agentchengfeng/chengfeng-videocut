import { expect, it } from 'vitest';
import { PEAKS_PER_SECOND, wavPeaks, waveformAreaPath } from './soundEffectWaveform';

function wav(samples: number[], rate = 800): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
  view.setUint32(40, samples.length * 2, true); samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return buffer;
}

it('reads normalized peaks per time bucket from PCM WAV and rejects other data', () => {
  const quiet = new Array(800).fill(4000), loud = new Array(800).fill(-16000);
  const peaks = wavPeaks(wav([...quiet, ...loud]));
  expect(peaks).toHaveLength(2 * PEAKS_PER_SECOND);
  expect(peaks[0]).toBeCloseTo(0.25); expect(peaks[PEAKS_PER_SECOND]).toBe(1);
  expect(() => wavPeaks(new TextEncoder().encode('{"not":"a wav file"}').buffer as ArrayBuffer)).toThrow();
});

it('draws only the trimmed source window', () => {
  const peaks = [...new Array(PEAKS_PER_SECOND).fill(0.5), ...new Array(PEAKS_PER_SECOND).fill(1)];
  expect(waveformAreaPath(peaks, 1, 2, 4, 10)).toBe('M0 10L0.0 0.0L2.0 0.0L2.0 0.0L4.0 0.0L4 10Z');
  expect(waveformAreaPath(peaks, 0, 1, 4, 10)).toContain('L0.0 5.0');
  expect(waveformAreaPath(peaks, 0, 1, 1, 10)).toBe('');
});
