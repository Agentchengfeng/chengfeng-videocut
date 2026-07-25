import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  EDIT_LIST_MIN_SEGMENT_SECONDS,
  applyEditListOperation,
  editListSegmentDuration,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
  type EditListOperation,
  type EditListSegment,
} from "@video-workbench/core";
import type { ProjectEditListState } from "../../components/useProjectEditList";
import {
  buildDeleteOperation,
  buildMoveOperation,
  buildSplitOperation,
  buildTrimOperation,
  calculateMoveTargetIndex,
  type TrimEdge,
} from "./editOperations";
import { CutAudioWaveform } from "./CutAudioWaveform";
import { CutVideoFilmstrip } from "./CutVideoFilmstrip";
import { formatTimelineClipRange } from "./timelineTicks";
import {
  Timeline,
  TimelineToolbar,
  type ProductTimelineSegmentView,
} from "./hyperframes-fork";
import {
  GUTTER,
  TRACKS_LEFT_PAD,
  generateTicks,
  getTimelineDisplayContentWidth,
  getTimelineFitPps,
  getTimelineScrollLeftForZoomAnchor,
} from "./hyperframes-fork/timelineLayout";
import {
  getPinchTimelineZoomPercent,
  getTimelinePixelsPerSecond,
} from "./hyperframes-fork/timelineZoom";
import {
  TIMELINE_SNAP_PX,
  collectTimelineSnapTargets,
  snapTimelineTime,
} from "./hyperframes-fork/timelineSnapping";

const FALLBACK_VIEWPORT_WIDTH = 800;
const MOVE_ACTIVATION_PX = 4;
const TRIM_ACTIVATION_PX = 2;

type MoveOperation = Extract<EditListOperation, { type: "move" }>;
type TrimOperation = Extract<EditListOperation, { type: "trim" }>;

interface MovePreview {
  segmentId: string;
  operation: MoveOperation;
}

interface TrimPreview {
  segmentId: string;
  edge: TrimEdge;
  operation: TrimOperation | null;
}

function startTrimPreviewSegments(
  segments: readonly EditListSegment[],
  preview: TrimPreview | null,
): readonly EditListSegment[] | null {
  if (preview?.edge !== "start" || !preview.operation) return null;
  const operation = preview.operation;
  return segments.map((segment) => {
    if (segment.id !== preview.segmentId) return segment;
    const timelineDelta =
      (operation.sourceStart - segment.sourceStart) / segment.playbackRate;
    return {
      ...segment,
      sourceStart: operation.sourceStart,
      sourceEnd: operation.sourceEnd,
      timelineStart: segment.timelineStart + timelineDelta,
    };
  });
}

function hasSameSegmentOrder(
  left: readonly EditListSegment[],
  right: readonly EditListSegment[],
): boolean {
  return left.length === right.length && left.every((segment, index) => segment.id === right[index]?.id);
}

