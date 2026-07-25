import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  deriveActualCutWordIds,
  resolveTranscriptSeekTime,
} from "../../components/editListPlayback";
import type { useProjectCutSelection } from "../../components/useProjectCutSelection";
import type { ProjectEditListState } from "../../components/useProjectEditList";
import {
  indexKouboTranscript,
  findLaterRetainedExactDuplicates,
  isKouboWordInRange,
  resolveKouboEditingLockReason,
  updateKouboCutSelection,
  type IndexedKouboCue,
  type KouboWordRange,
} from "../../extensions/koubo/kouboViewModel";
import type { useKouboTranscript } from "../../extensions/koubo/useKouboTranscript";
import type { ProjectReviewPasses } from "../review/useProjectReviewPasses";

export interface KouboTranscriptPaneProps {
  projectId: string;
  editList: ProjectEditListState;
  transcript: ReturnType<typeof useKouboTranscript>;
  cutSelection: ReturnType<typeof useProjectCutSelection>;
  reviewPasses?: ProjectReviewPasses;
  onSeek: (time: number, options?: { keepPlaying?: boolean }) => void;
}

interface DragState {
  start: number;
  end: number;
  last: number;
  originX: number;
  originY: number;
  originScrollTop: number;
  intent: "undecided" | "select" | "scroll";
  pointerType: string;
  shiftKey: boolean;
  seekedOnPointerDown: boolean;
}

interface SelectionAnchor {
  x: number;
  y: number;
  wordId: string | null;
}

interface KouboTranscriptCueProps {
  cue: IndexedKouboCue;
  cueIndex: number;
  displayedCutWordIds: ReadonlySet<string>;
  selectionRange: KouboWordRange | null;
  keyboardAnchorWordId: string | null;
  virtualRemovedWordIds: ReadonlySet<string>;
  hideGaps: boolean;
  manualMode: boolean;
  editingLockReason: string | null;
  onWordPointerDown: (
    start: number,
    end: number,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => void;
  onWordKeyDown: (
    event: ReactKeyboardEvent<HTMLSpanElement>,
    range: KouboWordRange,
    sourceTime: number,
  ) => void;
}

function shouldShowTranscriptWord(
  word: IndexedKouboCue["words"][number]["word"],
  displayedCutWordIds: ReadonlySet<string>,
  virtualRemovedWordIds: ReadonlySet<string>,
  hideGaps: boolean,
): boolean {
  if (word.sourceWordIds.every((wordId) => virtualRemovedWordIds.has(wordId))) return false;
  if (hideGaps && word.isGap) return false;
  const cut = word.sourceWordIds.every((wordId) => displayedCutWordIds.has(wordId));
  const gap = Math.max(0, word.end - word.start);
  return !(word.isGap && gap < 0.35 && !cut);
}

const KouboTranscriptCue = memo(function KouboTranscriptCue({
  cue,
  cueIndex,
  displayedCutWordIds,
  selectionRange,
  keyboardAnchorWordId,
  virtualRemovedWordIds,
  hideGaps,
  manualMode,
  editingLockReason,
  onWordPointerDown,
  onWordKeyDown,
}: KouboTranscriptCueProps) {
  const visibleWords = cue.words.filter(({ word }) => shouldShowTranscriptWord(
    word,
    displayedCutWordIds,
    virtualRemovedWordIds,
    hideGaps,
  ));
  if (visibleWords.length === 0) return null;
  return (
    <article
      className="cut-transcript-cue"
      data-cue-id={cue.id}
      data-cue-index={cueIndex}
      aria-label={`文稿第 ${cueIndex} 段`}
    >
      <span className="cut-transcript-cue__index" aria-hidden="true">
        {String(cueIndex).padStart(2, "0")}
      </span>
      <p className="cut-transcript-cue__words">
        {visibleWords.map(({ word, startIndex, endIndex }) => {
          const cut = word.sourceWordIds.every((wordId) => displayedCutWordIds.has(wordId));
          const pending = isKouboWordInRange(startIndex, endIndex, selectionRange);
          const gap = Math.max(0, word.end - word.start);
          return (
            <span
              key={word.id}
              role="button"
              tabIndex={keyboardAnchorWordId === word.id ? 0 : -1}
              className={[
                "cut-transcript-word",
                word.isGap ? "is-gap" : "",
                cut ? "is-cut" : "",
                pending ? "is-pending" : "",
              ].filter(Boolean).join(" ")}
              data-word-id={word.id}
              data-word-start-index={startIndex}
              data-word-end-index={endIndex}
              aria-pressed={cut}
              aria-label={[
                word.isGap ? `停顿 ${gap.toFixed(1)} 秒` : word.text,
                pending ? "已选择" : "",
                cut ? "已删除" : "",
              ].filter(Boolean).join("，")}
              title={manualMode
                ? cut
                  ? "单击定位；拖动划选或 Shift 单击恢复"
                  : "单击定位；拖动划选或 Shift 单击删除"
                : editingLockReason ?? "单击定位；拖动划选；Shift 单击删除或恢复"}
              onPointerDown={(event) => onWordPointerDown(startIndex, endIndex, event)}
              onKeyDown={(event) => onWordKeyDown(
                event,
                { start: startIndex, end: endIndex },
                word.start,
              )}
            >
              {word.isGap ? `·停顿 ${gap.toFixed(1)}s·` : word.text}
            </span>
          );
        })}
      </p>
    </article>
  );
});

function saveStatusLabel(
  saveState: ReturnType<typeof useProjectCutSelection>["saveState"],
): string {
  if (saveState === "saving") return "保存中";
  if (saveState === "saved") return "已保存";
  if (saveState === "conflict") return "检测到其他修改，已重新载入";
  if (saveState === "error") return "保存失败";
  return "";
}

function normalizeRange(range: KouboWordRange): KouboWordRange {
  return {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
  };
}

function editFailureLabel(error: unknown, action: "delete" | "restore"): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "revision_conflict" || /revision.*conflict|changed after it was inspected/i.test(message)) {
    return "剪辑已发生变化，请重新选择后重试";
  }
  if (/adjacent|anchor|current timeline|no longer fits|snapshot/i.test(message)) {
    return "恢复位置已变化，请重新选择后重试";
  }
  if (/overlap/i.test(message)) return "恢复范围与当前片段重叠，无法恢复";
  if (/does not overlap|all retained content|outside the source|empty/i.test(message)) {
    return "所选内容已变化，请重新选择后重试";
  }
  return action === "delete" ? "删除失败，请重试" : "恢复失败，请重试";
}

