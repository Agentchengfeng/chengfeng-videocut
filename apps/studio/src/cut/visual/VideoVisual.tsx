import { useEffect, useRef, useState } from "react";
import { isVisualTimeActive } from "@video-workbench/core";
import type { ActiveVisual } from "./VisualOverlay";
import { visualWinner } from "./VisualOverlay";

/** A follower of the narration clock, never another timeline or audio owner. */
export function VideoVisual({ layer, layers }: { layer: ActiveVisual; layers?: readonly ActiveVisual[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<{ src: string; message: string } | null>(null);
  const [active, setActive] = useState(false);
  const { layerId, src, start, duration } = layer;
  const sourceIn = layer.media?.sourceIn;
  const layersRef = useRef(layers);
  layersRef.current = layers;
  // Timing edits must not discard the same source's decoded frames.
  // The keyed video owns resources until its source changes or it unmounts.
  useEffect(() => {
    const video = ref.current;
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);
  useEffect(() => {
    const video = ref.current;
    const master = video?.closest(".cf-cut-player-stage")?.querySelector('video[data-koubo-media-owner="video"]');
    if (!video || !(master instanceof HTMLVideoElement) || master === video || sourceIn === undefined) return;
    if (!video.hasAttribute("src")) video.src = src;
    let raf = 0, previousActive = false, forced = true, disposed = false, playBlocked = false;
    let pendingPlay: { cancelled: boolean } | null = null;
    const isActive = () => layersRef.current
      ? visualWinner(layersRef.current, master.currentTime)?.layerId === layerId
      : isVisualTimeActive(master.currentTime, start, start + duration);
    const wantsPlayback = () => isActive() && !master.paused && !master.seeking && !master.ended;
    const pause = () => {
      // Keep the pending request until it settles. A second play must not race
      // the pause which cancelled the first one, even after a rapid resume.
      const needsPause = !video.paused || (pendingPlay !== null && !pendingPlay.cancelled);
      if (pendingPlay) pendingPlay.cancelled = true;
      if (needsPause) video.pause();
    };
    const mediaError = () => {
      if (disposed) return;
      const failure = video.error;
      const reasons: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      const reason = failure ? (reasons[failure.code] ?? `MediaError ${failure.code}`) : "MediaError";
      playBlocked = true;
      pause();
      setError({ src, message: failure?.message ? `${reason}: ${failure.message}` : reason });
    };
    const recover = () => {
      if (disposed || video.error) return;
      playBlocked = false;
      setError(null);
    };
    const sync = () => {
      if (disposed) return;
      const visible = isActive();
      setActive((current) => current === visible ? current : visible);
      video.style.visibility = visible ? "visible" : "hidden";
      if (!visible) { pause(); previousActive = false; return; }
      const shouldPlay = wantsPlayback();
      if (!shouldPlay) pause();
      const target = sourceIn + Math.min(duration - 0.001, Math.max(0, master.currentTime - start));
      if (video.readyState >= 1) {
        if (!video.seeking && (forced || !previousActive || Math.abs(video.currentTime - target) > (master.paused ? 0.025 : 0.12))) {
          if (pendingPlay) pause();
          video.currentTime = target; forced = false;
        }
        video.playbackRate = master.playbackRate;
        if (shouldPlay && !video.seeking && video.paused && !pendingPlay && !playBlocked && !video.error) {
          const request = { cancelled: false };
          pendingPlay = request;
          void video.play().then(() => {
            if (disposed || pendingPlay !== request) return;
            if (request.cancelled || !wantsPlayback()) { pause(); return; }
            recover();
          }).catch((failure: unknown) => {
            if (disposed || request.cancelled || pendingPlay !== request || !wantsPlayback()) return;
            const name = failure && typeof failure === "object" && "name" in failure ? String(failure.name) : "PlayError";
            // Browser cancellation is not a decoder/network failure. A real
            // media error still arrives separately through the error event.
            if (name === "AbortError") return;
            playBlocked = true;
            const message = failure && typeof failure === "object" && "message" in failure ? String(failure.message) : String(failure);
            setError({ src, message: `${name}: ${message}` });
          }).finally(() => {
            if (disposed || pendingPlay !== request) return;
            pendingPlay = null;
            if (request.cancelled) sync();
          });
        }
      }
      previousActive = true;
    };
    const force = (event: Event) => {
      if (event.type === "play" || event.type === "seeked") playBlocked = false;
      forced = true;
      sync();
    };
    const ready = () => { recover(); sync(); };
    const tick = () => { sync(); raf = requestAnimationFrame(tick); };
    for (const event of ["seeking", "seeked", "pause", "play", "ratechange"]) master.addEventListener(event, force);
    video.addEventListener("loadedmetadata", force);
    video.addEventListener("seeked", sync);
    video.addEventListener("error", mediaError);
    for (const event of ["loadeddata", "canplay", "playing"]) video.addEventListener(event, ready);
    setError(null);
    if (video.error) mediaError();
    sync();
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf); pause();
      for (const event of ["seeking", "seeked", "pause", "play", "ratechange"]) master.removeEventListener(event, force);
      video.removeEventListener("loadedmetadata", force);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("error", mediaError);
      for (const event of ["loadeddata", "canplay", "playing"]) video.removeEventListener(event, ready);
    };
  }, [layerId, src, start, duration, sourceIn]);
  return <>
    <video key={src} ref={ref} data-broll={layerId} className="cf-cut-visual-overlay__frame" src={src}
      muted playsInline preload="auto"
      style={{ visibility: "hidden", objectFit: layer.media?.fit, background: "black", width: "100%", height: "100%" }} />
    {active && error?.src === src && <span role="alert" style={{ color: "#fff", background: "#9f2222", position: "absolute", left: 8, top: 8 }}>视频层加载/播放失败：{layerId}（{error.message}）</span>}
  </>;
}
