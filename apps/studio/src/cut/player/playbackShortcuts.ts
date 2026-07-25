export const CUT_PLAYER_FRAME_RATE = 30;

export type CutPlaybackShortcutAction =
  | { type: "toggle-play" }
  | { type: "pause" }
  | { type: "seek-frames"; frames: number }
  | { type: "toggle-muted" }
  | { type: "toggle-loop" }
  | { type: "toggle-fullscreen" };

export function isCutPlaybackShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    (target instanceof HTMLElement && (
      target.isContentEditable ||
      ["button", "slider", "textbox", "combobox", "menuitem"].includes(
        target.getAttribute("role") ?? "",
      )
    ))
  );
}

export function resolveCutPlaybackShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "repeat" | "shiftKey">,
): CutPlaybackShortcutAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;

  if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
    return {
      type: "seek-frames",
      frames: (event.shiftKey ? 10 : 1) * (event.code === "ArrowLeft" ? -1 : 1),
    };
  }

  if (event.repeat) return null;
  if (event.code === "Space") return { type: "toggle-play" };
  if (event.code === "KeyK") return { type: "pause" };
  if (event.code === "KeyM") return { type: "toggle-muted" };
  if (event.code === "KeyL" && event.shiftKey) return { type: "toggle-loop" };
  if (event.code === "KeyF") return { type: "toggle-fullscreen" };
  return null;
}

export function seekTargetForFrameDelta(
  timelineTime: number,
  frames: number,
  duration: number,
  frameRate = CUT_PLAYER_FRAME_RATE,
): number {
  const safeRate = Number.isFinite(frameRate) && frameRate > 0
    ? frameRate
    : CUT_PLAYER_FRAME_RATE;
  const target = timelineTime + frames / safeRate;
  return Math.min(Math.max(0, duration), Math.max(0, target));
}
