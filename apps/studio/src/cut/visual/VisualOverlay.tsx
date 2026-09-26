import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isVisualTimeActive } from "@video-workbench/core";
import type { VisualZoom, VisualMedia, ResolvedVisualAnimation } from "@video-workbench/core";
import { VideoVisual } from "./VideoVisual";
import { useContainedPicture } from "../useContainedPicture";

/** One subtitle screen this layer covers, timed against the layer's own zero. */
export interface VisualCue {
  text: string;
  start: number;
  end: number;
}

export interface ActiveVisual {
  animation?: ResolvedVisualAnimation;
  media?: VisualMedia;
  layerId: string;
  /** Where the preview fetches the module's HTML. */
  src: string;
  /** When this layer starts, on the cut timeline. The module's own zero. */
  start: number;
  /** How long the layer is on screen. */
  duration: number;
  /** Push the footage in on this region while the layer is up. */
  zoom?: VisualZoom;
  /**
   * What is being said while this layer is up, already timed against the
   * layer's zero.
   *
   * This is what makes a module an explanation rather than a decoration: its
   * steps land on the words that motivate them — the arrow is drawn when the
   * speaker says 「调用」, not four seconds in because four seconds looked
   * right. And because these times are recomputed from the cut on every read,
   * a module written against them stays aligned when the cut changes.
   */
  cues: VisualCue[];
}

export interface VisualOverlayProps {
  /** Every layer of the project, resolved and stable across playback. */
  layers: readonly ActiveVisual[];
  /** Which one is on screen, or null between layers. */
  activeLayerId: string | null;
  /** Current position on the cut timeline, in seconds. */
  timelineTime: number;
  fallbackAspect?: number | null;
}

/** What the player sends into a module. Namespaced so a page can ignore it. */
export const VISUAL_SEEK_MESSAGE = "videocut:seek" as const;

/** Same later-layer-wins rule as the timeline; read the narration clock. */
export function visualWinner(layers: readonly ActiveVisual[], time: number) {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    if (isVisualTimeActive(time, layer.start, layer.start + layer.duration)) return layer;
  }
  return null;
}

export function mediaWindow(layers: readonly ActiveVisual[], time: number): string[] {
  const winner = visualWinner(layers, time);
  const next = layers.filter(layer => layer.media && layer.start > time)
    .sort((a, b) => a.start - b.start)[0];
  return [winner?.media ? winner.layerId : null, next?.layerId]
    .filter((id): id is string => !!id);
}

/**
 * A visual layer, on the video.
 *
 * The module is loaded in a frame sized to the picture — the same measurement
 * the subtitles use, so both land in one coordinate space and an export can
 * reproduce what the preview showed.
 *
 * The frame is never CSS-transformed, on a lesson: a sandboxed iframe under a
 * scale transform composites as an opaque white sheet in Chromium, which blanked
 * every pushed-in layer. The push-in reaches the module as data instead — the
 * zoom rect rides the seek message, and the module points its SVG viewBox at
 * that region, which lands its drawing on the zoomed picture exactly.
 *
 * **The module is driven, not played.** Every time the playhead moves the frame
 * is told the current moment and renders exactly that instant. It never runs on
 * its own clock. Two things fall out of that, and both are the point:
 *
 * ```text
 * 拖进度条    the module lands on the same frame the video does, not somewhere
 *            behind it — a module playing on its own would drift the moment
 *            anyone scrubbed, paused, or changed speed
 * 导出        the renderer can ask for any instant and get one deterministic
 *            answer, which is the only way a frame-by-frame export can work
 * ```
 *
 * The time sent is relative to the layer's own start, so a module knows nothing
 * about where it sits in the film. Move the layer and it still plays correctly.
 *
 * It never intercepts a click: the video underneath is the play/pause target.
 */
