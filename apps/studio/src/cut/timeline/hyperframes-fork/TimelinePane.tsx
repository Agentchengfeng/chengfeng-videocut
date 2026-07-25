/**
 * Product-owned presentation fork of HyperFrames Studio 0.7.60
 * `nle/TimelinePane.tsx`.
 *
 * HyperFrames NLEContext, TimelineEditContext, Store and nested-composition
 * rebasing are removed. The source pane/divider/overlay DOM and geometry stay
 * intact; Product supplies its own timeline and all behavior through slots.
 */
import type {
  Dispatch,
  MouseEvent,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import { TimelineResizeDivider } from "./TimelineResizeDivider";

export interface TimelinePaneProps {
  timelineH: number;
  setTimelineH: Dispatch<SetStateAction<number>>;
  persistTimelineH: (height: number) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  timelineToolbar?: ReactNode;
  timelineFooter?: ReactNode;
  children: ReactNode;
  loadingLabel?: string;
  onPaneDoubleClick?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function TimelinePane({
  timelineH,
  setTimelineH,
  persistTimelineH,
  containerRef,
  disabled = false,
  timelineToolbar,
  timelineFooter,
  children,
  loadingLabel = "Loading composition…",
  onPaneDoubleClick,
}: TimelinePaneProps) {
  return (
    <>
      <TimelineResizeDivider
        timelineH={timelineH}
        setTimelineH={setTimelineH}
        persistTimelineH={persistTimelineH}
        containerRef={containerRef}
        disabled={disabled}
      />

      <div
        className="relative flex flex-shrink-0 flex-col px-px pb-px"
        style={{ height: timelineH }}
        aria-disabled={disabled || undefined}
        data-hyperframes-timeline-fork="pane"
      >
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800/50 bg-neutral-950"
          onDoubleClick={onPaneDoubleClick}
        >
          <div className="flex-shrink-0">{timelineToolbar}</div>
          {children}
        </div>

        {timelineFooter && <div className="flex-shrink-0">{timelineFooter}</div>}

        {disabled && (
          <div
            className="absolute inset-0 z-30 flex cursor-not-allowed items-center justify-center bg-black/18"
            data-testid="timeline-loading-disabled-overlay"
            role="status"
            onPointerDown={(event) => event.preventDefault()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
          >
            <span className="rounded-md bg-neutral-900/90 px-2.5 py-1 text-[11px] text-neutral-400">
              {loadingLabel}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
