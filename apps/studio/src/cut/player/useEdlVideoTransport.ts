import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { EditListDocument } from "@video-workbench/core";
import {
  beginEdlSeek,
  createEdlSeekGenerationState,
  isCurrentEdlSeek,
  resolveEdlRevisionTransition,
  type EdlSeekRequest,
} from "./edlTransport";

const BOUNDARY_EPSILON_SECONDS = 0.012;
const SEEK_TARGET_EPSILON_SECONDS = 0.03;

interface PendingMediaSeek {
  request: EdlSeekRequest;
  keepPlaying: boolean;
}

interface PreviousEditListResource {
  document: EditListDocument;
  revision: string;
}

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

function normalizedRevision(value: string | null): string | null {
  const revision = value?.trim();
  return revision ? revision : null;
}

function clampTimelineTime(document: EditListDocument, value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(document.duration, Math.max(0, value));
}

function mediaErrorMessage(video: HTMLVideoElement): string {
  switch (video.error?.code) {
    case 1:
      return "媒体加载已中止";
    case 2:
      return "媒体网络读取失败";
    case 3:
      return "浏览器无法解码该媒体";
    case 4:
      return "浏览器不支持该媒体格式";
    default:
      return "媒体播放失败";
  }
}

export function resolveEdlMediaPlaybackRate(
  userPlaybackRate: number,
  segmentPlaybackRate: number,
): number {
  return userPlaybackRate * segmentPlaybackRate;
}