export function VisualOverlay({ layers, activeLayerId, timelineTime, fallbackAspect = null }: VisualOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const readyIds = useRef(new Set<string>());
  const seekSequence = useRef(0);
  const [seekErrors, setSeekErrors] = useState<Record<string, string>>({});
  const picture = useContainedPicture(hostRef, fallbackAspect);
  const canvas = useContainedPicture(hostRef, fallbackAspect, true);
  const active = layers.find((layer) => layer.layerId === activeLayerId) ?? null;
  const [mediaIds, setMediaIds] = useState(() => mediaWindow(layers, timelineTime));
  useEffect(() => {
    const master = hostRef.current?.closest(".cf-cut-player-stage")?.querySelector('video[data-koubo-media-owner="video"]');
    if (!(master instanceof HTMLVideoElement)) return;
    let raf = 0;
    const update = () => {
      const next = mediaWindow(layers, master.currentTime);
      setMediaIds(previous => previous.join("\0") === next.join("\0") ? previous : next);
    };
    const tick = () => { update(); raf = requestAnimationFrame(tick); };
    master.addEventListener("seeking", update);
    master.addEventListener("seeked", update);
    update(); raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); master.removeEventListener("seeking", update); master.removeEventListener("seeked", update); };
  }, [layers]);

  // HTML frames stay mounted; MP4 decoders belong only to the selected winner.
  // At most the current winner and nearest upcoming MP4 retain resources.
  // A frame mounted at the moment its layer begins spends ~a tenth of a second
  // fetching and parsing before it first paints — with hard cuts that gap
  // showed as a flash of raw footage at every boundary into an animation.
  // Eleven idle frames with paused timelines cost nothing measurable; a flash
  // at every cut cost the film its credibility.

  // The zoom is applied to the video element imperatively: the element belongs
  // to the player, not to this overlay. The subtitle overlay is a sibling and
  // stays untransformed on purpose — captions sit on the output frame, not on
  // the footage.
  useEffect(() => {
    const video = hostRef.current?.closest(".cf-cut-player-stage")?.querySelector('video[data-koubo-media-owner="video"]');
    if (!(video instanceof HTMLVideoElement)) return;
    const zoom = active?.zoom;
    if (!zoom || !picture) {
      video.style.transform = "";
      video.style.clipPath = "";
      return;
    }
    // offsetWidth/offsetHeight, not getBoundingClientRect: a rect measured
    // mid-transition was a box inflated 2.5x and every offset from it garbage.
    const ox = (video.offsetWidth - picture.width) / 2;
    const oy = (video.offsetHeight - picture.height) / 2;
    const rx = ox + (zoom.x / 100) * picture.width;
    const ry = oy + (zoom.y / 100) * picture.height;
    const rw = (zoom.width / 100) * picture.width;
    const rh = (zoom.height / 100) * picture.height;
    const scale = Math.min(picture.width / rw, picture.height / rh);
    const tx = video.offsetWidth / 2 - scale * (rx + rw / 2);
    const ty = video.offsetHeight / 2 - scale * (ry + rh / 2);
    video.style.transformOrigin = "0 0";
    video.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    // rx/ry are already element coordinates (the letterbox offset is inside
    // them). Adding ox/oy again shifted the clip by a whole letterbox — a bug
    // that hid on layouts whose letterbox happened to be zero and moved the
    // picture 65 source-pixels on everyone else's.
    video.style.clipPath = `inset(${ry.toFixed(2)}px ${(video.offsetWidth - (rx + rw)).toFixed(2)}px ${(video.offsetHeight - (ry + rh)).toFixed(2)}px ${rx.toFixed(2)}px)`;
    return () => {
      video.style.transform = "";
      video.style.clipPath = "";
    };
  }, [active?.zoom, picture]);

  // Visibility and messages share the MP4 winner from the narration clock.
  // The transport's React props can lag across a boundary; they must never
  // keep an old HTML frame above the current MP4 or animate a losing layer.
  useEffect(() => {
    const video = hostRef.current?.closest(".cf-cut-player-stage")?.querySelector('video[data-koubo-media-owner="video"]');
    if (!(video instanceof HTMLVideoElement)) return;
    let raf = 0;
    const pending = new Map<string, { token: number; sentAt: number }>();
    const failures = new Map<string, string>();
    setSeekErrors({});
    const fail = (id: string, message: string) => {
      failures.set(id, message); pending.delete(id);
      const frame = frameRefs.current.get(id); if (frame) frame.style.visibility = "hidden";
      setSeekErrors(Object.fromEntries(failures));
    };
    const acknowledged = (event: MessageEvent) => {
      const data = event.data;
      if (!data || (data.type !== "videocut:seek-applied" && data.type !== "videocut:seek-error")) return;
      for (const [id, request] of pending) {
        if (event.source !== frameRefs.current.get(id)?.contentWindow || data.token !== request.token) continue;
        if (data.type === "videocut:seek-error") fail(id, typeof data.message === "string" ? data.message.slice(0, 240) : "模块定位失败");
        else pending.delete(id);
        break;
      }
    };
    window.addEventListener("message", acknowledged);
    const sync = () => {
      for (const [id, request] of pending) if (performance.now() - request.sentAt > 5000) fail(id, "模块定位超时，未收到完成确认");
      const winner = visualWinner(layers, video.currentTime);
      for (const [id, frame] of frameRefs.current) {
        frame.style.visibility = id === winner?.layerId && !winner?.animation?.issues.length && !failures.has(id) ? "visible" : "hidden";
      }
      if (!winner || winner.media || winner.animation?.issues.length || failures.has(winner.layerId) || pending.has(winner.layerId)) return;
      const target = frameRefs.current.get(winner.layerId)?.contentWindow;
      if (target && readyIds.current.has(winner.layerId)) {
        const token = winner.animation ? ++seekSequence.current : undefined;
        if (token !== undefined) pending.set(winner.layerId, { token, sentAt: performance.now() });
        target.postMessage(
          {
            type: VISUAL_SEEK_MESSAGE,
            time: Math.max(0, video.currentTime - winner.start),
            duration: winner.duration,
            cues: winner.cues,
            zoom: winner.zoom ?? null,
            ...(winner.animation ? { animation: winner.animation, wordCues: winner.animation.wordCues } : {}),
            ...(token !== undefined ? { token } : {}),
          },
          "*",
        );
      }
    };
    const tick = () => { sync(); raf = requestAnimationFrame(tick); };
    video.addEventListener("seeking", sync);
    video.addEventListener("seeked", sync);
    sync(); raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("seeking", sync);
      video.removeEventListener("seeked", sync);
      window.removeEventListener("message", acknowledged);
    };
  }, [layers]);

  return (
    <div
      ref={hostRef}
      className="cf-cut-visual-overlay"
      style={canvas ? { width: `${canvas.width}px`, height: `${canvas.height}px` } : undefined}
    >
      {layers.map((layer) => (
        layer.media ? (mediaIds.includes(layer.layerId) ? <VideoVisual key={layer.layerId} layer={layer} layers={layers} /> : null) : <iframe
          key={layer.layerId}
          ref={(node) => {
            if (node) frameRefs.current.set(layer.layerId, node);
            else frameRefs.current.delete(layer.layerId);
          }}
          className="cf-cut-visual-overlay__frame"
          style={{ visibility: "hidden", ...(layer.animation?.canvas !== "project" && picture ? {
            width: `${picture.width}px`, height: `${picture.height}px`, left: "50%", top: "50%", transform: "translate(-50%, -50%)",
          } : {}) }}
          src={layer.src}
          onLoad={() => readyIds.current.add(layer.layerId)}
          title="画面"
          // Project content authored by an Agent: it gets scripts — it is an
          // animation — and nothing else.
          sandbox="allow-scripts"
          scrolling="no"
        />
      ))}
      {layers.filter(layer => layer.animation?.issues.length).map(layer => (
        <div key={`warning-${layer.layerId}`} role="status" style={{ position: "relative", zIndex: 10, background: "#30220a", color: "#ffe1a3", padding: "4px 8px" }}>
          动画 {layer.layerId} 待复核：{layer.animation!.issues.join(", ")}（未自动重排或变速）
        </div>
      ))}
      {Object.entries(seekErrors).map(([id, message]) => (
        <div key={`seek-error-${id}`} role="alert" style={{ position: "relative", zIndex: 10, background: "#30220a", color: "#ffe1a3", padding: "4px 8px" }}>
          动画 {id} 定位失败：{message}
        </div>
      ))}
    </div>
  );
}
