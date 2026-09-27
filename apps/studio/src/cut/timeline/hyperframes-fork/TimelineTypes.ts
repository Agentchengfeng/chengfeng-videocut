import type {
  MouseEvent,
  PointerEvent,
  ReactNode,
  RefObject,
} from "react";
import type { TimelineTheme } from "./timelineTheme";

/**
 * Product projection consumed by the Product-owned HyperFrames Timeline fork.
 *
 * The shape deliberately contains presentation data only. EditList documents,
 * media ownership, playback clocks and persistence stay above this boundary.
 */
export interface TimelineSegmentView {
  id: string;
  index: number;
  start: number;
  duration: number;
  label: string;
  audioLabel: string;
  title: string;
  titleOverride?: string;
  selected: boolean;
  hovered: boolean;
  dragging: boolean;
  trimming: boolean;
  active: boolean;
  videoContent: ReactNode;
  audioContent: ReactNode;
}

/**
 * One HTML layer drawn over the footage, as the timeline shows it.
 *
 * It is not an edit-list segment and deliberately carries none of a segment's
 * affordances: a layer is not trimmed or moved on this lane, it is placed by
 * naming the sentences it covers. The lane exists so a person can see where the
 * layers are against the speech, which is the thing that was invisible before.
 */
export interface TimelineVisualLayerView {
  id: string;
  label: string;
  start: number;
  duration: number;
}

/**
 * A clip inserted into the magnetic main track, shown on its own video and
 * audio rows above the narration. Read-only here: it is placed by the word it
 * follows, so clicking only moves the playhead to it.
 */
export interface TimelineInsertClipView {
  id: string;
  label: string;
  start: number;
  duration: number;
  active: boolean;
  /** Only sound (a re-recorded line): no block on the video row. */
  soundOnly?: boolean;
}

export interface TimelineLaneBaseProps {
  segments: readonly TimelineSegmentView[];
  /** Absent until a project has any. An empty lane still renders, so the row
      does not appear and disappear as layers come and go. */
  visualLayers?: readonly TimelineVisualLayerView[];
  /** Travels separately from the list so the list survives a playhead tick. */
  activeVisualLayerId?: string | null;
  onVisualLayerClick?: (layerId: string) => void;
  insertClips?: readonly TimelineInsertClipView[];
  onInsertClipClick?: (clipId: string) => void;
  pixelsPerSecond: number;
  displayContentWidth: number;
  trackRef: RefObject<HTMLDivElement | null>;
  theme: TimelineTheme;
  disabled?: boolean;
  onSegmentHover: (segmentId: string | null) => void;
  onSegmentPointerDown: (
    event: PointerEvent<HTMLDivElement>,
    segmentId: string,
  ) => void;
  onSegmentClick: (event: MouseEvent<HTMLDivElement>, segmentId: string) => void;
  onSegmentFocus: (segmentId: string) => void;
  onSegmentResizeStart: (
    edge: "start" | "end",
    event: PointerEvent<HTMLDivElement>,
    segmentId: string,
  ) => void;
}

/** A seam that is still audible after automatic refinement: worth a listen. */
export interface TimelineSeamMarker {
  time: number;
  level: number;
}

export interface TimelineCanvasProps extends Omit<TimelineLaneBaseProps, "theme"> {
  seamMarkers?: readonly TimelineSeamMarker[];
  onSeamMarkerClick?: (time: number) => void;
  soundEffectsTrack?: ReactNode;
  /** Canonical EDL duration shown by ruler labels and assistive text. */
  rulerDuration: number;
  currentTime: number;
  isScrubbing?: boolean;
  majorTicks: number[];
  minorTicks: number[];
  majorTickInterval: number;
  theme?: TimelineTheme;
  snapGuideTime?: number | null;
  onCanvasPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}
