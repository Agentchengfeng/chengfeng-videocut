import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EditListSegment } from "@video-workbench/core";
import {
  normalizeTimelineWaveform,
  requestTimelineWaveformPeaks,
  resampleTimelineWaveform,
  TimelineWaveformRequestError,
  waveformSvgPath,
} from "./timelineMedia";

export interface CutAudioWaveformProps {
  projectId: string;
  segment: EditListSegment;
  segmentWidth: number;
  sourceDuration: number;
}

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  pointerEvents: "none",
  color: "rgba(74, 206, 174, 0.78)",
  background: "rgba(39, 174, 139, 0.06)",
};

/** Decorative real-source waveform for one linked A/V EDL segment. */
export const CutAudioWaveform = memo(function CutAudioWaveform({
  projectId,
  segment,
  segmentWidth,
  sourceDuration,
}: CutAudioWaveformProps) {
  const [peaks, setPeaks] = useState<readonly number[] | null>(null);
  const [failure, setFailure] = useState<"no-audio" | "unavailable" | null>(null);

  useEffect(() => {
    let stale = false;
    setPeaks(null);
    setFailure(null);
    void requestTimelineWaveformPeaks(projectId, segment.source).then(
      (nextPeaks) => {
        if (!stale) setPeaks(nextPeaks);
      },
      (error) => {
        if (!stale) {
          setFailure(
            error instanceof TimelineWaveformRequestError && error.code === "no_audio"
              ? "no-audio"
              : "unavailable",
          );
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [projectId, segment.source]);

  const sampledPeaks = useMemo(() => peaks
    ? normalizeTimelineWaveform(resampleTimelineWaveform({
        peaks,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        sourceDuration,
        pixelWidth: segmentWidth,
      }))
    : [], [peaks, segment.sourceEnd, segment.sourceStart, segmentWidth, sourceDuration]);
  const path = useMemo(
    () => waveformSvgPath(sampledPeaks, segmentWidth),
    [sampledPeaks, segmentWidth],
  );
  const unavailable = failure === "unavailable" || (peaks !== null && path.length === 0);
  const noAudio = failure === "no-audio";

  return (
    <div
      className="cf-cut-audio-waveform"
      aria-hidden="true"
      data-media-state={noAudio ? "no-audio" : unavailable ? "unavailable" : path ? "ready" : "loading"}
      style={rootStyle}
    >
      {path ? (
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${Math.max(1, segmentWidth)} 28`}
          preserveAspectRatio="none"
          focusable="false"
          style={{ display: "block" }}
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : noAudio || unavailable ? (
        <span
          style={{
            color: "rgba(221, 229, 226, 0.52)",
            fontSize: 9,
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {noAudio ? "无原声" : "波形不可用"}
        </span>
      ) : null}
    </div>
  );
});
