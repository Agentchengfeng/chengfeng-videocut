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
  selected: boolean;
  hovered: boolean;
  dragging: boolean;
  trimming: boolean;
  active: boolean;
  videoContent: ReactNode;
  audioContent: ReactNode;
}

export interface TimelineLaneBaseProps {
  segments: readonly TimelineSegmentView[];
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

export interface TimelineCanvasProps extends Omit<TimelineLaneBaseProps, "theme"> {
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
