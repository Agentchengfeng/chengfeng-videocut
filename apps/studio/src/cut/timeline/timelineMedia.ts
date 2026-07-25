import type { EditListSegment } from "@video-workbench/core";

const FRAME_CONCURRENCY = 4;
const FRAME_TILE_TARGET_WIDTH = 112;
const FRAME_MAX_COUNT = 4;
const FRAME_WIDTH_BUCKETS = [96, 160, 240, 320, 480, 640] as const;
const FRAME_BLOB_CACHE_LIMIT = 160;
const WAVEFORM_BAR_STEP = 3;
// A source window quieter than this is not promoted to a full-height waveform.
// It keeps very faint noise visually quiet while normal spoken clips remain legible.
const WAVEFORM_LOCAL_NORMALIZATION_FLOOR = 0.04;

interface QueueEntry<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface WaveformResponse {
  peaks?: unknown;
}

interface TimelineMediaErrorResponse {
  error?: { code?: unknown; message?: unknown };
}

export class TimelineWaveformRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let activeFrameRequests = 0;
const frameQueue: Array<QueueEntry<Blob>> = [];
const frameInflightRequests = new Map<string, Promise<Blob>>();
const frameBlobCache = new Map<string, Blob>();
const waveformPeaksCache = new Map<string, Promise<readonly number[]>>();

function drainFrameQueue(): void {
  while (activeFrameRequests < FRAME_CONCURRENCY && frameQueue.length > 0) {
    const entry = frameQueue.shift();
    if (!entry) return;
    activeFrameRequests += 1;
    void entry.run().then(entry.resolve, entry.reject).finally(() => {
      activeFrameRequests -= 1;
      drainFrameQueue();
    });
  }
}

function scheduleFrameRequest(run: () => Promise<Blob>): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    frameQueue.push({ run, resolve, reject });
    drainFrameQueue();
  });
}

export function timelineFrameWidthBucket(width: number): number {
  const normalized = Number.isFinite(width) ? Math.max(1, Math.ceil(width)) : 96;
  return FRAME_WIDTH_BUCKETS.find((candidate) => candidate >= normalized) ?? 640;
}

export function timelineFrameCount(segmentWidth: number): number {
  if (!Number.isFinite(segmentWidth) || segmentWidth <= 0) return 0;
  return Math.min(
    FRAME_MAX_COUNT,
    Math.max(1, Math.ceil(segmentWidth / FRAME_TILE_TARGET_WIDTH)),
  );
}

export function timelineFrameTimes(
  segment: EditListSegment,
  sourceDuration: number,
  count: number,
): number[] {
  if (count <= 0) return [];
  const durationLimit = Number.isFinite(sourceDuration) && sourceDuration > 0
    ? sourceDuration
    : segment.sourceEnd;
  const start = Math.max(0, Math.min(durationLimit, segment.sourceStart));
  const end = Math.max(start, Math.min(durationLimit, segment.sourceEnd));
  const span = end - start;
  if (span <= 0) return Array.from({ length: count }, () => start);
  return Array.from(
    { length: count },
    (_, index) => start + ((index + 0.5) / count) * span,
  );
}

export function buildTimelineFrameUrl({
  projectId,
  source,
  time,
  width,
}: {
  projectId: string;
  source: string;
  time: number;
  width: number;
}): string {
  const query = new URLSearchParams({
    source,
    time: Math.max(0, time).toFixed(3),
    width: String(timelineFrameWidthBucket(width)),
  });
  return `/api/v1/projects/${encodeURIComponent(projectId)}/media/frame?${query.toString()}`;
}

export function buildTimelineWaveformUrl(projectId: string, source: string): string {
  const query = new URLSearchParams({ source });
  return `/api/v1/projects/${encodeURIComponent(projectId)}/media/waveform?${query.toString()}`;
}

