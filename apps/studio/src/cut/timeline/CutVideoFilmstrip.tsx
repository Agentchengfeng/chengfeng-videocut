import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { EditListSegment } from "@video-workbench/core";
import {
  buildTimelineFrameUrl,
  requestTimelineFrameBlob,
  timelineFrameCount,
  timelineFrameTimes,
} from "./timelineMedia";

export interface CutVideoFilmstripProps {
  projectId: string;
  segment: EditListSegment;
  segmentWidth: number;
  sourceDuration: number;
  visibilityRoot?: Element | null;
}

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  overflow: "hidden",
  pointerEvents: "none",
  background: "rgba(255, 255, 255, 0.025)",
};

/** Decorative, server-backed filmstrip for one linked A/V EDL segment. */
export const CutVideoFilmstrip = memo(function CutVideoFilmstrip({
  projectId,
  segment,
  segmentWidth,
  sourceDuration,
  visibilityRoot,
}: CutVideoFilmstripProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [frameUrls, setFrameUrls] = useState<Array<string | null>>([]);
  const [failed, setFailed] = useState(false);
  const frameCount = timelineFrameCount(segmentWidth);
  const requestUrls = useMemo(() => {
    if (frameCount === 0) return [];
    const requestWidth = Math.min(
      480,
      Math.max(96, Math.ceil(segmentWidth / frameCount) * 2),
    );
    return timelineFrameTimes(segment, sourceDuration, frameCount).map((time) =>
      buildTimelineFrameUrl({
        projectId,
        source: segment.source,
        time,
        width: requestWidth,
      })
    );
  }, [
    frameCount,
    projectId,
    segment.source,
    segment.sourceEnd,
    segment.sourceStart,
    segmentWidth,
    sourceDuration,
  ]);
  const requestKey = requestUrls.join("\u0000");

  useEffect(() => {
    const node = rootRef.current;
    if (!node || frameCount === 0) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    setVisible(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { root: visibilityRoot ?? null, rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [frameCount, requestKey, visibilityRoot]);

  useEffect(() => {
    setFrameUrls([]);
    setFailed(false);
    if (!visible || requestUrls.length === 0) return;

    let stale = false;
    const ownedObjectUrls: string[] = [];
    void Promise.allSettled(requestUrls.map(requestTimelineFrameBlob)).then((results) => {
      if (stale) return;
      const nextUrls = results.map((result) => {
        if (result.status !== "fulfilled") return null;
        const url = URL.createObjectURL(result.value);
        ownedObjectUrls.push(url);
        return url;
      });
      if (stale) {
        for (const url of ownedObjectUrls) URL.revokeObjectURL(url);
        return;
      }
      setFrameUrls(nextUrls);
      setFailed(!nextUrls.some(Boolean));
    });

    return () => {
      stale = true;
      for (const url of ownedObjectUrls) URL.revokeObjectURL(url);
    };
  }, [requestKey, requestUrls, visible]);

  const state = frameCount === 0
    ? "suppressed"
    : failed
      ? "unavailable"
      : frameUrls.some(Boolean)
        ? "ready"
        : visible
          ? "loading"
          : "deferred";

  return (
    <div
      ref={rootRef}
      className="cf-cut-video-filmstrip"
      aria-hidden="true"
      data-media-state={state}
      style={rootStyle}
    >
      {frameUrls.map((url, index) => url ? (
        <img
          key={`${requestUrls[index]}-${url}`}
          data-frame-slot={index}
          src={url}
          alt=""
          draggable={false}
          style={{
            display: "block",
            width: `${100 / frameUrls.length}%`,
            height: "100%",
            flex: "0 0 auto",
            objectFit: "cover",
            opacity: 0.82,
            borderLeft: index === 0 ? "none" : "1px solid rgba(0,0,0,0.34)",
          }}
        />
      ) : (
        <span
          key={`${requestUrls[index]}-unavailable`}
          className="cf-cut-video-filmstrip__placeholder"
          data-frame-slot={index}
          data-frame-state="unavailable"
          style={{
            position: "relative",
            display: "block",
            width: `${100 / frameUrls.length}%`,
            height: "100%",
            flex: "0 0 auto",
            borderLeft: index === 0 ? "none" : "1px solid rgba(0,0,0,0.34)",
          }}
        />
      ))}
    </div>
  );
});
