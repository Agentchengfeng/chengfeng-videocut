import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditListDocument } from "@video-workbench/core";
import type { EdlVideoTransport } from "./useEdlVideoTransport";

interface PendingRestoreIntent {
  timelineTime: number;
  shouldPlay: boolean;
}

interface PendingContinuousSeek {
  generation: number;
  target: number;
  keepPlaying: boolean;
}

const SEEK_TARGET_EPSILON_SECONDS = 0.03;

export function useContinuousVideoTransport(input: {
  document: EditListDocument | null;
  revision: string;
  sourceUrl: string | null;
  initialTimelineTime: number;
}): EdlVideoTransport {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineTimeRef = useRef(input.initialTimelineTime);
  const durationRef = useRef(input.document?.duration ?? 0);
  const mediaReadyRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingRestoreRef = useRef<PendingRestoreIntent | null>(null);
  const desiredPlayingRef = useRef(false);
  const seekGenerationRef = useRef(0);
  const pendingSeekRef = useRef<PendingContinuousSeek | null>(null);
  const [timelineTime, setTimelineTime] = useState(input.initialTimelineTime);
  const [isPlaying, setPlaying] = useState(false);
  const [desiredPlaying, setDesiredPlaying] = useState(false);
  const [isWaiting, setWaiting] = useState(false);
  const [isSeeking, setSeeking] = useState(false);
  const [playbackRate, setRate] = useState(1);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duration = input.document?.duration ?? 0;
  durationRef.current = duration;
  const publishTimelineTime = useCallback((value: number) => {
    const next = Math.max(0, Math.min(durationRef.current, Number(value) || 0));
    timelineTimeRef.current = next;
    setTimelineTime(next);
  }, []);
  const finishLatestSeek = useCallback(async (
    video: HTMLVideoElement,
    pending: PendingContinuousSeek,
  ) => {
    if (
      pendingSeekRef.current !== pending ||
      pending.generation !== seekGenerationRef.current ||
      Math.abs(video.currentTime - pending.target) > SEEK_TARGET_EPSILON_SECONDS
    ) return;
    pendingSeekRef.current = null;
    setSeeking(false);
    if (!pending.keepPlaying) {
      setPlaying(false);
      return;
    }
    try {
      await video.play();
      if (pending.generation !== seekGenerationRef.current) {
        video.pause();
        return;
      }
      setError(null);
    } catch {
      if (pending.generation === seekGenerationRef.current) {
        setError("媒体播放失败");
      }
    }
  }, []);
  const applySeek = useCallback(async (
    value: number,
    options?: { keepPlaying?: boolean },
  ): Promise<boolean> => {
    const video = videoRef.current;
    if (!video || !input.sourceUrl || video.readyState < 1) return false;
    const next = Math.max(0, Math.min(durationRef.current, Number(value) || 0));
    const keepPlaying = options?.keepPlaying ?? !video.paused;
    const pending: PendingContinuousSeek = {
      generation: seekGenerationRef.current + 1,
      target: next,
      keepPlaying,
    };
    seekGenerationRef.current = pending.generation;
    pendingSeekRef.current = pending;
    setSeeking(true);
    publishTimelineTime(next);
    // Never let the old source position continue audibly while the new point
    // is buffering. A matching `seeked` owns the later resume.
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - next) <= SEEK_TARGET_EPSILON_SECONDS) {
      await finishLatestSeek(video, pending);
      return true;
    }
    try {
      video.currentTime = next;
    } catch {
      if (pendingSeekRef.current === pending) {
        pendingSeekRef.current = null;
        setSeeking(false);
        setError("媒体播放失败");
      }
    }
    return true;
  }, [finishLatestSeek, input.sourceUrl, publishTimelineTime]);
  const seek = useCallback(async (value: number, options?: { keepPlaying?: boolean }) => {
    void await applySeek(value, options);
  }, [applySeek]);
  const restoreIntent = useCallback(async (value: number, shouldPlay: boolean) => {
    pendingRestoreRef.current = { timelineTime: value, shouldPlay };
    desiredPlayingRef.current = shouldPlay;
    setDesiredPlaying(shouldPlay);
    if (await applySeek(value, { keepPlaying: shouldPlay })) {
      pendingRestoreRef.current = null;
    }
  }, [applySeek]);
  const play = useCallback(async () => {
    desiredPlayingRef.current = true;
    setDesiredPlaying(true);
    const video = videoRef.current;
    if (!video) return;
    if (video.currentTime >= duration - 0.02) video.currentTime = 0;
    try { await video.play(); setError(null); } catch { desiredPlayingRef.current = false; setDesiredPlaying(false); setError("媒体播放失败"); }
  }, [duration]);
  const pause = useCallback(() => {
    desiredPlayingRef.current = false;
    setDesiredPlaying(false);
    seekGenerationRef.current += 1;
    pendingSeekRef.current = null;
    setSeeking(false);
    const video = videoRef.current;
    if (!video) return;
    publishTimelineTime(video.currentTime);
    video.pause();
  }, [publishTimelineTime]);
  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      if (desiredPlayingRef.current) pause();
      else await play();
      return;
    }
    if (video.paused) await play(); else pause();
  }, [pause, play]);
  const setPlaybackRate = useCallback((value: number) => {
    const next = Math.max(0.25, Math.min(4, value)); setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }, []);
  const setVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value)); setVolumeState(next);
    if (videoRef.current) videoRef.current.volume = next;
  }, []);
  const toggleMuted = useCallback(() => setMuted((value) => !value), []);
  const toggleLoop = useCallback(() => setLoopEnabled((value) => !value), []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    mediaReadyRef.current = false;
    seekGenerationRef.current += 1;
    pendingSeekRef.current = null;
    setError(null);
    const initializeTimelinePosition = () => {
      if (durationRef.current <= 0) return;
      const target = Math.max(0, Math.min(durationRef.current, timelineTimeRef.current));
      mediaReadyRef.current = true;
      if (Math.abs(video.currentTime - target) > 0.02) {
        setSeeking(true);
        video.currentTime = target;
      } else {
        setSeeking(false);
      }
      publishTimelineTime(target);
    };
    const time = () => {
      if (mediaReadyRef.current && durationRef.current > 0) publishTimelineTime(video.currentTime);
    };
    const playing = () => setPlaying(true);
    const paused = () => {
      if (mediaReadyRef.current) publishTimelineTime(video.currentTime);
      setPlaying(false);
    };
    const waiting = () => setWaiting(true);
    const ready = () => { setWaiting(false); };
    const seeked = () => {
      const pending = pendingSeekRef.current;
      if (!pending) {
        setSeeking(false);
        return;
      }
      if (Math.abs(video.currentTime - pending.target) > SEEK_TARGET_EPSILON_SECONDS) return;
      void finishLatestSeek(video, pending);
    };
    const restorePending = () => {
      const pending = pendingRestoreRef.current;
      if (!pending) return;
      pendingRestoreRef.current = null;
      desiredPlayingRef.current = pending.shouldPlay;
      setDesiredPlaying(pending.shouldPlay);
      void applySeek(pending.timelineTime, { keepPlaying: pending.shouldPlay }).then((applied) => {
        if (!applied && pendingRestoreRef.current == null) pendingRestoreRef.current = pending;
      });
    };
    const failed = () => {
      seekGenerationRef.current += 1;
      pendingSeekRef.current = null;
      setSeeking(false);
      setError("媒体播放失败");
    };
    video.addEventListener("loadedmetadata", initializeTimelinePosition);
    video.addEventListener("timeupdate", time); video.addEventListener("playing", playing);
    video.addEventListener("pause", paused); video.addEventListener("waiting", waiting);
    video.addEventListener("loadedmetadata", restorePending);
    video.addEventListener("seeked", seeked); video.addEventListener("canplay", ready);
    video.addEventListener("canplay", restorePending);
    video.addEventListener("error", failed);
    if (video.readyState >= 1) initializeTimelinePosition();
    return () => {
      video.removeEventListener("loadedmetadata", initializeTimelinePosition);
      video.removeEventListener("loadedmetadata", restorePending);
      video.removeEventListener("timeupdate", time); video.removeEventListener("playing", playing);
      video.removeEventListener("pause", paused); video.removeEventListener("waiting", waiting);
      video.removeEventListener("seeked", seeked); video.removeEventListener("canplay", ready);
      video.removeEventListener("canplay", restorePending);
      video.removeEventListener("error", failed); video.pause();
    };
  }, [applySeek, finishLatestSeek, input.sourceUrl, publishTimelineTime]);
  useEffect(() => {
    if (!isPlaying) {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      return;
    }
    const tick = () => {
      const video = videoRef.current;
      if (video && mediaReadyRef.current && !video.paused) {
        publishTimelineTime(video.currentTime);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [isPlaying, publishTimelineTime]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 1 || duration <= 0) return;
    const target = Math.max(0, Math.min(durationRef.current, timelineTimeRef.current));
    mediaReadyRef.current = true;
    if (Math.abs(video.currentTime - target) > 0.02) video.currentTime = target;
    publishTimelineTime(target);
  }, [duration, publishTimelineTime]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = playbackRate; }, [input.sourceUrl, playbackRate]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [input.sourceUrl, volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [input.sourceUrl, muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.loop = loopEnabled; }, [input.sourceUrl, loopEnabled]);
  return useMemo(() => ({
    videoRef, timelineTime, duration, isPlaying, desiredPlaying, isWaiting, isSeeking, playbackRate,
    volume, muted, loopEnabled, error, play, pause, togglePlay, seek, setPlaybackRate, setVolume,
    restoreIntent, toggleMuted, toggleLoop,
  }), [desiredPlaying, duration, error, isPlaying, isSeeking, isWaiting, muted, pause, play, playbackRate,
    restoreIntent, seek, setPlaybackRate, setVolume, timelineTime, toggleLoop, toggleMuted, togglePlay, volume,
    loopEnabled]);
}
