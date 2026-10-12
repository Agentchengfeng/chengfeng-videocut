/** Peak buckets per second of asset audio; enough for a bar every 2px at normal zooms. */
export const PEAKS_PER_SECOND = 50;
const FRAME_STRIDE = 8;

/**
 * Reads normalized peaks (0..1) from a PCM WAV. Managed sound-effect assets are
 * always WAV, so the timeline can draw them without a server-side peaks route.
 */
export function wavPeaks(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const tag = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let format = 0, channels = 0, rate = 0, bits = 0, data = -1, dataBytes = 0;
  for (let at = 12; at + 8 <= buffer.byteLength;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'fmt ') {
      format = view.getUint16(at + 8, true); channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true); bits = view.getUint16(at + 22, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(at + 32, true);
    } else if (tag(at) === 'data') { data = at + 8; dataBytes = Math.min(size, buffer.byteLength - data); break; }
    at += 8 + size + (size & 1);
  }
  const bytes = bits / 8;
  const read = format === 3 && bits === 32 ? (o: number) => view.getFloat32(o, true)
    : format === 1 && bits === 16 ? (o: number) => view.getInt16(o, true) / 32768
    : format === 1 && bits === 24 ? (o: number) => ((view.getInt8(o + 2) << 16) | view.getUint16(o, true)) / 8388608
    : format === 1 && bits === 32 ? (o: number) => view.getInt32(o, true) / 2147483648
    : null;
  if (!read || data < 0 || !channels || !rate) throw new Error('Unsupported WAV encoding');
  const frameBytes = bytes * channels, frames = Math.floor(dataBytes / frameBytes), perBucket = rate / PEAKS_PER_SECOND;
  const peaks = new Array<number>(Math.max(1, Math.ceil(frames / perBucket))).fill(0);
  for (let frame = 0; frame < frames; frame += FRAME_STRIDE) {
    const bucket = Math.min(peaks.length - 1, Math.floor(frame / perBucket));
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.abs(read(data + frame * frameBytes + channel * bytes));
      if (value > peaks[bucket]!) peaks[bucket] = value;
    }
  }
  const max = Math.max(...peaks.slice(0, 1), peaks.reduce((a, b) => (b > a ? b : a), 0));
  return max > 0 ? peaks.map((p) => p / max) : peaks;
}

const cache = new Map<string, Promise<number[]>>();
export function requestSoundEffectPeaks(projectId: string, assetId: string): Promise<number[]> {
  const url = `/api/v1/projects/${encodeURIComponent(projectId)}/sound-effects/assets/${assetId}/content`;
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url, { cache: 'no-store' }).then(async (r) => { if (!r.ok) throw new Error(`waveform ${r.status}`); return wavPeaks(await r.arrayBuffer()); });
    pending.catch(() => cache.delete(url));
    cache.set(url, pending);
  }
  return pending;
}

/** Bottom-anchored filled outline of the [sourceIn, sourceOut] window, one bar per 2px. */
export function waveformAreaPath(peaks: readonly number[], sourceIn: number, sourceOut: number, width: number, height: number): string {
  const bars = Math.min(4000, Math.floor(width / 2));
  if (bars < 1 || !peaks.length || sourceOut <= sourceIn) return '';
  const from = sourceIn * PEAKS_PER_SECOND, span = (sourceOut - sourceIn) * PEAKS_PER_SECOND;
  let path = `M0 ${height}`;
  for (let bar = 0; bar < bars; bar++) {
    const a = Math.floor(from + (bar / bars) * span), b = Math.max(a + 1, Math.floor(from + ((bar + 1) / bars) * span));
    let peak = 0;
    for (let i = a; i < b && i < peaks.length; i++) if (peaks[i]! > peak) peak = peaks[i]!;
    const x = (bar / bars) * width, y = height - Math.max(1, peak * height);
    path += `L${x.toFixed(1)} ${y.toFixed(1)}L${(x + width / bars).toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${path}L${width} ${height}Z`;
}
