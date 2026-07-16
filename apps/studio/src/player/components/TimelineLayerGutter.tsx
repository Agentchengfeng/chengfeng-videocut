import { Eye, EyeSlash } from "@phosphor-icons/react";
import type { TimelineTheme } from "./timelineTheme";
import { GUTTER } from "./timelineLayout";

interface TimelineLayerGutterProps {
  isAudio: boolean;
  isTrackHidden: boolean;
  rowTrack: number;
  timelineRole?: string;
  theme: TimelineTheme;
  onToggleHidden: () => void;
}

function getTrackLabel(
  timelineRole: string | undefined,
  rowTrack: number,
  isAudio: boolean,
) {
  if (timelineRole === "a-roll") return "A-roll";
  if (timelineRole === "b-roll") return "B-roll";
  if (timelineRole === "captions") return "字幕";
  if (isAudio) return "音频";
  return `V${rowTrack}`;
}

export function TimelineLayerGutter({
  isAudio,
  isTrackHidden,
  rowTrack,
  timelineRole,
  theme,
  onToggleHidden,
}: TimelineLayerGutterProps) {
  return (
    <div
      className="sticky left-0 z-[12] flex flex-shrink-0 items-center justify-between gap-1 px-2"
      style={{
        width: GUTTER,
        background: theme.gutterBackground,
        borderRight: `1px solid ${theme.gutterBorder}`,
      }}
    >
      <span
        className="truncate font-mono text-[9px] font-semibold uppercase"
        style={{ color: theme.textSecondary }}
      >
        {getTrackLabel(timelineRole, rowTrack, isAudio)}
      </span>
      <button
        type="button"
        aria-label={
          isTrackHidden ? `Show track ${rowTrack}` : `Hide track ${rowTrack}`
        }
        title={
          isTrackHidden ? `Show track ${rowTrack}` : `Hide track ${rowTrack}`
        }
        className={`flex h-6 w-6 flex-none items-center justify-center rounded border-0 bg-transparent p-0 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-[#3CE6AC] ${
          isTrackHidden
            ? "text-[#3CE6AC] hover:text-white"
            : "text-white/35 hover:text-white/75"
        }`}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleHidden();
        }}
      >
        {isTrackHidden ? (
          <EyeSlash size={14} weight="bold" aria-hidden="true" />
        ) : (
          <Eye size={14} weight="bold" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