function saveLabel(state: ProjectEditListState["saveState"]): string {
  if (state === "saving") return "保存中";
  if (state === "conflict") return "检测到其他修改，已重新载入";
  if (state === "error") return "保存失败";
  return "";
}

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function CutTimeline({
  projectId,
  editList,
  timelineTime,
  onSeek,
  canUndo,
  onUndo,
}: {
  projectId: string;
  editList: ProjectEditListState;
  timelineTime: number;
  onSeek: (time: number) => void;
  canUndo: boolean;
  onUndo: () => void;
}) {
  const document = editList.document;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeMoveCleanupRef = useRef<((waitForPointerEnd?: boolean) => void) | null>(null);
  const activeTrimCleanupRef = useRef<(() => void) | null>(null);
  const activeScrubCleanupRef = useRef<(() => void) | null>(null);
  const suppressClipClickRef = useRef<string | null>(null);
  const suppressClipClickFrameRef = useRef<number | null>(null);
  const editListProjectIdRef = useRef(editList.projectId);
  const editListRevisionRef = useRef(editList.revision);
  editListProjectIdRef.current = editList.projectId;
  editListRevisionRef.current = editList.revision;
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const [trimPreview, setTrimPreview] = useState<TrimPreview | null>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">("fit");
  const [manualZoomPercent, setManualZoomPercent] = useState(100);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [snapGuideTime, setSnapGuideTime] = useState<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(FALLBACK_VIEWPORT_WIDTH);
  const [localError, setLocalError] = useState<string | null>(null);
  const previousPixelsPerSecondRef = useRef<number | null>(null);
  const skipCenterZoomAnchorRef = useRef(false);

  const segments = document?.segments ?? [];
  const sourceDuration = document?.sourceDuration ?? 0;
  const committedSegmentsById = useMemo(
    () => new Map(segments.map((segment) => [segment.id, segment] as const)),
    [segments],
  );
  const previewDocument = useMemo(() => {
    // A start-edge gesture previews like a professional NLE: only the dragged
    // clip's left edge and width change while neighboring clips stay put. The
    // Product Core's magnetic/ripple normalization is intentionally deferred
    // until pointerup commits the trim operation.
    if (trimPreview?.edge === "start" && trimPreview.operation) return document;
    const operation = trimPreview?.operation ?? movePreview?.operation;
    if (!document || !operation) return document;
    try {
      return applyEditListOperation(document, operation);
    } catch {
      return document;
    }
  }, [document, movePreview, trimPreview]);
  const renderedSegments = useMemo(
    () => startTrimPreviewSegments(segments, trimPreview) ?? previewDocument?.segments ?? segments,
    [previewDocument, segments, trimPreview],
  );
  const duration = document?.duration ?? 0;
  const renderedTimelineTime = useMemo(() => {
    if (!document || !previewDocument || previewDocument === document) return timelineTime;
    const sourceTime = timelineTimeToSourceTime(document, timelineTime);
    if (sourceTime === null) return Math.min(previewDocument.duration, Math.max(0, timelineTime));
    return sourceTimeToTimelineTime(previewDocument, sourceTime) ??
      Math.min(previewDocument.duration, Math.max(0, timelineTime));
  }, [document, previewDocument, timelineTime]);
  const fitPixelsPerSecond = getTimelineFitPps(viewportWidth, duration);
  const pixelsPerSecond = getTimelinePixelsPerSecond(
    fitPixelsPerSecond,
    zoomMode,
    manualZoomPercent,
  );
  const trackContentWidth = Math.max(0, duration * pixelsPerSecond);
  const displayContentWidth = getTimelineDisplayContentWidth({
    trackContentWidth,
    viewportWidth,
    pps: pixelsPerSecond,
  });
  // Canvas width includes a physical empty surface for short comps and live
  // drag/resize affordances. It must never invent a second, longer user-facing
  // time domain: Player, ruler ticks, screen-reader text and scrub clamping all
  // use the canonical EDL duration.
  const rulerDuration = duration;
  const selectedSegment = segments.find((segment) => segment.id === selectedClipId) ?? null;
  const canSplitSelected = Boolean(
    selectedSegment &&
    timelineTime >= selectedSegment.timelineStart + EDIT_LIST_MIN_SEGMENT_SECONDS &&
    timelineTime <= selectedSegment.timelineStart + editListSegmentDuration(selectedSegment) -
      EDIT_LIST_MIN_SEGMENT_SECONDS,
  );
  const saveStatus = saveLabel(editList.saveState);

  const fitTimeline = useCallback(() => {
    setZoomMode("fit");
    scrollRef.current?.scrollTo({ left: 0 });
  }, []);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const syncViewportWidth = () => {
      setViewportWidth(scroll.clientWidth > 0 ? scroll.clientWidth : FALLBACK_VIEWPORT_WIDTH);
    };
    syncViewportWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncViewportWidth);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [document]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const previousPixelsPerSecond = previousPixelsPerSecondRef.current;
    previousPixelsPerSecondRef.current = pixelsPerSecond;
    const skipCenterAnchor = skipCenterZoomAnchorRef.current;
    skipCenterZoomAnchorRef.current = false;
    if (
      !scroll ||
      previousPixelsPerSecond === null ||
      previousPixelsPerSecond === pixelsPerSecond ||
      skipCenterAnchor
    ) {
      return;
    }
    if (zoomMode === "fit") {
      scroll.scrollLeft = 0;
      return;
    }
    const nextScrollLeft = getTimelineScrollLeftForZoomAnchor({
      pointerX: scroll.clientWidth / 2,
      currentScrollLeft: scroll.scrollLeft,
      gutter: GUTTER + TRACKS_LEFT_PAD,
      currentPixelsPerSecond: previousPixelsPerSecond,
      nextPixelsPerSecond: pixelsPerSecond,
      duration,
    });
    const maxScrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    scroll.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
  }, [duration, pixelsPerSecond, zoomMode]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const handlePinchWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || duration <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = scroll.getBoundingClientRect();
      const nextZoomPercent = getPinchTimelineZoomPercent(
        event.deltaY,
        zoomMode,
        manualZoomPercent,
      );
      const nextPixelsPerSecond = fitPixelsPerSecond * (nextZoomPercent / 100);
      const nextScrollLeft = getTimelineScrollLeftForZoomAnchor({
        pointerX: event.clientX - rect.left,
        currentScrollLeft: scroll.scrollLeft,
        gutter: GUTTER + TRACKS_LEFT_PAD,
        currentPixelsPerSecond: pixelsPerSecond,
        nextPixelsPerSecond,
        duration,
      });
      skipCenterZoomAnchorRef.current = true;
      setZoomMode("manual");
      setManualZoomPercent(nextZoomPercent);
      window.requestAnimationFrame(() => {
        const maxScrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
        scroll.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
      });
    };
    scroll.addEventListener("wheel", handlePinchWheel, { passive: false, capture: true });
    return () => scroll.removeEventListener("wheel", handlePinchWheel, { capture: true });
  }, [
    duration,
    fitPixelsPerSecond,
    manualZoomPercent,
    pixelsPerSecond,
    zoomMode,
  ]);

  useEffect(() => {
    if (selectedClipId && !segments.some((segment) => segment.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [segments, selectedClipId]);

  useEffect(() => () => {
    activeMoveCleanupRef.current?.(false);
    activeTrimCleanupRef.current?.();
    activeScrubCleanupRef.current?.();
    if (suppressClipClickFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressClipClickFrameRef.current);
      suppressClipClickFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    activeMoveCleanupRef.current?.(true);
    activeTrimCleanupRef.current?.();
  }, [editList.projectId, editList.revision]);

  const timeAtClientX = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track || !document) return 0;
    const rect = track.getBoundingClientRect();
    const time = (clientX - rect.left) / Math.max(pixelsPerSecond, 0.000001);
    return Math.max(0, Math.min(document.duration, time));
  }, [document, pixelsPerSecond]);

  const trimTimeAtClientX = useCallback((
    clientX: number,
    segmentId: string,
  ): number => {
    const rawTime = timeAtClientX(clientX);
    if (!snappingEnabled || !document) {
      setSnapGuideTime(null);
      return rawTime;
    }
    const targets = collectTimelineSnapTargets({
      elements: document.segments.map((segment) => ({
        id: segment.id,
        start: segment.timelineStart,
        duration: editListSegmentDuration(segment),
      })),
      playheadTime: timelineTime,
      excludeElementId: segmentId,
    });
    const snapped = snapTimelineTime(
      rawTime,
      targets,
      TIMELINE_SNAP_PX / Math.max(pixelsPerSecond, 1),
    );
    setSnapGuideTime(snapped.target?.time ?? null);
    return snapped.time;
  }, [document, pixelsPerSecond, snappingEnabled, timeAtClientX, timelineTime]);

  const beginScrub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!document || event.button !== 0) return;
    activeScrubCleanupRef.current?.();
    const pointerId = event.pointerId;
    setIsScrubbing(true);
    onSeek(timeAtClientX(event.clientX));

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      setIsScrubbing(false);
      if (activeScrubCleanupRef.current === cleanup) activeScrubCleanupRef.current = null;
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      onSeek(timeAtClientX(moveEvent.clientX));
    };
    const onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      onSeek(timeAtClientX(endEvent.clientX));
      cleanup();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    activeScrubCleanupRef.current = cleanup;
  }, [document, onSeek, timeAtClientX]);

  const commit = useCallback(async (operation: EditListOperation) => {
    setLocalError(null);
    try {
      await editList.patchOperation(operation);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "时间线修改失败");
    }
  }, [editList]);

  const releaseClipClickSuppressionNextFrame = useCallback((segmentId: string) => {
    if (suppressClipClickFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressClipClickFrameRef.current);
    }
    suppressClipClickRef.current = segmentId;
    suppressClipClickFrameRef.current = window.requestAnimationFrame(() => {
      suppressClipClickFrameRef.current = null;
      if (suppressClipClickRef.current === segmentId) suppressClipClickRef.current = null;
    });
  }, []);

  const splitSelected = useCallback(() => {
    if (!document || !selectedSegment || !canSplitSelected) {
      setLocalError("请先把播放头放到所选片段内部");
      return;
    }
    try {
      void commit(buildSplitOperation(selectedSegment, timelineTime));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "当前播放头不能拆分片段");
    }
  }, [canSplitSelected, commit, document, selectedSegment, timelineTime]);

  const deleteSelected = useCallback(() => {
    if (!selectedSegment || segments.length <= 1) return;
    void commit(buildDeleteOperation(selectedSegment));
  }, [commit, segments.length, selectedSegment]);

  const beginMove = (
    event: ReactPointerEvent<HTMLElement>,
    segment: EditListSegment,
  ) => {
    if (!document || event.button !== 0 || editList.saveState === "saving") return;
    activeMoveCleanupRef.current?.(false);
    activeTrimCleanupRef.current?.();

    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startDocument = document;
    const startProjectId = editList.projectId;
    const startRevision = editList.revision;
    let activated = false;
    let cancelled = false;
    let finished = false;
    let previewFrame = 0;
    let pendingClientX: number | null = null;
    handle.setPointerCapture?.(pointerId);

    const resolveOperation = (clientX: number): MoveOperation => {
      const dropTime = timeAtClientX(clientX);
      const targetIndex = calculateMoveTargetIndex(startDocument.segments, segment.id, dropTime);
      return buildMoveOperation(startDocument.segments, segment.id, targetIndex) as MoveOperation;
    };

    const updatePreview = (clientX: number) => {
      setMovePreview({ segmentId: segment.id, operation: resolveOperation(clientX) });
    };

    const cancelPreviewFrame = () => {
      if (previewFrame) window.cancelAnimationFrame(previewFrame);
      previewFrame = 0;
      pendingClientX = null;
    };

    const clearPreview = () => {
      cancelPreviewFrame();
      setMovePreview((current) => current?.segmentId === segment.id ? null : current);
      setDraggingClipId((current) => current === segment.id ? null : current);
    };

    const removeActiveListeners = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", cancelWithEscape, true);
    };

    const cleanup = () => {
      if (finished) return;
      finished = true;
      removeActiveListeners();
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelAtPointerEnd);
      clearPreview();
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture?.(pointerId);
      if (activeMoveCleanupRef.current === cancelTransaction) activeMoveCleanupRef.current = null;
    };

    const cancelTransaction = (waitForPointerEnd = true) => {
      if (finished) return;
      cancelled = true;
      clearPreview();
      removeActiveListeners();
      if (!activated) {
        cleanup();
        return;
      }
      suppressClipClickRef.current = segment.id;
      if (!waitForPointerEnd) {
        releaseClipClickSuppressionNextFrame(segment.id);
        cleanup();
      }
    };

    function onPointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId || cancelled) return;
      const distance = Math.hypot(
        moveEvent.clientX - startClientX,
        moveEvent.clientY - startClientY,
      );
      if (!activated && distance < MOVE_ACTIVATION_PX) return;
      if (
        editListProjectIdRef.current !== startProjectId ||
        editListRevisionRef.current !== startRevision
      ) {
        cancelTransaction(true);
        return;
      }
      moveEvent.preventDefault();
      if (!activated) {
        activated = true;
        setLocalError(null);
        setSelectedClipId(segment.id);
        setDraggingClipId(segment.id);
      }
      pendingClientX = moveEvent.clientX;
      if (previewFrame) return;
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = 0;
        if (pendingClientX === null || cancelled) return;
        try {
          updatePreview(pendingClientX);
        } catch (cause) {
          setLocalError(cause instanceof Error ? cause.message : "移动片段预览失败");
        }
        pendingClientX = null;
      });
    }

    function finish(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId || finished) return;
      if (cancelled) {
        releaseClipClickSuppressionNextFrame(segment.id);
        cleanup();
        return;
      }
      if (!activated) {
        cleanup();
        return;
      }
      cancelPreviewFrame();
      let operation: MoveOperation | null = null;
      let changed = false;
      try {
        operation = resolveOperation(upEvent.clientX);
        const result = applyEditListOperation(startDocument, operation);
        changed = !hasSameSegmentOrder(startDocument.segments, result.segments);
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : "移动片段失败");
      }
      releaseClipClickSuppressionNextFrame(segment.id);
      cleanup();
      if (operation && changed) void commit(operation);
    }

    function cancelAtPointerEnd(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerId || finished) return;
      if (activated) releaseClipClickSuppressionNextFrame(segment.id);
      cleanup();
    }

    function cancelWithEscape(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancelTransaction(true);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelAtPointerEnd);
    window.addEventListener("keydown", cancelWithEscape, true);
    activeMoveCleanupRef.current = cancelTransaction;
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (isInteractiveShortcutTarget(target)) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z"
      ) {
        if (!canUndo) return;
        event.preventDefault();
        onUndo();
        return;
      }
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selectedSegment) {
        event.preventDefault();
        deleteSelected();
      }
      if (event.key.toLowerCase() === "s" && selectedSegment) {
        event.preventDefault();
        splitSelected();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setSnappingEnabled((enabled) => !enabled);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canUndo, deleteSelected, onUndo, selectedSegment, splitSelected]);

  const beginTrim = (
    event: ReactPointerEvent<HTMLElement>,
    segment: EditListSegment,
    edge: TrimEdge,
  ) => {
    if (!document || editList.saveState === "saving") return;
    activeTrimCleanupRef.current?.();
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(segment.id);
    setTrimPreview({ segmentId: segment.id, edge, operation: null });
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const startClientX = event.clientX;
    let currentOperation: TrimOperation | null = null;
    let activated = false;
    let previewFrame = 0;
    let pendingClientX: number | null = null;
    handle.setPointerCapture?.(pointerId);

    const updatePreview = (clientX: number) => {
      currentOperation = buildTrimOperation(
        segment,
        edge,
        trimTimeAtClientX(clientX, segment.id),
        document.sourceDuration,
      ) as TrimOperation;
      setTrimPreview({ segmentId: segment.id, edge, operation: currentOperation });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancelWithEscape);
      if (previewFrame) window.cancelAnimationFrame(previewFrame);
      previewFrame = 0;
      pendingClientX = null;
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture?.(pointerId);
      setTrimPreview((current) => current?.segmentId === segment.id && current.edge === edge
        ? null
        : current);
      setSnapGuideTime(null);
      if (activeTrimCleanupRef.current === cleanup) activeTrimCleanupRef.current = null;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!activated && Math.abs(moveEvent.clientX - startClientX) < TRIM_ACTIVATION_PX) return;
      activated = true;
      pendingClientX = moveEvent.clientX;
      if (previewFrame) return;
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = 0;
        if (pendingClientX === null) return;
        try {
          updatePreview(pendingClientX);
        } catch (cause) {
          setLocalError(cause instanceof Error ? cause.message : "裁切预览失败");
        }
        pendingClientX = null;
      });
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      suppressClipClickRef.current = segment.id;
      window.setTimeout(() => {
        if (suppressClipClickRef.current === segment.id) suppressClipClickRef.current = null;
      }, 0);
      if (activated) {
        try {
          updatePreview(upEvent.clientX);
        } catch (cause) {
          setLocalError(cause instanceof Error ? cause.message : "裁切失败");
        }
      }
      const operation = currentOperation;
      cleanup();
      if (
        activated &&
        operation &&
        (operation.sourceStart !== segment.sourceStart || operation.sourceEnd !== segment.sourceEnd)
      ) {
        void commit(operation);
      }
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
    };
    const cancelWithEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      cleanup();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancelWithEscape);
    activeTrimCleanupRef.current = cleanup;
  };

  const ticks = useMemo(
    () => generateTicks(rulerDuration, pixelsPerSecond),
    [rulerDuration, pixelsPerSecond],
  );
  const majorTickInterval = ticks.major.length >= 2
    ? (ticks.major[1] ?? rulerDuration) - (ticks.major[0] ?? 0)
    : rulerDuration;

  const timelineSegments = useMemo<ProductTimelineSegmentView[]>(() =>
    renderedSegments.map((segment, index) => {
      const segmentDuration = editListSegmentDuration(segment);
      const mediaSegment = committedSegmentsById.get(segment.id) ?? segment;
      const mediaSegmentWidth = editListSegmentDuration(mediaSegment) * pixelsPerSecond;
      const selected = segment.id === selectedClipId;
      const hovered = segment.id === hoveredClipId;
      const dragging = segment.id === draggingClipId;
      const trimming = segment.id === trimPreview?.segmentId;
      const active = renderedTimelineTime >= segment.timelineStart &&
        renderedTimelineTime < segment.timelineStart + segmentDuration;
      const rangeLabel = formatTimelineClipRange(
        segment.timelineStart,
        segment.timelineStart + segmentDuration,
      );
      return {
        id: segment.id,
        index,
        start: segment.timelineStart,
        duration: segmentDuration,
        label: `口播 ${String(index + 1).padStart(2, "0")}`,
        audioLabel: "原声",
        title: `${index + 1}. ${segment.sourceStart.toFixed(2)}–${segment.sourceEnd.toFixed(2)}s`,
        selected,
        hovered,
        dragging,
        trimming,
        active,
        videoContent: (
          <>
            <CutVideoFilmstrip
              projectId={projectId}
              segment={mediaSegment}
              segmentWidth={mediaSegmentWidth}
              sourceDuration={sourceDuration}
            />
            {segmentDuration * pixelsPerSecond >= 58 && (
              <small className="timeline-clip__timecode">{rangeLabel}</small>
            )}
          </>
        ),
        audioContent: (
          <CutAudioWaveform
            projectId={projectId}
            segment={mediaSegment}
            segmentWidth={mediaSegmentWidth}
            sourceDuration={sourceDuration}
          />
        ),
      };
    }), [
      committedSegmentsById,
      draggingClipId,
      hoveredClipId,
      pixelsPerSecond,
      projectId,
      renderedSegments,
      renderedTimelineTime,
      selectedClipId,
      sourceDuration,
      trimPreview?.segmentId,
    ]);

  if (!document) {
    return (
      <section className="cf-cut-timeline is-loading" aria-label="视频与原声联动时间线">
        {editList.loading ? "正在读取剪辑时间线…" : "当前项目没有可编辑 EDL"}
      </section>
    );
  }

  return (
    <section
      className="cf-cut-timeline relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-800/50 bg-neutral-950"
      aria-label="视频与原声联动时间线"
      data-edit-list-revision={editList.revision}
      data-edit-list-mode={document.mode}
      data-linked-av-tracks="true"
      data-hyperframes-timeline-fork="active"
    >
      <TimelineToolbar
        selectionActive
        canUndo={canUndo}
        onUndo={onUndo}
        onSelectTool={() => setLocalError(null)}
        snappingEnabled={snappingEnabled}
        onSnappingEnabledChange={setSnappingEnabled}
        canSplit={canSplitSelected && editList.saveState !== "saving"}
        onSplit={splitSelected}
        canDelete={Boolean(
          selectedSegment && segments.length > 1 && editList.saveState !== "saving"
        )}
        onDelete={deleteSelected}
        zoomMode={zoomMode}
        manualZoomPercent={manualZoomPercent}
        onZoomModeChange={(mode) => {
          if (mode === "fit") fitTimeline();
          else setZoomMode(mode);
        }}
        onManualZoomPercentChange={setManualZoomPercent}
      />

      {saveStatus && (
        <span className={`cf-cut-timeline-save-status is-${editList.saveState}`}>
          {saveStatus}
        </span>
      )}

      {(localError || editList.saveState === "error" || editList.saveState === "conflict") && (
        <div className="cf-cut-timeline-error" role="alert">{localError ?? saveStatus}</div>
      )}

      <Timeline
        scrollRef={scrollRef}
        segments={timelineSegments}
        pixelsPerSecond={pixelsPerSecond}
        displayContentWidth={displayContentWidth}
        rulerDuration={rulerDuration}
        currentTime={Math.min(duration, Math.max(0, renderedTimelineTime))}
        isScrubbing={isScrubbing}
        majorTicks={ticks.major}
        minorTicks={ticks.minor}
        majorTickInterval={majorTickInterval}
        trackRef={trackRef}
        disabled={editList.saveState === "saving"}
        snapGuideTime={snapGuideTime}
        onCanvasPointerDown={(event) => {
          if (event.button !== 0) return;
          if (
            (event.target as Element).closest(
              "[data-clip='true'], [data-edl-segment-id], [data-linked-segment-id]",
            )
          ) return;
          const trackLeft = trackRef.current?.getBoundingClientRect().left;
          if (trackLeft !== undefined && event.clientX < trackLeft) return;
          beginScrub(event);
        }}
        onSegmentHover={(segmentId) => setHoveredClipId(segmentId)}
        onSegmentPointerDown={(event, segmentId) => {
          const segment = renderedSegments.find((candidate) => candidate.id === segmentId);
          if (segment) beginMove(event, segment);
        }}
        onSegmentFocus={(segmentId) => setSelectedClipId(segmentId)}
        onSegmentClick={(event, segmentId) => {
          event.stopPropagation();
          if (suppressClipClickRef.current === segmentId) {
            suppressClipClickRef.current = null;
            return;
          }
          setSelectedClipId(segmentId);
          onSeek(timeAtClientX(event.clientX));
        }}
        onSegmentResizeStart={(edge, event, segmentId) => {
          const segment = renderedSegments.find((candidate) => candidate.id === segmentId);
          if (segment) beginTrim(event, segment, edge);
        }}
      />
    </section>
  );
}