export const KouboTranscriptPane = memo(function KouboTranscriptPane({
  projectId,
  editList,
  transcript,
  cutSelection,
  reviewPasses = { state: "missing", removedWordIds: [], candidates: [], reason: null },
  onSeek,
}: KouboTranscriptPaneProps) {
  const [selectionRange, setSelectionRange] = useState<KouboWordRange | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<SelectionAnchor | null>(null);
  const [selectionPosition, setSelectionPosition] = useState<SelectionAnchor | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const selectionPopoverRef = useRef<HTMLDivElement | null>(null);
  const selectionAnchorRef = useRef<SelectionAnchor | null>(null);
  const restorePendingRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const { cues, loading: transcriptLoading, error: transcriptError } = transcript;
  const {
    cutWordIds,
    saveState,
    selectionLoading,
    selectionReady,
    updateCutWordIds,
  } = cutSelection;

  const sourceWords = useMemo(() => cues.flatMap((cue) => cue.words), [cues]);
  const virtualRemovedWordIds = useMemo(() => reviewPasses.state === "current"
    ? new Set([
      ...reviewPasses.removedWordIds,
      ...reviewPasses.candidates.flatMap((candidate) => candidate.removeWordIds),
    ])
    : new Set<string>(), [reviewPasses]);
  const virtualTranscript = reviewPasses.state === "current";
  const displayedCutWordIds = useMemo(
    () => deriveActualCutWordIds(sourceWords, cutWordIds, editList.document),
    [cutWordIds, editList.document, sourceWords],
  );
  const indexedTranscript = useMemo(
    () => indexKouboTranscript(cues, displayedCutWordIds),
    [cues, displayedCutWordIds],
  );
  const visibleTranscriptCues = useMemo(() => indexedTranscript.cues.filter((cue) => cue.words.some(({ word }) =>
    shouldShowTranscriptWord(word, displayedCutWordIds, virtualRemovedWordIds, virtualTranscript),
  )), [displayedCutWordIds, indexedTranscript.cues, virtualRemovedWordIds, virtualTranscript]);
  const editingLockReason = resolveKouboEditingLockReason({
    transcriptLoading,
    selectionLoading,
    selectionReady,
    editListLoading: editList.loading,
    editListReady: editList.ready,
    manualTimeline: editList.document?.mode === "manual",
  });

  const wordsRef = useRef(indexedTranscript.words);
  const cutWordIdsRef = useRef(new Set(cutWordIds));
  const displayedCutWordIdsRef = useRef(new Set(displayedCutWordIds));
  const editingLockReasonRef = useRef(editingLockReason);
  wordsRef.current = indexedTranscript.words;
  cutWordIdsRef.current = new Set(cutWordIds);
  displayedCutWordIdsRef.current = new Set(displayedCutWordIds);
  editingLockReasonRef.current = editingLockReason;
  selectionAnchorRef.current = selectionAnchor;

  const dismissSelection = useCallback((options: { force?: boolean } = {}) => {
    if (restorePendingRef.current && !options.force) return;
    const wordId = selectionAnchorRef.current?.wordId;
    dragRef.current = null;
    setSelectionRange(null);
    setSelectionAnchor(null);
    setSelectionPosition(null);
    setRestoreError(null);
    if (wordId) {
      window.requestAnimationFrame(() => {
        const target = Array.from(
          transcriptRef.current?.querySelectorAll<HTMLElement>("[data-word-id]") ?? [],
        ).find((element) => element.dataset.wordId === wordId);
        target?.focus();
      });
    }
  }, []);

  const seekSourceTime = useCallback((
    sourceTime: number,
    options?: { keepPlaying?: boolean },
  ) => {
    const timelineTime = resolveTranscriptSeekTime(editList.document, sourceTime);
    if (options) onSeek(timelineTime, options);
    else onSeek(timelineTime);
  }, [editList.document, onSeek]);

  const restoreOperationForRange = useCallback((range: KouboWordRange) => {
    const selected = wordsRef.current.slice(range.start, range.end + 1);
    const sourceStart = Math.min(...selected.map((word) => word.start));
    const sourceEnd = Math.max(...selected.map((word) => word.end));
    const segments = editList.document?.segments ?? [];
    const previous = segments
      .filter((segment) => segment.sourceEnd <= sourceStart + 0.001)
      .sort((left, right) => right.sourceEnd - left.sourceEnd)[0];
    const next = segments
      .filter((segment) => segment.sourceStart >= sourceEnd - 0.001)
      .sort((left, right) => left.sourceStart - right.sourceStart)[0];
    const restore = {
      type: "restore" as const,
      sourceStart,
      sourceEnd,
      ...(previous ? { previousSegmentId: previous.id } : {}),
      ...(next ? { nextSegmentId: next.id } : {}),
    };
    const duplicateRangeCandidates = findLaterRetainedExactDuplicates(
      wordsRef.current,
      displayedCutWordIdsRef.current,
      range,
    ).map((duplicate) => {
      const sources = Array.from(new Set(
        segments
          .filter((segment) => segment.sourceStart < duplicate.sourceEnd && segment.sourceEnd > duplicate.sourceStart)
          .map((segment) => segment.source),
      ));
      return sources.length === 1
        ? {
          type: "delete-range" as const,
          source: sources[0],
          sourceStart: duplicate.sourceStart,
          sourceEnd: duplicate.sourceEnd,
        }
        : null;
    });
    const duplicateRanges = duplicateRangeCandidates.filter((candidate): candidate is {
      type: "delete-range";
      source: string;
      sourceStart: number;
      sourceEnd: number;
    } => candidate !== null);
    if (duplicateRanges.length === 0 || duplicateRanges.length !== duplicateRangeCandidates.length) {
      return restore;
    }
    return {
      ...restore,
      type: "restore-deduplicate" as const,
      duplicateRanges,
    };
  }, [editList.document?.segments]);

  const deleteOperationForRange = useCallback((range: KouboWordRange) => {
    const selected = wordsRef.current.slice(range.start, range.end + 1);
    const sourceStart = Math.min(...selected.map((word) => word.start));
    const sourceEnd = Math.max(...selected.map((word) => word.end));
    const sources = Array.from(new Set(
      (editList.document?.segments ?? [])
        .filter((segment) => segment.sourceStart < sourceEnd && segment.sourceEnd > sourceStart)
        .map((segment) => segment.source),
    ));
    if (sources.length !== 1) {
      throw new Error("请选择同一原素材中的保留词后再删除");
    }
    return {
      type: "delete-range" as const,
      source: sources[0],
      sourceStart,
      sourceEnd,
    };
  }, [editList.document?.segments]);

  const openManualSelection = useCallback((range: KouboWordRange, anchor: SelectionAnchor) => {
    const normalizedRange = normalizeRange(range);
    setRestoreError(null);
    setSelectionAnchor(anchor);
    setSelectionRange(normalizedRange);
  }, []);

  const applyRange = useCallback(async (range: KouboWordRange): Promise<boolean> => {
    const normalizedRange = normalizeRange(range);
    const selected = wordsRef.current.slice(normalizedRange.start, normalizedRange.end + 1);
    const selectedIsCut = selected.length > 0 && selected.every((word) =>
      displayedCutWordIdsRef.current.has(word.id),
    );
    if (editList.document?.mode === "manual") {
      const action = selectedIsCut ? "restore" : "delete";
      setRestorePending(true);
      restorePendingRef.current = true;
      setRestoreError(null);
      try {
        await editList.patchOperation(selectedIsCut
          ? restoreOperationForRange(normalizedRange)
          : deleteOperationForRange(normalizedRange));
        return true;
      } catch (error) {
        setRestoreError(editFailureLabel(error, action));
        return false;
      } finally {
        restorePendingRef.current = false;
        setRestorePending(false);
      }
    }
    if (editingLockReasonRef.current) return false;
    const next = updateKouboCutSelection(
      wordsRef.current,
      cutWordIdsRef.current,
      displayedCutWordIdsRef.current,
      normalizedRange,
    );
    cutWordIdsRef.current = next;
    try {
      return await updateCutWordIds(next);
    } catch {
      return false;
    }
  }, [deleteOperationForRange, editList.document?.mode, editList.patchOperation, restoreOperationForRange, updateCutWordIds]);

  useEffect(() => dismissSelection({ force: true }), [dismissSelection, projectId]);

  useEffect(() => {
    const rangeAtPoint = (event: PointerEvent): KouboWordRange | null => {
      const direct = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-word-start-index]")
        : null;
      const pointed = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-word-start-index]");
      const target = pointed ?? direct;
      if (!target || !transcriptRef.current?.contains(target)) return null;
      const start = Number(target.dataset.wordStartIndex);
      const end = Number(target.dataset.wordEndIndex);
      return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
    };

    const updateDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.intent === "undecided") {
        const deltaX = event.clientX - drag.originX;
        const deltaY = event.clientY - drag.originY;
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 6) return;
        // Reading always wins over selection. Touch deliberately has no drag-to-select
        // path so its native vertical pan can keep the Transcript's single scroll body.
        drag.intent = drag.pointerType === "touch" || Math.abs(deltaY) >= Math.abs(deltaX)
          ? "scroll"
          : "select";
      }
      if (drag.intent === "scroll") {
        // A mouse has no native press-and-drag scroll. Keep that affordance on
        // the one Transcript scroll owner while touch remains native `pan-y`.
        if (drag.pointerType !== "touch" && transcriptRef.current) {
          transcriptRef.current.scrollTop = Math.max(
            0,
            drag.originScrollTop - (event.clientY - drag.originY),
          );
        }
        return;
      }
      if (drag.intent !== "select") return;
      const endpoint = rangeAtPoint(event);
      if (!endpoint) return;
      drag.last = endpoint.end < drag.start ? endpoint.start : endpoint.end;
      setSelectionRange(normalizeRange({ start: drag.start, end: drag.last }));
    };

    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (drag.intent === "scroll") return;
      if (drag.intent === "undecided") {
        setSelectionRange(null);
        if (drag.shiftKey) {
          const range = { start: drag.start, end: drag.end };
          if (editList.document?.mode === "manual") {
            const word = wordsRef.current[drag.start];
            openManualSelection(range, {
              x: event.clientX,
              y: event.clientY,
              wordId: word?.id ?? null,
            });
          } else {
            void applyRange(range);
          }
          return;
        }
        if (!drag.seekedOnPointerDown) {
          const word = wordsRef.current[drag.start];
          if (word) seekSourceTime(word.start);
        }
        return;
      }

      const endpoint = rangeAtPoint(event);
      if (endpoint) {
        drag.last = endpoint.end < drag.start ? endpoint.start : endpoint.end;
      }
      const range = normalizeRange({ start: drag.start, end: drag.last });
      const selected = wordsRef.current.slice(range.start, range.end + 1);
      setRestoreError(null);
      setSelectionAnchor({
        x: event.clientX,
        y: event.clientY,
        wordId: selected[0]?.id ?? null,
      });
      setSelectionRange(range);
    };

    const cancelDrag = () => dismissSelection();
    document.addEventListener("pointermove", updateDrag);
    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", cancelDrag);
    return () => {
      document.removeEventListener("pointermove", updateDrag);
      document.removeEventListener("pointerup", finishDrag);
      document.removeEventListener("pointercancel", cancelDrag);
    };
  }, [applyRange, dismissSelection, editList.document?.mode, openManualSelection, seekSourceTime]);

  useEffect(() => {
    if (!selectionRange) return;
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissSelection();
    };
    document.addEventListener("keydown", dismissWithEscape);
    return () => document.removeEventListener("keydown", dismissWithEscape);
  }, [dismissSelection, selectionRange]);

  useEffect(() => {
    if (!selectionRange) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (selectionPopoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-word-id]")) return;
      dismissSelection();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointer);
  }, [dismissSelection, selectionRange]);

  useLayoutEffect(() => {
    if (!selectionRange || !selectionAnchor || !transcriptRef.current || !selectionPopoverRef.current) {
      return;
    }
    const viewport = transcriptRef.current.getBoundingClientRect();
    const popover = selectionPopoverRef.current.getBoundingClientRect();
    const gap = 8;
    let x = selectionAnchor.x + gap;
    let y = selectionAnchor.y - popover.height - gap;
    if (x + popover.width > viewport.right) x = selectionAnchor.x - popover.width - gap;
    if (y < viewport.top) y = selectionAnchor.y + gap;
    x = Math.max(viewport.left + gap, Math.min(x, viewport.right - popover.width - gap));
    y = Math.max(viewport.top + gap, Math.min(y, viewport.bottom - popover.height - gap));
    setSelectionPosition({ x, y, wordId: selectionAnchor.wordId });
  }, [restoreError, restorePending, selectionAnchor, selectionRange]);

  const selectedWords = selectionRange
    ? indexedTranscript.words.slice(selectionRange.start, selectionRange.end + 1)
    : [];
  const selectionIsCut = selectedWords.length > 0 && selectedWords.every(
    (word) => displayedCutWordIds.has(word.id),
  );
  const saveStatus = saveStatusLabel(saveState);

  const keyboardAnchor = useMemo(() => {
    let firstVisible: string | null = null;
    for (const cue of visibleTranscriptCues) {
      for (const { word } of cue.words) {
        if (!shouldShowTranscriptWord(word, displayedCutWordIds, virtualRemovedWordIds, virtualTranscript)) continue;
        firstVisible ??= word.id;
      }
    }
    return firstVisible;
  }, [displayedCutWordIds, virtualRemovedWordIds, virtualTranscript, visibleTranscriptCues]);
  const keyboardAnchorWordId = keyboardAnchor;

  const handleWordPointerDown = useCallback((
    start: number,
    end: number,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => {
    if (event.button !== 0) return;
    // Do not prevent default here: on a trackpad or touch screen that turns the
    // first movement into a blocked scroll. We classify after a small movement.
    // Desktop plain presses should still feel like an editor: move the shared
    // playhead immediately. Shift remains the explicit editing affordance, and
    // touch keeps tap-on-release so a vertical native pan never seeks on down.
    const seekedOnPointerDown = event.pointerType !== "touch" && !event.shiftKey;
    dragRef.current = {
      start,
      end,
      last: end,
      originX: event.clientX,
      originY: event.clientY,
      originScrollTop: transcriptRef.current?.scrollTop ?? 0,
      intent: "undecided",
      pointerType: event.pointerType || "mouse",
      shiftKey: event.shiftKey,
      seekedOnPointerDown,
    };
    setSelectionRange(null);
    if (seekedOnPointerDown) {
      const word = wordsRef.current[start];
      if (word) seekSourceTime(word.start, { keepPlaying: true });
    }
  }, [seekSourceTime]);

  const handleWordKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLSpanElement>,
    range: KouboWordRange,
    sourceTime: number,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.shiftKey) {
        if (editList.document?.mode === "manual") {
          const rect = event.currentTarget.getBoundingClientRect();
          openManualSelection(range, {
            x: rect.right,
            y: rect.top,
            wordId: event.currentTarget.dataset.wordId ?? null,
          });
        } else {
          void applyRange(range);
        }
      }
      else seekSourceTime(sourceTime);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
      event.key,
    )) return;
    const elements = Array.from(
      transcriptRef.current?.querySelectorAll<HTMLElement>("[data-word-id]") ?? [],
    ).filter((element) => element.offsetParent !== null);
    const currentIndex = elements.indexOf(event.currentTarget);
    if (currentIndex < 0 || elements.length === 0) return;
    const targetIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? elements.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(0, currentIndex - 1)
          : Math.min(elements.length - 1, currentIndex + 1);
    event.preventDefault();
    elements[targetIndex]?.focus();
  }, [editList.document?.mode, openManualSelection, seekSourceTime]);

  const handleTranscriptScroll = () => {
    // Mouse drag scrolling writes `scrollTop`, which emits a scroll event. It
    // must not clear the drag until pointerup or the next movement loses the
    // shared origin; ordinary scroll still dismisses any visible selection.
    if (dragRef.current?.intent === "scroll") return;
    dismissSelection();
  };

  return (
    <section
      className="cut-transcript-pane"
      aria-label="剪口播逐词审核"
      data-cut-transcript-pane="true"
    >
      {transcriptError && (
        <div className="cut-transcript-notice is-error" role="alert">{transcriptError}</div>
      )}
      {(saveState === "error" || saveState === "conflict") && (
        <div className="cut-transcript-notice is-error" role="alert">{saveStatus}</div>
      )}
      {reviewPasses.state === "stale" && (
        <div className="cut-transcript-notice" role="status">
          第二遍候选已过期，请重新生成
        </div>
      )}
      {reviewPasses.state === "invalid" && reviewPasses.reason && (
        <div className="cut-transcript-notice is-error" role="alert">
          第二遍候选不可用：{reviewPasses.reason}
        </div>
      )}

      {selectionRange && (
        <div
          ref={selectionPopoverRef}
          className="cut-transcript-selection"
          role="toolbar"
          aria-label="划词操作"
          aria-live="polite"
          aria-atomic="true"
          data-cut-transcript-selection="true"
          style={selectionPosition
            ? { left: `${selectionPosition.x}px`, top: `${selectionPosition.y}px` }
            : { visibility: "hidden" }}
        >
          <span>{selectedWords.length} 个词</span>
          {restoreError && <span className="cut-transcript-selection__error" role="alert">{restoreError}</span>}
          <button
              type="button"
              className={selectionIsCut ? "is-restore" : "is-delete"}
              disabled={restorePending || Boolean(editingLockReason) && editList.document?.mode !== "manual"}
              title={selectionIsCut && editList.document?.mode === "manual"
                ? "恢复已删除的文稿范围"
                : editingLockReason ?? undefined}
              onClick={() => {
                void applyRange(selectionRange).then((saved) => {
                  if (saved) dismissSelection();
                });
              }}
            >
              {restorePending ? selectionIsCut ? "恢复中…" : "删除中…" : selectionIsCut ? "恢复" : "删除"}
            </button>
        </div>
      )}

      <div
        ref={transcriptRef}
        className="cut-transcript-pane__body"
        aria-label="逐词转录"
        aria-busy={transcriptLoading || selectionLoading || editList.loading}
        data-cut-transcript-scroll-owner="true"
        data-cut-transcript-gesture="scroll-y-select-x"
        onScroll={handleTranscriptScroll}
      >
        {transcriptLoading && visibleTranscriptCues.length === 0 && (
          <p className="cut-transcript-empty">正在读取逐词转录…</p>
        )}
        {!transcriptLoading && visibleTranscriptCues.length === 0 && (
          <p className="cut-transcript-empty">暂无逐词转录，不能用字幕或占位内容代替。</p>
        )}
        {visibleTranscriptCues.map((cue, cueOffset) => (
          <KouboTranscriptCue
            key={cue.id}
            cue={cue}
            cueIndex={cueOffset + 1}
            displayedCutWordIds={displayedCutWordIds}
            selectionRange={selectionRange}
            keyboardAnchorWordId={keyboardAnchorWordId}
            virtualRemovedWordIds={virtualRemovedWordIds}
            hideGaps={virtualTranscript}
            manualMode={editList.document?.mode === "manual"}
            editingLockReason={editingLockReason}
            onWordPointerDown={handleWordPointerDown}
            onWordKeyDown={handleWordKeyDown}
          />
        ))}
      </div>
    </section>
  );
});