export function useEdlVideoTransport(input: {
  document: EditListDocument | null;
  revision: string | null;
  sourceUrl: string | null;
  initialTimelineTime: number;
}): EdlVideoTransport {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const documentRef = useRef(input.document);
  const revisionRef = useRef(normalizedRevision(input.revision));
  const previousResourceRef = useRef<PreviousEditListResource | null>(null);
  const timelineTimeRef = useRef(Math.max(0, input.initialTimelineTime));
  const segmentIndexRef = useRef(0);
  const playingIntentRef = useRef(false);
  const playbackRateRef = useRef(1);
  const loopEnabledRef = useRef(false);
  const seekStateRef = useRef(createEdlSeekGenerationState());
  const pendingMediaSeekRef = useRef<PendingMediaSeek | null>(null);
  const frameRef = useRef<number | null>(null);
  const [timelineTime, setTimelineTime] = useState(timelineTimeRef.current);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  documentRef.current = input.document;
  revisionRef.current = normalizedRevision(input.revision);

  const publishTimelineTime = useCallback((value: number, force = false) => {
    const document = documentRef.current;
    const next = document ? clampTimelineTime(document, value) : Math.max(0, value);
    if (!force && Math.abs(next - timelineTimeRef.current) < 0.02) return;
    timelineTimeRef.current = next;
    setTimelineTime(next);
  }, []);

  const isCurrentRequest = useCallback((request: EdlSeekRequest): boolean => {
    return (
      revisionRef.current === request.revision &&
      isCurrentEdlSeek(seekStateRef.current, request)
    );
  }, []);

  const invalidatePendingSeek = useCallback((revision: string | null) => {
    seekStateRef.current = {
      generation: seekStateRef.current.generation + 1,
      revision,
    };
    pendingMediaSeekRef.current = null;
    setIsSeeking(false);
  }, []);

  const pause = useCallback(() => {
    playingIntentRef.current = false;
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
    setIsPlaying(false);
  }, []);

  const applyActivePlaybackRate = useCallback((video: HTMLVideoElement, segmentIndex: number) => {
    const segmentRate = documentRef.current?.segments[segmentIndex]?.playbackRate ?? 1;
    video.playbackRate = resolveEdlMediaPlaybackRate(playbackRateRef.current, segmentRate);
  }, []);

  const startVideo = useCallback(async (request: EdlSeekRequest): Promise<void> => {
    const video = videoRef.current;
    if (!video || !isCurrentRequest(request) || !playingIntentRef.current) return;
    try {
      await video.play();
      if (!isCurrentRequest(request) || !playingIntentRef.current) {
        video.pause();
        return;
      }
      setError(null);
      setIsPlaying(true);
    } catch (cause) {
      if (!isCurrentRequest(request)) return;
      playingIntentRef.current = false;
      setIsPlaying(false);
      setError(cause instanceof Error ? cause.message : "浏览器拒绝了有声播放");
    }
  }, [isCurrentRequest]);

  const applyMediaSeek = useCallback((pending: PendingMediaSeek) => {
    const { request, keepPlaying } = pending;
    if (!isCurrentRequest(request)) return;
    const video = videoRef.current;
    segmentIndexRef.current = request.position.segmentIndex;

    if (!video || video.readyState === 0) {
      pendingMediaSeekRef.current = pending;
      if (!keepPlaying) setIsPlaying(false);
      return;
    }

    applyActivePlaybackRate(video, request.position.segmentIndex);

    const needsSeek = Math.abs(video.currentTime - request.position.sourceTime) >
      BOUNDARY_EPSILON_SECONDS;
    if (!needsSeek) {
      pendingMediaSeekRef.current = null;
      setIsSeeking(false);
      if (keepPlaying) void startVideo(request);
      else setIsPlaying(false);
      return;
    }

    pendingMediaSeekRef.current = pending;
    setIsSeeking(true);
    // A magnetic jump must never keep emitting the source range that the EDL
    // just skipped. Pause first, then resume only after the matching seeked
    // event confirms that the retained target frame is active.
    if (!video.paused) video.pause();
    try {
      video.currentTime = request.position.sourceTime;
    } catch (cause) {
      if (!isCurrentRequest(request)) return;
      pendingMediaSeekRef.current = null;
      setIsSeeking(false);
      playingIntentRef.current = false;
      setIsPlaying(false);
      setError(cause instanceof Error ? cause.message : "无法定位媒体");
    }
  }, [applyActivePlaybackRate, isCurrentRequest, startVideo]);

  const seek = useCallback(async (
    rawTimelineTime: number,
    options: { keepPlaying?: boolean } = {},
  ): Promise<void> => {
    const document = documentRef.current;
    const revision = revisionRef.current;
    if (!document) return;
    if (!revision) {
      pause();
      setError("剪辑版本尚未就绪");
      return;
    }

    const keepPlaying = options.keepPlaying ?? playingIntentRef.current;
    playingIntentRef.current = keepPlaying;
    let result: ReturnType<typeof beginEdlSeek>;
    try {
      result = beginEdlSeek(seekStateRef.current, {
        revision,
        document,
        timelineTime: rawTimelineTime,
      });
    } catch (cause) {
      playingIntentRef.current = false;
      setIsPlaying(false);
      setError(cause instanceof Error ? cause.message : "当前播放位置无法映射到源媒体");
      return;
    }

    seekStateRef.current = result.state;
    segmentIndexRef.current = result.request.position.segmentIndex;
    publishTimelineTime(result.request.position.timelineTime, true);
    setError(null);
    applyMediaSeek({ request: result.request, keepPlaying });
  }, [applyMediaSeek, pause, publishTimelineTime]);

  const play = useCallback(async (): Promise<void> => {
    const document = documentRef.current;
    if (!document || !input.sourceUrl) return;
    const restart = timelineTimeRef.current >= document.duration - BOUNDARY_EPSILON_SECONDS;
    await seek(restart ? 0 : timelineTimeRef.current, { keepPlaying: true });
  }, [input.sourceUrl, seek]);

  const togglePlay = useCallback(async (): Promise<void> => {
    if (playingIntentRef.current) pause();
    else await play();
  }, [pause, play]);

  const restoreIntent = useCallback(async (
    timelineTime: number,
    shouldPlay: boolean,
  ): Promise<void> => {
    await seek(timelineTime, { keepPlaying: shouldPlay });
  }, [seek]);

  const setPlaybackRate = useCallback((rate: number) => {
    const next = [0.5, 1, 1.5, 2].includes(rate) ? rate : 1;
    playbackRateRef.current = next;
    setPlaybackRateState(next);
    if (videoRef.current) applyActivePlaybackRate(videoRef.current, segmentIndexRef.current);
  }, [applyActivePlaybackRate]);

  const setVolume = useCallback((nextVolume: number) => {
    const next = Math.min(1, Math.max(0, Number.isFinite(nextVolume) ? nextVolume : 1));
    setVolumeState(next);
    if (videoRef.current) videoRef.current.volume = next;
    if (next > 0) setMuted(false);
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  }, []);

  const toggleLoop = useCallback(() => {
    loopEnabledRef.current = !loopEnabledRef.current;
    setLoopEnabled(loopEnabledRef.current);
  }, []);

  const syncFromMedia = useCallback(() => {
    const document = documentRef.current;
    const video = videoRef.current;
    if (!document || !revisionRef.current || !video || video.seeking || document.segments.length === 0) {
      return;
    }
    let index = Math.min(segmentIndexRef.current, document.segments.length - 1);
    let segment = document.segments[index];
    if (!segment) return;

    const sourceTime = video.currentTime;
    const atOrPastEnd = sourceTime >= segment.sourceEnd - BOUNDARY_EPSILON_SECONDS;
    if (atOrPastEnd) {
      const next = document.segments[index + 1];
      if (!next) {
        if (loopEnabledRef.current) {
          void seek(0, { keepPlaying: true });
          return;
        }
        publishTimelineTime(document.duration, true);
        pause();
        return;
      }
      index += 1;
      segmentIndexRef.current = index;
      segment = next;
      publishTimelineTime(segment.timelineStart, true);
      void seek(segment.timelineStart, { keepPlaying: playingIntentRef.current });
      return;
    }

    if (sourceTime < segment.sourceStart - BOUNDARY_EPSILON_SECONDS) {
      void seek(segment.timelineStart, { keepPlaying: playingIntentRef.current });
      return;
    }

    const currentTimelineTime = segment.timelineStart +
      (Math.max(segment.sourceStart, sourceTime) - segment.sourceStart) / segment.playbackRate;
    publishTimelineTime(currentTimelineTime);
  }, [pause, publishTimelineTime, seek]);

  useEffect(() => {
    if (!isPlaying) {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      return;
    }
    const tick = () => {
      syncFromMedia();
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [isPlaying, syncFromMedia]);

  useEffect(() => {
    const document = input.document;
    const revision = normalizedRevision(input.revision);
    if (!document || !revision) {
      previousResourceRef.current = null;
      invalidatePendingSeek(revision);
      pause();
      publishTimelineTime(0, true);
      if (document && !revision) setError("剪辑版本尚未就绪");
      return;
    }

    const previous = previousResourceRef.current;
    previousResourceRef.current = { document, revision };
    if (!previous) {
      void seek(input.initialTimelineTime, { keepPlaying: false });
      return;
    }
    if (previous.document === document && previous.revision === revision) return;

    try {
      const transition = resolveEdlRevisionTransition({
        oldDocument: previous.document,
        oldRevision: previous.revision,
        newDocument: document,
        newRevision: revision,
        currentTimelineTime: timelineTimeRef.current,
        wasPlaying: playingIntentRef.current,
      });
      void seek(transition.timelineTime, { keepPlaying: transition.keepPlaying });
    } catch (cause) {
      invalidatePendingSeek(revision);
      pause();
      setError(cause instanceof Error ? cause.message : "剪辑版本切换失败");
    }
  }, [
    input.document,
    input.initialTimelineTime,
    input.revision,
    invalidatePendingSeek,
    pause,
    publishTimelineTime,
    seek,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoadedMetadata = () => {
      applyActivePlaybackRate(video, segmentIndexRef.current);
      video.volume = volume;
      video.muted = muted;
      const pending = pendingMediaSeekRef.current;
      if (pending && isCurrentRequest(pending.request)) {
        applyMediaSeek(pending);
        return;
      }
      void seek(timelineTimeRef.current, { keepPlaying: playingIntentRef.current });
    };
    const onPlay = () => {
      if (!playingIntentRef.current) {
        video.pause();
        setIsPlaying(false);
        return;
      }
      setIsPlaying(true);
      setIsWaiting(false);
    };
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setIsWaiting(true);
    const onPlaying = () => setIsWaiting(false);
    const onSeeking = () => setIsSeeking(true);
    const onSeeked = () => {
      const pending = pendingMediaSeekRef.current;
      if (!pending || !isCurrentRequest(pending.request)) return;
      if (
        Math.abs(video.currentTime - pending.request.position.sourceTime) >
        SEEK_TARGET_EPSILON_SECONDS
      ) {
        return;
      }
      pendingMediaSeekRef.current = null;
      setIsSeeking(false);
      setIsWaiting(false);
      segmentIndexRef.current = pending.request.position.segmentIndex;
      if (pending.keepPlaying) void startVideo(pending.request);
      else setIsPlaying(false);
    };
    const onError = () => {
      playingIntentRef.current = false;
      pendingMediaSeekRef.current = null;
      setIsPlaying(false);
      setIsSeeking(false);
      setError(mediaErrorMessage(video));
    };
    const onEnded = () => {
      if (loopEnabledRef.current && documentRef.current) {
        void seek(0, { keepPlaying: true });
        return;
      }
      playingIntentRef.current = false;
      pendingMediaSeekRef.current = null;
      setIsPlaying(false);
      setIsSeeking(false);
      if (documentRef.current) publishTimelineTime(documentRef.current.duration, true);
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", syncFromMedia);
    video.addEventListener("error", onError);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", syncFromMedia);
      video.removeEventListener("error", onError);
      video.removeEventListener("ended", onEnded);
    };
  }, [
    applyMediaSeek,
    applyActivePlaybackRate,
    input.sourceUrl,
    isCurrentRequest,
    muted,
    playbackRate,
    publishTimelineTime,
    seek,
    startVideo,
    syncFromMedia,
    volume,
  ]);

  useEffect(() => () => {
    playingIntentRef.current = false;
    seekStateRef.current = {
      generation: seekStateRef.current.generation + 1,
      revision: null,
    };
    pendingMediaSeekRef.current = null;
    previousResourceRef.current = null;
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
  }, []);

  return useMemo(() => ({
    videoRef,
    timelineTime,
    duration: input.document?.duration ?? 0,
    isPlaying,
    desiredPlaying: playingIntentRef.current,
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
  }), [
    error,
    input.document?.duration,
    isPlaying,
    isSeeking,
    isWaiting,
    loopEnabled,
    muted,
    pause,
    play,
    playbackRate,
    seek,
    restoreIntent,
    setPlaybackRate,
    setVolume,
    timelineTime,
    toggleMuted,
    toggleLoop,
    togglePlay,
    volume,
  ]);
}
