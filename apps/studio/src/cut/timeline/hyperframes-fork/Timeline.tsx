import type { RefObject } from "react";
import { TimelineCanvas } from "./TimelineCanvas";
import type { TimelineCanvasProps } from "./TimelineTypes";

export interface TimelineProps extends TimelineCanvasProps {
  scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * Product-owned fork of HyperFrames Studio 0.7.60 Timeline.
 *
 * Upstream state hooks are intentionally absent: the component is the official
 * scroll/canvas presentation boundary fed by Product props.
 */
export function Timeline({ scrollRef, ...canvasProps }: TimelineProps) {
  return (
    <div
      className="cf-cut-timeline-scroll min-h-0 flex-1 overflow-auto"
      ref={scrollRef}
      data-hyperframes-timeline-fork="timeline"
    >
      <TimelineCanvas {...canvasProps} />
    </div>
  );
}