export function requestTimelineFrameBlob(url: string): Promise<Blob> {
  const cached = frameBlobCache.get(url);
  if (cached) {
    frameBlobCache.delete(url);
    frameBlobCache.set(url, cached);
    return Promise.resolve(cached);
  }

  const inflight = frameInflightRequests.get(url);
  if (inflight) return inflight;

  const scheduled = scheduleFrameRequest(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Frame request failed with ${response.status}`);
    }
    return response.blob();
  });
  let request: Promise<Blob>;
  request = scheduled.then(
    (blob) => {
      if (frameInflightRequests.get(url) === request) {
        frameInflightRequests.delete(url);
      }
      frameBlobCache.set(url, blob);
      while (frameBlobCache.size > FRAME_BLOB_CACHE_LIMIT) {
        const oldest = frameBlobCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        frameBlobCache.delete(oldest);
      }
      return blob;
    },
    (error: unknown) => {
      if (frameInflightRequests.get(url) === request) {
        frameInflightRequests.delete(url);
      }
      throw error;
    },
  );
  frameInflightRequests.set(url, request);
  return request;
}

function parseWaveformPeaks(payload: WaveformResponse): readonly number[] {
  if (!Array.isArray(payload.peaks) || payload.peaks.length === 0) {
    throw new Error("Waveform response has no peaks");
  }
  const peaks = payload.peaks.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Waveform response contains an invalid peak");
    }
    return Math.max(0, Math.min(1, Math.abs(value)));
  });
  return peaks;
}

export function requestTimelineWaveformPeaks(
  projectId: string,
  source: string,
): Promise<readonly number[]> {
  const key = `${projectId}\u0000${source}`;
  const cached = waveformPeaksCache.get(key);
  if (cached) return cached;

  const request = fetch(buildTimelineWaveformUrl(projectId, source))
    .then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as TimelineMediaErrorResponse | null;
        const code = typeof payload?.error?.code === "string"
          ? payload.error.code
          : "waveform_not_available";
        const message = typeof payload?.error?.message === "string"
          ? payload.error.message
          : `Waveform request failed with ${response.status}`;
        throw new TimelineWaveformRequestError(code, response.status, message);
      }
      return response.json() as Promise<WaveformResponse>;
    })
    .then(parseWaveformPeaks);
  waveformPeaksCache.set(key, request);
  // Concurrent consumers share one request, but a failed enhancement remains
  // recoverable without reloading the whole Studio session.
  void request.catch(() => {
    if (waveformPeaksCache.get(key) === request) waveformPeaksCache.delete(key);
  });
  return request;
}

export function resampleTimelineWaveform({
  peaks,
  sourceStart,
  sourceEnd,
  sourceDuration,
  pixelWidth,
}: {
  peaks: readonly number[];
  sourceStart: number;
  sourceEnd: number;
  sourceDuration: number;
  pixelWidth: number;
}): number[] {
  if (peaks.length === 0 || sourceDuration <= 0 || pixelWidth <= 0) return [];
  const startFraction = Math.max(0, Math.min(1, sourceStart / sourceDuration));
  const endFraction = Math.max(startFraction, Math.min(1, sourceEnd / sourceDuration));
  const sourceLo = Math.min(peaks.length - 1, Math.floor(startFraction * peaks.length));
  const sourceHi = Math.max(sourceLo + 1, Math.min(peaks.length, Math.ceil(endFraction * peaks.length)));
  const sourceSpan = sourceHi - sourceLo;
  const barCount = Math.max(1, Math.floor(pixelWidth / WAVEFORM_BAR_STEP));

  return Array.from({ length: barCount }, (_, barIndex) => {
    const binStart = sourceLo + Math.floor((barIndex / barCount) * sourceSpan);
    const binEnd = sourceLo + Math.max(
      1,
      Math.ceil(((barIndex + 1) / barCount) * sourceSpan),
    );
    let maximum = 0;
    for (let peakIndex = binStart; peakIndex < Math.min(sourceHi, binEnd); peakIndex += 1) {
      maximum = Math.max(maximum, peaks[peakIndex] ?? 0);
    }
    return maximum;
  });
}

/**
 * Makes real source peaks readable inside one EDL segment without moving their
 * horizontal positions. The source endpoint remains the single truth: this is
 * only a bounded visual gain after the segment source window has been sampled.
 */
export function normalizeTimelineWaveform(peaks: readonly number[]): number[] {
  if (peaks.length === 0) return [];
  const maximum = peaks.reduce((currentMaximum, peak) =>
    Math.max(currentMaximum, Number.isFinite(peak) ? Math.max(0, peak) : 0), 0);
  if (maximum <= 0) return peaks.map(() => 0);
  const reference = Math.max(WAVEFORM_LOCAL_NORMALIZATION_FLOOR, maximum);
  return peaks.map((peak) => Math.min(1, Math.max(0, peak) / reference));
}

export function waveformSvgPath(peaks: readonly number[], width: number, height = 28): string {
  if (peaks.length === 0 || width <= 0 || height <= 0) return "";
  const center = height / 2;
  const maximumAmplitude = Math.max(1, center - 1);
  return peaks.map((amplitude, index) => {
    const x = ((index + 0.5) / peaks.length) * width;
    const halfHeight = Math.max(0.6, Math.min(1, amplitude) * maximumAmplitude);
    return `M${x.toFixed(2)} ${(center - halfHeight).toFixed(2)}V${(center + halfHeight).toFixed(2)}`;
  }).join("");
}

/** Test-only cache reset. Production callers should never clear session caches. */
export function resetTimelineMediaCachesForTests(): void {
  frameInflightRequests.clear();
  frameBlobCache.clear();
  waveformPeaksCache.clear();
  frameQueue.splice(0, frameQueue.length);
  activeFrameRequests = 0;
}
