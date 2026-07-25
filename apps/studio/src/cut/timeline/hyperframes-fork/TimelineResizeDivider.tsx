/**
 * Product-owned presentation fork of HyperFrames Studio 0.7.60
 * `nle/TimelineResizeDivider.tsx`.
 *
 * Only state ownership changed: height and persistence are controlled props.
 */
import {
  useCallback,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";

export const MIN_TIMELINE_H = 100;
export const MIN_PREVIEW_H = 120;

export interface TimelineResizeDividerProps {
  timelineH: number;
  setTimelineH: Dispatch<SetStateAction<number>>;
  persistTimelineH: (height: number) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
}

export function TimelineResizeDivider({
  timelineH,
  setTimelineH,
  persistTimelineH,
  containerRef,
  disabled = false,
}: TimelineResizeDividerProps) {
  const isDragging = useRef(false);
  const timelineHRef = useRef(timelineH);
  timelineHRef.current = timelineH;

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      isDragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [disabled],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled || !isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mouseY = event.clientY - rect.top;
      const nextHeight = Math.max(
        MIN_TIMELINE_H,
        Math.min(rect.height - MIN_PREVIEW_H, rect.height - mouseY),
      );
      setTimelineH(nextHeight);
    },
    [containerRef, disabled, setTimelineH],
  );

  const handlePointerUp = useCallback(() => {
    if (isDragging.current) persistTimelineH(timelineHRef.current);
    isDragging.current = false;
  }, [persistTimelineH]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
        return;
      }
      event.preventDefault();
      const containerHeight =
        containerRef.current?.getBoundingClientRect().height ?? Infinity;
      const delta = event.key === "ArrowUp" ? 16 : -16;
      setTimelineH((currentHeight) => {
        const nextHeight = Math.max(
          MIN_TIMELINE_H,
          Math.min(containerHeight - MIN_PREVIEW_H, currentHeight + delta),
        );
        persistTimelineH(nextHeight);
        return nextHeight;
      });
    },
    [containerRef, disabled, persistTimelineH, setTimelineH],
  );

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline (arrow keys)"
      aria-valuenow={Math.round(timelineH)}
      aria-valuemin={MIN_TIMELINE_H}
      aria-valuemax={Math.round(
        (containerRef.current?.getBoundingClientRect().height ?? 600) -
          MIN_PREVIEW_H,
      )}
      tabIndex={0}
      className="group relative z-10 h-[3px] flex-shrink-0 cursor-row-resize outline-none focus-visible:bg-studio-accent/20"
      style={{ touchAction: "none" }}
      data-hyperframes-timeline-fork="resize-divider"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-x-0 -top-[2.5px] h-2" />
      <div className="h-[3px] w-full bg-transparent transition-colors group-hover:bg-white/12 group-active:bg-white/18 group-focus-visible:bg-studio-accent/60" />
    </div>
  );
}
