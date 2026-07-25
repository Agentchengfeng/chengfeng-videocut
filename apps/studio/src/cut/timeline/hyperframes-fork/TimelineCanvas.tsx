import { memo } from "react";
import { PlayheadIndicator } from "./PlayheadIndicator";
import { TimelineLanes } from "./TimelineLanes";
import { TimelineRuler } from "./TimelineRuler";
import type { TimelineCanvasProps } from "./TimelineTypes";
import {
  GUTTER,
  PLAYHEAD_HEAD_W,
  RULER_H,
  TRACK_H,
  TRACKS_BOTTOM_PAD,
  TRACKS_LEFT_PAD,
  TRACKS_TOP_PAD,
  getTimelineCanvasHeight,
  getTimelinePlayheadLeft,
} from "./timelineLayout";
import { defaultTimelineTheme } from "./timelineTheme";

/**
 * Product-owned fork of HyperFrames Studio 0.7.60 TimelineCanvas.
 * The official Ruler -> Lanes -> Playhead composition remains intact.
 */
export const TimelineCanvas = memo(function TimelineCanvas({
  segments,
  pixelsPerSecond,
  displayContentWidth,
  rulerDuration,
  currentTime,
  isScrubbing = false,
  majorTicks,
  minorTicks,
  majorTickInterval,
  trackRef,
  theme = defaultTimelineTheme,
  disabled = false,
  snapGuideTime = null,
  onCanvasPointerDown,
  onSegmentHover,
  onSegmentPointerDown,
  onSegmentClick,
  onSegmentFocus,
  onSegmentResizeStart,
}: TimelineCanvasProps) {
  const totalHeight = getTimelineCanvasHeight(2);

  return (
    <div
      className="relative"
      style={{
        height: totalHeight,
        width: GUTTER + TRACKS_LEFT_PAD + displayContentWidth,
      }}
      data-hyperframes-timeline-fork="canvas"
      data-pixels-per-second={pixelsPerSecond}
      data-ruler-height={RULER_H}
      data-top-padding={TRACKS_TOP_PAD}
      data-track-height={TRACK_H}
      data-bottom-padding={TRACKS_BOTTOM_PAD}
      data-gutter-width={GUTTER}
      data-left-padding={TRACKS_LEFT_PAD}
      onPointerDown={onCanvasPointerDown}
    >
      <TimelineRuler
        major={majorTicks}
        minor={minorTicks}
        pps={pixelsPerSecond}
        trackContentWidth={displayContentWidth}
        totalH={totalHeight}
        rulerDuration={rulerDuration}
        majorTickInterval={majorTickInterval}
        theme={theme}
      />

      <div aria-hidden="true" style={{ height: TRACKS_TOP_PAD }} />

      <TimelineLanes
        segments={segments}
        pixelsPerSecond={pixelsPerSecond}
        displayContentWidth={displayContentWidth}
        trackRef={trackRef}
        theme={theme}
        disabled={disabled}
        onSegmentHover={onSegmentHover}
        onSegmentPointerDown={onSegmentPointerDown}
        onSegmentClick={onSegmentClick}
        onSegmentFocus={onSegmentFocus}
        onSegmentResizeStart={onSegmentResizeStart}
      />

      <div aria-hidden="true" style={{ height: TRACKS_BOTTOM_PAD }} />

      {snapGuideTime !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute"
          data-hyperframes-timeline-snap-guide="true"
          style={{
            left: GUTTER + TRACKS_LEFT_PAD + snapGuideTime * pixelsPerSecond,
            top: RULER_H,
            bottom: 0,
            width: 1,
            background: "#3CE6AC",
            boxShadow: "0 0 6px rgba(60,230,172,0.5)",
            zIndex: 60,
          }}
        />
      )}

      <div
        className="pointer-events-none absolute top-0 bottom-0"
        style={{
          left: getTimelinePlayheadLeft(currentTime, pixelsPerSecond),
          width: PLAYHEAD_HEAD_W,
          zIndex: 100,
        }}
        aria-hidden="true"
        data-hyperframes-timeline-playhead="true"
        data-scrubbing={isScrubbing ? "true" : undefined}
      >
        <PlayheadIndicator scrubbing={isScrubbing} />
      </div>

      <span className="sr-only">
        时间线从 00:00 到 {Math.max(0, rulerDuration).toFixed(2)} 秒
      </span>
    </div>
  );
});
