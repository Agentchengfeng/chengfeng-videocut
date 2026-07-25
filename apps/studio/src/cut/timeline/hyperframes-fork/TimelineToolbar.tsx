/**
 * Product-owned presentation fork of HyperFrames Studio 0.7.60
 * `components/TimelineToolbar.tsx`.
 *
 * The source DOM, class names, hit areas and logarithmic zoom controls are
 * intentionally preserved. HyperFrames Store, keyframes, beat analysis,
 * snapping and razor-tool ownership are intentionally removed. Every action
 * below is supplied by the Product EditList controller through plain props.
 */
import {
  ArrowCounterClockwise,
  Magnet,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Trash,
} from "@phosphor-icons/react";
import { Tooltip } from "../../../components/ui/Tooltip";
import type { ZoomMode } from "./timelineLayout";
import {
  getNextTimelineZoomPercent,
  getTimelineZoomPercent,
  timelineSliderToZoomPercent,
  timelineZoomPercentToSlider,
} from "./timelineZoom";

export interface TimelineToolbarProps {
  selectionActive?: boolean;
  canUndo: boolean;
  onUndo: () => void;
  onSelectTool: () => void;
  snappingEnabled: boolean;
  onSnappingEnabledChange: (enabled: boolean) => void;
  canSplit: boolean;
  onSplit: () => void;
  canDelete: boolean;
  onDelete: () => void;
  zoomMode: ZoomMode;
  manualZoomPercent: number;
  onZoomModeChange: (mode: ZoomMode) => void;
  onManualZoomPercentChange: (percent: number) => void;
}

const FLAT_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md transition-colors";
const FLAT_IDLE = `${FLAT_BUTTON} text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200 active:scale-[0.98]`;
const FLAT_ACTIVE = `${FLAT_BUTTON} bg-white/[0.08] text-neutral-100 active:scale-[0.98]`;
const FLAT_DISABLED = `${FLAT_BUTTON} cursor-not-allowed text-neutral-700`;

export function TimelineToolbar({
  selectionActive = true,
  canUndo,
  onUndo,
  onSelectTool,
  snappingEnabled,
  onSnappingEnabledChange,
  canSplit,
  onSplit,
  canDelete,
  onDelete,
  zoomMode,
  manualZoomPercent,
  onZoomModeChange,
  onManualZoomPercentChange,
}: TimelineToolbarProps) {
  const displayedTimelineZoomPercent = getTimelineZoomPercent(
    zoomMode,
    manualZoomPercent,
  );

  const setManualZoom = (percent: number) => {
    onZoomModeChange("manual");
    onManualZoomPercentChange(percent);
  };

  return (
    <div
      className="border-b border-neutral-800/60"
      data-hyperframes-timeline-fork="toolbar"
    >
      <div className="flex items-center justify-between px-2 py-0.5">
        <div className="flex items-center gap-0.5">
          <Tooltip label={canUndo ? "撤销上一次编辑（⌘Z / Ctrl+Z）" : "没有可撤销的编辑"}>
            <button
              type="button"
              disabled={!canUndo}
              onClick={onUndo}
              aria-label="撤销上一次编辑"
              className={canUndo ? FLAT_IDLE : FLAT_DISABLED}
            >
              <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" />
            </button>
          </Tooltip>

          <div aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-800" />

          <Tooltip label="选择工具（V）">
            <button
              type="button"
              onClick={onSelectTool}
              aria-label="选择工具"
              aria-pressed={selectionActive}
              className={selectionActive ? FLAT_ACTIVE : FLAT_IDLE}
            >
              <svg width="16" height="16" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2 0.5L10 6L6.5 6.5L8.5 11L6.5 11.5L4.5 7L2 9Z" />
              </svg>
            </button>
          </Tooltip>

          <div aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-800" />

          <Tooltip label={snappingEnabled ? "吸附已开启（N）" : "吸附已关闭（N）"}>
            <button
              type="button"
              onClick={() => onSnappingEnabledChange(!snappingEnabled)}
              aria-label="切换时间线吸附"
              aria-pressed={snappingEnabled}
              className={snappingEnabled ? FLAT_ACTIVE : FLAT_IDLE}
            >
              <Magnet size={16} weight="bold" aria-hidden="true" />
            </button>
          </Tooltip>

          <Tooltip
            label={
              canSplit
                ? "在播放头拆分（S）"
                : "先选择片段并把播放头放到片段内部"
            }
          >
            <button
              type="button"
              disabled={!canSplit}
              aria-label="在播放头拆分"
              onClick={onSplit}
              className={canSplit ? FLAT_IDLE : FLAT_DISABLED}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 3 L7 3 L7 13 L5 13" />
                <path d="M11 3 L9 3 L9 13 L11 13" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip label={canDelete ? "删除所选片段" : "先选择要删除的片段"}>
            <button
              type="button"
              disabled={!canDelete}
              aria-label="删除片段"
              onClick={onDelete}
              className={canDelete ? FLAT_IDLE : FLAT_DISABLED}
            >
              <Trash size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip label="适应时间线宽度">
            <button
              type="button"
              aria-label="适应时间线宽度"
              onClick={() => onZoomModeChange("fit")}
              className={`cf-cut-fit-button h-7 rounded-md px-2 text-[11px] font-medium transition-colors ${
                zoomMode === "fit"
                  ? "bg-studio-accent/10 text-studio-accent"
                  : "text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200"
              }`}
            >
              Fit
            </button>
          </Tooltip>

          <Tooltip label="缩小时间线">
            <button
              type="button"
              aria-label="缩小时间线"
              onClick={() =>
                setManualZoom(
                  getNextTimelineZoomPercent("out", zoomMode, manualZoomPercent),
                )
              }
              className={FLAT_IDLE}
            >
              <MagnifyingGlassMinus size={16} aria-hidden="true" />
            </button>
          </Tooltip>

          <input
            type="range"
            min="0"
            max="100"
            value={timelineZoomPercentToSlider(displayedTimelineZoomPercent)}
            title={`${displayedTimelineZoomPercent}%`}
            aria-label="时间线缩放"
            onChange={(event) =>
              setManualZoom(
                timelineSliderToZoomPercent(Number(event.currentTarget.value)),
              )
            }
            className="mx-1 w-[96px] cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[2px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-neutral-700 [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-[10px] [&::-webkit-slider-thumb]:w-[10px] [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_#0a0a0a,0_1px_3px_rgba(0,0,0,0.5)] [&::-webkit-slider-thumb:active]:cursor-grabbing"
          />

          <Tooltip label="放大时间线">
            <button
              type="button"
              aria-label="放大时间线"
              onClick={() =>
                setManualZoom(
                  getNextTimelineZoomPercent("in", zoomMode, manualZoomPercent),
                )
              }
              className={FLAT_IDLE}
            >
              <MagnifyingGlassPlus size={16} aria-hidden="true" />
            </button>
          </Tooltip>

          <span
            className="ml-1 w-[38px] select-none text-right font-mono text-[11px] tabular-nums text-neutral-500"
            aria-label="时间线缩放级别"
          >
            {zoomMode === "fit" ? "Fit" : `${displayedTimelineZoomPercent}%`}
          </span>
        </div>
      </div>
    </div>
  );
}
