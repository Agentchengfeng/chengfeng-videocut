import type { TimelineLaneBaseProps } from "./TimelineTypes";
import { TimelineClip } from "./TimelineClip";
import { CLIP_Y, GUTTER, TRACK_H, TRACKS_LEFT_PAD } from "./timelineLayout";
import type { ForkTimelineElement } from "./timelineTheme";

/**
 * Product-owned reduction of HyperFrames Studio 0.7.60 TimelineLanes.
 *
 * Upstream's lane / gutter / left-pad / clip DOM is preserved. The removed
 * branches are the ones that require a second owner: arbitrary tracks, track
 * visibility, beats, keyframes, asset drop and HyperFrames Player Store drag
 * sessions. The two rows below are projections of one linked Product segment.
 */
function TrackIcon({ kind }: { kind: "video" | "audio" }) {
  return kind === "video" ? (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" />
      <path d="m7 6 3 2-3 2Z" fill="currentColor" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8h1.5l1-3 1.5 6 1.5-8 1.5 10 1.5-7 1.2 4H14" stroke="currentColor" />
    </svg>
  );
}

function TimelineLane({
  kind,
  segments,
  pixelsPerSecond,
  displayContentWidth,
  trackRef,
  theme,
  disabled,
  onSegmentHover,
  onSegmentPointerDown,
  onSegmentClick,
  onSegmentFocus,
  onSegmentResizeStart,
}: TimelineLaneBaseProps & { kind: "video" | "audio" }) {
  const isVideo = kind === "video";

  return (
    <div
      className="relative flex"
      style={{ height: TRACK_H }}
      data-hyperframes-timeline-lane={kind}
    >
      <div
        className="sticky left-0 z-[12] flex flex-shrink-0 flex-col items-center justify-center gap-0.5"
        style={{
          width: GUTTER,
          background: theme.gutterBackground,
          borderRight: `1px solid ${theme.gutterBorder}`,
          borderBottom: `1px solid ${theme.rowBorder}`,
          color: "rgba(255,255,255,0.35)",
        }}
        aria-label={isVideo ? "视频轨" : "原声轨"}
        title={isVideo ? "视频轨" : "原声轨"}
      >
        <TrackIcon kind={kind} />
      </div>

      <div
        aria-hidden="true"
        className="flex-shrink-0"
        style={{
          width: TRACKS_LEFT_PAD,
          background: theme.rowBackground,
          borderBottom: `1px solid ${theme.rowBorder}`,
        }}
      />

      <div
        ref={isVideo ? trackRef : undefined}
        className={`cf-cut-track relative flex-shrink-0 ${isVideo ? "is-video" : "is-audio"}`}
        style={{
          width: displayContentWidth,
          height: TRACK_H,
          background: theme.rowBackground,
          borderBottom: `1px solid ${theme.rowBorder}`,
        }}
        role={isVideo ? "listbox" : undefined}
        aria-orientation={isVideo ? "horizontal" : undefined}
        aria-label={isVideo ? "音画绑定片段" : undefined}
        aria-hidden={isVideo ? undefined : true}
      >
        {segments.map((segment) => {
          const exactWidth = segment.duration * pixelsPerSecond;
          const visualWidth = Math.max(exactWidth, 4);
          const element: ForkTimelineElement = {
            id: `${kind}:${segment.id}`,
            key: `${kind}:${segment.id}`,
            tag: kind,
            label: isVideo ? segment.label : segment.audioLabel,
            start: 0,
            duration: segment.duration,
            track: isVideo ? 0 : 1,
            kind,
          };
          const showHandles = isVideo &&
            (segment.hovered || segment.selected || segment.trimming) &&
            (exactWidth >= 32 || segment.selected || segment.trimming);

          return (
            <div
              key={`${kind}:${segment.id}`}
              className={`cf-cut-linked-clip cf-cut-linked-clip--${kind}`}
              data-edl-segment-id={isVideo ? segment.id : undefined}
              data-linked-segment-id={isVideo ? undefined : segment.id}
              data-av-linked="true"
              data-segment-index={segment.index}
              data-track-lane={kind}
              data-logical-left={segment.start * pixelsPerSecond}
              data-logical-width={exactWidth}
              data-trim-handles={isVideo ? (showHandles ? "visible" : "hidden") : undefined}
              role={isVideo ? "option" : undefined}
              aria-selected={isVideo ? segment.selected : undefined}
              aria-label={
                isVideo
                  ? `口播片段 ${segment.index + 1}，视频与原声联动`
                  : undefined
              }
              tabIndex={isVideo ? 0 : undefined}
              title={segment.title}
              style={{
                position: "absolute",
                left: segment.start * pixelsPerSecond,
                top: 0,
                width: visualWidth,
                minWidth: 4,
                height: TRACK_H,
                borderInlineWidth: 0,
                overflow: "visible",
                pointerEvents: disabled ? "none" : undefined,
              }}
              onPointerEnter={() => onSegmentHover(segment.id)}
              onPointerLeave={() => onSegmentHover(null)}
              onPointerDown={(event) => onSegmentPointerDown(event, segment.id)}
              onClick={(event) => onSegmentClick(event, segment.id)}
              onFocus={isVideo ? () => onSegmentFocus(segment.id) : undefined}
            >
              <TimelineClip
                el={element}
                pps={pixelsPerSecond}
                clipY={CLIP_Y}
                isSelected={segment.selected}
                isHovered={segment.hovered}
                isDragging={segment.dragging}
                isActive={segment.active}
                hasCustomContent
                capabilities={{
                  canTrimStart: isVideo && showHandles,
                  canTrimEnd: isVideo && showHandles,
                }}
                theme={theme}
                isComposition={false}
                ariaHidden={!isVideo}
                tabIndex={-1}
                onHoverStart={() => {}}
                onHoverEnd={() => {}}
                onResizeStart={(edge, event) =>
                  onSegmentResizeStart(edge, event, segment.id)
                }
                onClick={() => {}}
                onDoubleClick={() => {}}
              >
                <div
                  className="absolute inset-0 overflow-hidden"
                  data-product-clip-content={kind}
                  style={{
                    borderRadius: "inherit",
                    background: isVideo
                      ? "linear-gradient(135deg, rgba(42,89,94,0.34), rgba(22,27,36,0.72))"
                      : undefined,
                  }}
                >
                  {isVideo ? segment.videoContent : segment.audioContent}
                </div>
              </TimelineClip>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TimelineLanes(props: TimelineLaneBaseProps) {
  return (
    <>
      <TimelineLane kind="video" {...props} />
      <TimelineLane kind="audio" {...props} />
    </>
  );
}
