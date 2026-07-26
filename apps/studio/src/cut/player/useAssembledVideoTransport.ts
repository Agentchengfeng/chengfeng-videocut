import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PreviewArtifactStream } from "./previewArtifact";

/**
 * Playback that never jumps.
 *
 * The predecessor played the whole proxy and set `currentTime` at every retained
 * boundary. Every measurement said it was clean — zero dropped frames, a single
 * contiguous buffered range, 0–1ms stalls, exact landing positions — and a person
 * listening heard deleted speech at every seam. Setting `currentTime` stops the
 * decoder, not the sound: the 150–400ms already handed to the sound card plays on,
 * and what sits immediately after a retained boundary is always deleted content.
 * Muting could not reach audio already past the volume stage; seeking early would
 * have clipped the end of retained speech. The defect was in the approach, not the
 * implementation.
 *
 * So the retained ranges are assembled into one continuous stream before playback
 * begins. There is no boundary to cross, which makes an entire class of bug
 * unreachable rather than guarded against.
 *
 * It is also much less code than the version it replaces, because once the stream
 * is assembled **timeline time is media time**. No segment index, no source-time
 * mapping, no boundary epsilon. A seek is a seek.
 */

export interface EdlVideoTransport {
  videoRef: RefObject<HTMLVideoElement | null>;
  timelineTime: number;
  duration: number;
  isPlaying: boolean;
  desiredPlaying: boolean;
  isWaiting: boolean;
  isSeeking: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  loopEnabled: boolean;
  error: string | null;
  play: () => Promise<void>;
  pause: () => void;
  togglePlay: () => Promise<void>;
  seek: (timelineTime: number, options?: { keepPlaying?: boolean }) => Promise<void>;
  restoreIntent: (timelineTime: number, shouldPlay: boolean) => Promise<void>;
  setPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  toggleMuted: () => void;
  toggleLoop: () => void;
}

/** Treat the playhead as parked at the end within this much of it. */
const END_EPSILON_SECONDS = 0.02;

interface AssembleTarget {
  /** Identity of what should be loaded. A change means rebuild. */
  key: string;
  stream: PreviewArtifactStream | null;
  sourceUrl: string | null;
}

function mediaErrorMessage(video: HTMLVideoElement): string {
  switch (video.error?.code) {
    case 1: return "媒体加载已中止";
    case 2: return "媒体网络读取失败";
    case 3: return "浏览器无法解码该媒体";
    case 4: return "浏览器不支持该媒体格式";
    default: return "媒体播放失败";
  }
}

