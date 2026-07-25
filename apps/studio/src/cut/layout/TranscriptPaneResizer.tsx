import {
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const TRANSCRIPT_WIDTH_STORAGE_KEY = "chengfeng-videocut:koubo:transcript-width:v1";
export const TRANSCRIPT_WIDTH_DEFAULT = 320;
export const TRANSCRIPT_WIDTH_MIN = 280;
export const TRANSCRIPT_WIDTH_MAX = 480;
export const PLAYER_WIDTH_MIN = 480;
export const TRANSCRIPT_SEPARATOR_WIDTH = 3;
export const TRANSCRIPT_RESIZE_BREAKPOINT = 960;

interface TranscriptWidthBounds {
  min: number;
  max: number;
}

interface DragState {
  pointerId: number;
  startWidth: number;
  startClientX: number;
  target: HTMLDivElement;
}

function finitePreference(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPreference(): number {
  try {
    const saved = finitePreference(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY));
    if (saved === null || saved < TRANSCRIPT_WIDTH_MIN || saved > TRANSCRIPT_WIDTH_MAX) {
      return TRANSCRIPT_WIDTH_DEFAULT;
    }
    return saved;
  } catch {
    return TRANSCRIPT_WIDTH_DEFAULT;
  }
}

function persistPreference(width: number): void {
  try {
    window.localStorage.setItem(TRANSCRIPT_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Local UI preference is optional. Never fall back to project persistence.
  }
}

export function transcriptWidthBounds(workspaceWidth: number, inlinePadding = 2): TranscriptWidthBounds {
  const available = Math.max(
    TRANSCRIPT_WIDTH_MIN,
    workspaceWidth - inlinePadding - PLAYER_WIDTH_MIN - TRANSCRIPT_SEPARATOR_WIDTH,
  );
  return {
    min: TRANSCRIPT_WIDTH_MIN,
    max: Math.max(TRANSCRIPT_WIDTH_MIN, Math.min(TRANSCRIPT_WIDTH_MAX, available)),
  };
}

export function clampTranscriptWidth(width: number, workspaceWidth: number, inlinePadding = 2): number {
  const bounds = transcriptWidthBounds(workspaceWidth, inlinePadding);
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function workspaceMetrics(workspaceRef: RefObject<HTMLElement | null>): { width: number; inlinePadding: number } {
  const workspace = workspaceRef.current;
  const measured = workspace?.getBoundingClientRect().width ?? 0;
  if (!workspace || measured <= 0) return { width: window.innerWidth, inlinePadding: 2 };
  const computed = window.getComputedStyle(workspace);
  const inlinePadding = (Number.parseFloat(computed.paddingLeft) || 0) + (Number.parseFloat(computed.paddingRight) || 0);
  return { width: measured, inlinePadding };
}

export function TranscriptPaneResizer({
  workspaceRef,
  onWidthChange,
  onResizingChange,
}: {
  workspaceRef: RefObject<HTMLElement | null>;
  onWidthChange: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}) {
  const [storedWidth, setStoredWidth] = useState(readPreference);
  const [renderVersion, setRenderVersion] = useState(0);
  const dragRef = useRef<DragState | null>(null);
  const widthRef = useRef(storedWidth);
  const metrics = workspaceMetrics(workspaceRef);
  const width = useMemo(
    () => clampTranscriptWidth(storedWidth, metrics.width, metrics.inlinePadding),
    [metrics.inlinePadding, metrics.width, renderVersion, storedWidth],
  );
  const bounds = useMemo(
    () => transcriptWidthBounds(metrics.width, metrics.inlinePadding),
    [metrics.inlinePadding, metrics.width, renderVersion],
  );

  useEffect(() => {
    onWidthChange(width);
  }, [onWidthChange, width]);

  useEffect(() => {
    const resize = () => setRenderVersion((version) => version + 1);
    window.addEventListener("resize", resize);
    const workspace = workspaceRef.current;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function" && workspace) {
      observer = new ResizeObserver(resize);
      observer.observe(workspace);
    }
    return () => {
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, [workspaceRef]);

  const abortDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    widthRef.current = drag.startWidth;
    setStoredWidth(drag.startWidth);
    onResizingChange(false);
    if (drag.target.hasPointerCapture?.(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId);
    }
  }, [onResizingChange]);

  useEffect(() => {
    const onBlur = () => abortDrag();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      abortDrag();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onEscape);
      abortDrag();
    };
  }, [abortDrag]);

  const setTemporaryWidth = useCallback((next: number) => {
    const metrics = workspaceMetrics(workspaceRef);
    const clamped = clampTranscriptWidth(next, metrics.width, metrics.inlinePadding);
    widthRef.current = clamped;
    setStoredWidth(clamped);
  }, [workspaceRef]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const metrics = workspaceMetrics(workspaceRef);
    const initial = clampTranscriptWidth(storedWidth, metrics.width, metrics.inlinePadding);
    widthRef.current = initial;
    dragRef.current = {
      pointerId: event.pointerId,
      startWidth: initial,
      startClientX: event.clientX,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizingChange(true);
    event.preventDefault();
  }, [onResizingChange, storedWidth, workspaceRef]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTemporaryWidth(drag.startWidth + event.clientX - drag.startClientX);
    event.preventDefault();
  }, [setTemporaryWidth, workspaceRef]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const metrics = workspaceMetrics(workspaceRef);
    const committed = clampTranscriptWidth(widthRef.current, metrics.width, metrics.inlinePadding);
    widthRef.current = committed;
    setStoredWidth(committed);
    persistPreference(committed);
    onResizingChange(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [onResizingChange, storedWidth, workspaceRef]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width - 16;
    if (event.key === "ArrowRight") next = width + 16;
    if (event.key === "PageDown") next = width - 48;
    if (event.key === "PageUp") next = width + 48;
    if (event.key === "Home") next = bounds.min;
    if (event.key === "End") next = bounds.max;
    if (event.key === "Escape") {
      abortDrag();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const metrics = workspaceMetrics(workspaceRef);
    const committed = clampTranscriptWidth(next, metrics.width, metrics.inlinePadding);
    widthRef.current = committed;
    setStoredWidth(committed);
    persistPreference(committed);
  }, [abortDrag, bounds.max, bounds.min, width, workspaceRef]);

  return (
    <div
      role="separator"
      aria-label="调整文稿宽度"
      aria-orientation="vertical"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`文稿宽度 ${Math.round(width)} 像素`}
      tabIndex={0}
      className="cf-cut-transcript-resizer"
      data-testid="transcript-width-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={abortDrag}
      onLostPointerCapture={abortDrag}
      onKeyDown={onKeyDown}
    />
  );
}
