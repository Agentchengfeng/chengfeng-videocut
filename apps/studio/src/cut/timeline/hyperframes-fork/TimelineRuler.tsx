import { memo } from "react";
import type { TimelineTheme } from "./timelineTheme";
import { GUTTER, RULER_H, TRACKS_LEFT_PAD, formatTimelineTickLabel } from "./timelineLayout";

/**
 * Forked from HyperFrames Studio 0.7.60 TimelineRuler.tsx.
 * Product reduction removes beat and frame-store inputs while preserving the
 * source DOM, sticky layers, tick centering and theme.
 */

interface TimelineRulerProps {
  major: number[];
  minor: number[];
  pps: number;
  trackContentWidth: number;
  totalH: number;
  rulerDuration: number;
  majorTickInterval: number;
  theme: TimelineTheme;
}

export const TimelineRuler = memo(function TimelineRuler({
  major,
  minor,
  pps,
  trackContentWidth,
  totalH,
  rulerDuration,
  majorTickInterval,
  theme,
}: TimelineRulerProps) {
  return (
    <>
      {/* Ruler — sticky so the timestamps stay visible while the tracks scroll
          vertically. Opaque background (plus the gutter corner block) so clips
          scrolling underneath don't bleed through; z-index sits above the track
          rows and drag overlays but below the playhead (z 100). */}
      <div
        className="sticky top-0 flex"
        style={{
          height: RULER_H,
          width: GUTTER + TRACKS_LEFT_PAD + trackContentWidth,
          zIndex: 70,
        }}
      >
        <div
          className="sticky left-0 z-[12] flex-shrink-0"
          style={{
            width: GUTTER,
            // Ruler corner uses the panel surface — same as the ruler strip
            // itself, and NO right border: the ruler band stays completely
            // clean until 00:00 (the header-boundary line belongs to the track
            // rows below, not the ruler).
            background: theme.shellBackground,
          }}
        />
        {/* Left breathing pad — scrolls with the content, so 00:00 starts a
            beat right of the gutter (see TRACKS_LEFT_PAD). */}
        <div
          aria-hidden="true"
          className="flex-shrink-0"
          style={{ width: TRACKS_LEFT_PAD, background: theme.shellBackground }}
        />
        <div
          className="relative overflow-hidden"
          style={{
            height: RULER_H,
            width: trackContentWidth,
            // Ruler background = panel surface (#0A0A0B) — no bottom border,
            // no tick lines (CapCut-style clean ruler, labels only).
            background: theme.shellBackground,
          }}
        >
          {/* Each 1px tick line is shifted -0.5px so its CENTER sits exactly on
              t * pps — matching the playhead line, which is also centered on
              GUTTER + t * pps (see getTimelinePlayheadLeft). Without the shift
              a tick spans [x, x+1) and its center is half a pixel right. */}
          {minor.map((t) => (
            <div key={`m-${t}`} className="absolute bottom-0" style={{ left: t * pps - 0.5 }}>
              <div className="w-px h-2" style={{ background: theme.tickMinor }} />
            </div>
          ))}

          {major.map((t) => (
            <div key={`M-${t}`} className="absolute top-0" style={{ left: t * pps - 0.5 }}>
              <span
                className="absolute font-mono tabular-nums leading-none whitespace-nowrap"
                style={{
                  color: theme.tickText,
                  left: 5,
                  top: 5,
                  fontSize: 10,
                }}
              >
                {formatTimelineTickLabel(t, rulerDuration, majorTickInterval)}
              </span>
              <div className="w-px" style={{ height: RULER_H, background: theme.tickMajor }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
});