export function useAssembledVideoTransport(input: {
  stream: PreviewArtifactStream | null;
  /** Used when there is no stream to assemble: a finished file, played straight through. */
  sourceUrl: string | null;
  /** Fragment paths are project-relative; this turns one into something fetchable. */
  resolveFragmentUrl: (source: string) => string;
  /** Falls back to the assembled length when the caller has none. */
  duration: number;
  initialTimelineTime: number;
}): EdlVideoTransport {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineTimeRef = useRef(Math.max(0, input.initialTimelineTime));
  const playingIntentRef = useRef(false);
  const seekGenerationRef = useRef(0);
  const pendingRestoreRef = useRef<{ timelineTime: number; shouldPlay: boolean } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [timelineTime, setTimelineTimeState] = useState(timelineTimeRef.current);
  const [isPlaying, setIsPlaying] = useState(false);
  const [desiredPlaying, setDesiredPlaying] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [assembledDuration, setAssembledDuration] = useState<number | null>(null);

  const target = useMemo<AssembleTarget>(() => ({
    // Fragment list plus order: two edits that retain the same ranges in the same
    // order genuinely are the same stream and must not force a rebuild.
    key: input.stream
      ? `stream:${input.stream.segments.map((segment) => `${segment.source}@${segment.out}`).join("|")}`
      : `file:${input.sourceUrl ?? ""}`,
    stream: input.stream,
    sourceUrl: input.sourceUrl,
  }), [input.stream, input.sourceUrl]);

  const duration = assembledDuration
    ?? (input.duration > 0 ? input.duration : input.stream?.totalSeconds ?? 0);

  const publishTimelineTime = useCallback((value: number, force = false) => {
    const next = Math.max(0, value);
    if (!force && Math.abs(next - timelineTimeRef.current) < 0.02) return;
    timelineTimeRef.current = next;
    setTimelineTimeState(next);
  }, []);

  // Assemble. Rebuilt only when the target's identity changes, so an edit that
  // leaves the retained ranges alone never disturbs playback.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    setReady(false);
    setAssembledDuration(null);
    setError(null);

    const releaseObjectUrl = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };

    if (!target.stream) {
      releaseObjectUrl();
      if (target.sourceUrl) {
        video.src = target.sourceUrl;
        setReady(true);
      } else {
        video.removeAttribute("src");
        video.load();
      }
      return () => { cancelled = true; };
    }

    const stream = target.stream;
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(stream.mimeType)) {
      setError("浏览器不支持拼接播放，无法预览");
      return () => { cancelled = true; };
    }

    const mediaSource = new MediaSource();
    releaseObjectUrl();
    const objectUrl = URL.createObjectURL(mediaSource);
    objectUrlRef.current = objectUrl;
    video.src = objectUrl;

    void (async () => {
      try {
        if (mediaSource.readyState !== "open") {
          await new Promise<void>((resolve) => {
            mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
          });
        }
        if (cancelled) return;
        const buffer = mediaSource.addSourceBuffer(stream.mimeType);
        buffer.mode = "segments";
        const settled = () => new Promise<void>((resolve) => {
          if (!buffer.updating) return resolve();
          buffer.addEventListener("updateend", () => resolve(), { once: true });
        });
        for (const segment of stream.segments) {
          if (cancelled) return;
          const response = await fetch(input.resolveFragmentUrl(segment.source));
          if (!response.ok) throw new Error(`片段读取失败 ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (cancelled) return;
          await settled();
          // The trim window is judged *after* `timestampOffset` is applied, so it
          // must be expressed in assembled time. Using source time here silently
          // discards every fragment and leaves an empty buffer with no error.
          buffer.appendWindowStart = 0;
          buffer.appendWindowEnd = Infinity;
          buffer.timestampOffset = segment.out - segment.headExtra;
          buffer.appendWindowStart = segment.out;
          buffer.appendWindowEnd = segment.out + segment.dur;
          buffer.appendBuffer(bytes);
          await settled();
        }
        if (cancelled) return;
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
        setAssembledDuration(stream.totalSeconds);
        setReady(true);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "拼接播放失败");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [input.resolveFragmentUrl, target]);

  useEffect(() => () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const seek = useCallback(async (
    rawTimelineTime: number,
    options: { keepPlaying?: boolean } = {},
  ): Promise<void> => {
    const video = videoRef.current;
    if (!video) return;
    const keepPlaying = options.keepPlaying ?? playingIntentRef.current;
    playingIntentRef.current = keepPlaying;
    setDesiredPlaying(keepPlaying);
    const generation = seekGenerationRef.current + 1;
    seekGenerationRef.current = generation;
    const bounded = Math.min(Math.max(0, rawTimelineTime), Math.max(0, duration));
    publishTimelineTime(bounded, true);
    setIsSeeking(true);
    try {
      video.currentTime = bounded;
    } catch {
      // A seek before the buffer exists is not a failure; readiness re-applies it.
      pendingRestoreRef.current = { timelineTime: bounded, shouldPlay: keepPlaying };
      return;
    }
    // Latest wins: an earlier seek that completes after this one must not resume
    // playback or move the playhead.
    if (generation !== seekGenerationRef.current) return;
    if (keepPlaying) {
      try {
        await video.play();
      } catch {
        setIsPlaying(false);
      }
    }
  }, [duration, publishTimelineTime]);

  // Apply whatever position was requested before the media could accept it.
  useEffect(() => {
    if (!ready) return;
    const pending = pendingRestoreRef.current;
    if (!pending) {
      const video = videoRef.current;
      if (video && Math.abs(video.currentTime - timelineTimeRef.current) > 0.05) {
        void seek(timelineTimeRef.current, { keepPlaying: playingIntentRef.current });
      }
      return;
    }
    pendingRestoreRef.current = null;
    void seek(pending.timelineTime, { keepPlaying: pending.shouldPlay });
  }, [ready, seek]);

  const play = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    playingIntentRef.current = true;
    setDesiredPlaying(true);
    // At the end, play means play again from the start — never silently continue
    // into whatever follows.
    if (duration > 0 && video.currentTime >= duration - END_EPSILON_SECONDS) {
      await seek(0, { keepPlaying: true });
      return;
    }
    try {
      await video.play();
    } catch {
      setIsPlaying(false);
    }
  }, [duration, seek]);

  const pause = useCallback(() => {
    playingIntentRef.current = false;
    setDesiredPlaying(false);
    videoRef.current?.pause();
  }, []);

  const togglePlay = useCallback(async () => {
    if (playingIntentRef.current) {
      pause();
      return;
    }
    await play();
  }, [pause, play]);

  const restoreIntent = useCallback(async (
    nextTimelineTime: number,
    shouldPlay: boolean,
  ): Promise<void> => {
    if (!ready) {
      pendingRestoreRef.current = { timelineTime: nextTimelineTime, shouldPlay };
      publishTimelineTime(nextTimelineTime, true);
      playingIntentRef.current = shouldPlay;
      setDesiredPlaying(shouldPlay);
      return;
    }
    await seek(nextTimelineTime, { keepPlaying: shouldPlay });
  }, [publishTimelineTime, ready, seek]);

  const setPlaybackRate = useCallback((rate: number) => {
    const next = Number.isFinite(rate) && rate > 0 ? rate : 1;
    setPlaybackRateState(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }, []);

  const setVolume = useCallback((value: number) => {
    const next = Math.min(1, Math.max(0, value));
    setVolumeState(next);
    if (videoRef.current) videoRef.current.volume = next;
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  }, []);

  const toggleLoop = useCallback(() => {
    setLoopEnabled((current) => !current);
  }, []);

  // Follow the media rather than a timer: the element is the only clock.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      publishTimelineTime(video.currentTime);
      setIsSeeking(false);
    };
    const onPlaying = () => { setIsPlaying(true); setIsWaiting(false); };
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setIsWaiting(true);
    const onSeeking = () => setIsSeeking(true);
    const onSeeked = () => { setIsSeeking(false); publishTimelineTime(video.currentTime, true); };
    const onError = () => setError(mediaErrorMessage(video));
    const onEnded = () => {
      setIsPlaying(false);
      if (loopEnabled) {
        void seek(0, { keepPlaying: true });
        return;
      }
      // Park at the end and stay there. Reaching the end is not a reason to keep
      // playing anything.
      playingIntentRef.current = false;
      setDesiredPlaying(false);
      publishTimelineTime(Math.max(0, duration), true);
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.removeEventListener("ended", onEnded);
    };
  }, [duration, loopEnabled, publishTimelineTime, seek]);

  return {
    videoRef,
    timelineTime,
    duration,
    isPlaying,
    desiredPlaying,
    isWaiting,
    isSeeking,
    playbackRate,
    volume,
    muted,
    loopEnabled,
    error,
    play,
    pause,
    togglePlay,
    seek,
    restoreIntent,
    setPlaybackRate,
    setVolume,
    toggleMuted,
    toggleLoop,
  };
}
