import { useEffect, useRef, type CSSProperties } from "react";
import type { VisualZoom } from "@video-workbench/core";
import { useContainedPicture } from "../useContainedPicture";

/** One subtitle screen this layer covers, timed against the layer's own zero. */
export interface VisualCue {
  text: string;
  start: number;
  end: number;
}

export interface ActiveVisual {
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
  visual: ActiveVisual | null;
  /** Current position on the cut timeline, in seconds. */
  timelineTime: number;
}

/** What the player sends into a module. Namespaced so a page can ignore it. */
export const VISUAL_SEEK_MESSAGE = "videocut:seek" as const;

/**
 * A visual layer, on the video.
 *
 * The module is loaded in a frame sized to the picture — the same measurement
 * the subtitles use, so both land in one coordinate space and an export can
 * reproduce what the preview showed.
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
/**
 * The transform that fills the picture with a region of it.
 *
 * Contain semantics: the region is scaled until it touches the frame on its
 * longer side and centred, so nothing the author asked for is cropped away.
 * Returned as translate+scale from origin 0,0 — the one form where the export
 * can reproduce it as a crop+scale with no further geometry.
 */
function zoomTransform(zoom: VisualZoom, width: number, height: number): string {
  const rx = (zoom.x / 100) * width;
  const ry = (zoom.y / 100) * height;
  const rw = (zoom.width / 100) * width;
  const rh = (zoom.height / 100) * height;
  const scale = Math.min(width / rw, height / rh);
  const tx = width / 2 - scale * (rx + rw / 2);
  const ty = height / 2 - scale * (ry + rh / 2);
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

export function VisualOverlay({ visual, timelineTime }: VisualOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const picture = useContainedPicture(hostRef);
  const readyRef = useRef(false);

  // The zoom is applied to the video element imperatively: the element belongs
  // to the player, not to this overlay, so a declarative binding has no owner
  // here. The overlay itself gets the same transform in its style below, which
  // is what keeps a module's coordinates true on a pushed-in picture. The
  // subtitle overlay is a sibling and stays untransformed on purpose — captions
  // sit on the output frame, not on the footage.
  useEffect(() => {
    const video = hostRef.current?.closest(".cf-cut-player-stage")?.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) return;
    const zoom = visual?.zoom;
    if (!zoom || !picture) {
      video.style.transform = "";
      return;
    }
    // The picture is centred in the element box; letterbox offsets shift the
    // origin, and the same push-in has to move the same pixels in both frames.
    const rect = video.getBoundingClientRect();
    const ox = (rect.width - picture.width) / 2;
    const oy = (rect.height - picture.height) / 2;
    const rx = ox + (zoom.x / 100) * picture.width;
    const ry = oy + (zoom.y / 100) * picture.height;
    const rw = (zoom.width / 100) * picture.width;
    const rh = (zoom.height / 100) * picture.height;
    const scale = Math.min(picture.width / rw, picture.height / rh);
    const tx = rect.width / 2 - scale * (rx + rw / 2);
    const ty = rect.height / 2 - scale * (ry + rh / 2);
    video.style.transformOrigin = "0 0";
    video.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    return () => {
      video.style.transform = "";
    };
  }, [visual?.zoom, picture]);

  // A module can only be addressed once its document exists. Until then the
  // messages would land nowhere and the module would open at zero while the
  // film is at forty seconds.
  useEffect(() => {
    readyRef.current = false;
  }, [visual?.src]);

  useEffect(() => {
    if (!visual) return;
    const frame = frameRef.current;
    const target = frame?.contentWindow;
    if (!target) return;
    const localTime = Math.max(0, timelineTime - visual.start);
    if (!readyRef.current) return;
    target.postMessage(
      { type: VISUAL_SEEK_MESSAGE, time: localTime, duration: visual.duration, cues: visual.cues },
      "*",
    );
  }, [visual, timelineTime]);

  const onLoad = () => {
    readyRef.current = true;
    const target = frameRef.current?.contentWindow;
    if (!target || !visual) return;
    target.postMessage(
      {
        type: VISUAL_SEEK_MESSAGE,
        time: Math.max(0, timelineTime - visual.start),
        duration: visual.duration,
        cues: visual.cues,
      },
      "*",
    );
  };

  return (
    <div
      ref={hostRef}
      className="cf-cut-visual-overlay"
      style={{
        ...(picture ? { width: `${picture.width}px`, height: `${picture.height}px` } : {}),
        ...(picture && visual?.zoom
          ? {
            transformOrigin: "0 0",
            transform: zoomTransform(visual.zoom, picture.width, picture.height),
          }
          : {}),
      } as CSSProperties}
      aria-hidden="true"
    >
      {visual && (
        <iframe
          ref={frameRef}
          // Remounting per layer is deliberate: a module carries its own
          // timeline state, and reusing one frame for the next layer would show
          // the previous module's last frame until the new one painted.
          key={visual.layerId}
          className="cf-cut-visual-overlay__frame"
          src={visual.src}
          onLoad={onLoad}
          title="画面"
          // The module is project content authored by an Agent, not a document
          // the person is browsing. It gets scripts — it is an animation — and
          // nothing else.
          sandbox="allow-scripts"
          scrolling="no"
        />
      )}
    </div>
  );
}
