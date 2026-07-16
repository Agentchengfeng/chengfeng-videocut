import type { TimelineElement } from "../store/playerStore";

export interface TimelineTrackStyle {
  clip: string;
  accent: string;
  label: string;
  clipActive?: string;
}

export interface TimelineTheme {
  shellBackground: string;
  shellBorder: string;
  rulerBorder: string;
  rowBackground: string;
  rowBorder: string;
  gutterBackground: string;
  gutterBorder: string;
  textPrimary: string;
  textSecondary: string;
  tickText: string;
  tickMajor: string;
  tickMinor: string;
  clipBackground: string;
  clipBackgroundActive: string;
  clipBorder: string;
  clipBorderHover: string;
  clipBorderActive: string;
  clipShadow: string;
  clipShadowHover: string;
  clipShadowActive: string;
  clipShadowDragging: string;
  handleColor: string;
  panelResizeSeam: string;
  panelResizeActive: string;
  clipRadius: string;
}

const TRACK_STYLE: TimelineTrackStyle = {
  clip: "#FFFFFF",
  clipActive: "#F5E6DD",
  accent: "#D97757",
  label: "#5F5B54",
};

export const defaultTimelineTheme: TimelineTheme = {
  shellBackground: "#FDFCF8",
  shellBorder: "#E5E1D8",
  rulerBorder: "#D9D4C5",
  rowBackground: "#FAF9F5",
  rowBorder: "#EDE9E0",
  gutterBackground: "#F4F2EC",
  gutterBorder: "#E5E1D8",
  textPrimary: "#262625",
  textSecondary: "#6E6B64",
  tickText: "#9C988E",
  tickMajor: "#D9D4C5",
  tickMinor: "#EDE9E0",
  clipBackground: "#FFFFFF",
  clipBackgroundActive: "#F5E6DD",
  clipBorder: "#DED9CE",
  clipBorderHover: "#C8C2B5",
  clipBorderActive: "#D97757",
  clipShadow: "0 1px 1px rgba(38,38,37,0.03)",
  clipShadowHover: "0 2px 8px rgba(38,38,37,0.08)",
  clipShadowActive: "0 0 0 1px rgba(217,119,87,0.20)",
  clipShadowDragging:
    "0 8px 24px rgba(38,38,37,0.16), 0 0 0 1px rgba(217,119,87,0.24)",
  handleColor: "rgba(217,119,87,0.42)",
  panelResizeSeam: "#E5E1D8",
  panelResizeActive: "#D97757",
  clipRadius: "6px",
};

export function getTimelineTrackStyle(_tag: string): TimelineTrackStyle {
  return TRACK_STYLE;
}

export function getClipHandleOpacity({
  isHovered,
  isSelected,
  isDragging,
}: {
  isHovered: boolean;
  isSelected: boolean;
  isDragging: boolean;
}): number {
  if (isDragging) return 0.95;
  if (isSelected) return 0.82;
  if (isHovered) return 0.76;
  return 0;
}

export function getRenderedTimelineElement({
  element,
  draggedElementId,
  previewStart,
  previewTrack,
}: {
  element: TimelineElement;
  draggedElementId: string | null;
  previewStart: number | null;
  previewTrack: number | null;
}): TimelineElement {
  if (
    (element.key ?? element.id) !== draggedElementId ||
    previewStart === null ||
    previewTrack === null
  ) {
    return element;
  }
  return {
    ...element,
    start: previewStart,
    track: previewTrack,
  };
}
