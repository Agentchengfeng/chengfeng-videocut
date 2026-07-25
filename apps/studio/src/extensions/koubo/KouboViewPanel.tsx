import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { liveTime, usePlayerStore } from "../../player";
import type { EditListDocument } from "@video-workbench/core";
import {
  deriveActualCutWordIds,
  requestEditListPlaybackTransition,
  resolveSourcePlayheadTime,
  resolveTranscriptSeekTime,
} from "../../components/editListPlayback";
import { useProjectCutSelection } from "../../components/useProjectCutSelection";
import { useProjectEditList } from "../../components/useProjectEditList";
import {
  buildManagedTimelineSegments,
  formatKouboTime,
  indexKouboTranscript,
  isSameKouboActiveTranscriptPosition,
  isKouboWordInRange,
  resolveKouboActiveTranscriptPosition,
  resolveKouboEditingLockReason,
  updateKouboCutSelection,
  type KouboActiveTranscriptPosition,
  type KouboTimelineElement,
  type KouboWordRange,
} from "./kouboViewModel";
import { useKouboTranscript } from "./useKouboTranscript";
import "./koubo.css";

export interface KouboViewPanelProps {
  projectId: string;
  active: boolean;
}

interface PopoverPosition {
  x: number;
  y: number;
}

interface DragState {
  start: number;
  end: number;
  last: number;
  moved: boolean;
  originX: number;
  originY: number;
  shiftKey: boolean;
}

type PendingPlaybackTransition = Omit<
  Parameters<typeof requestEditListPlaybackTransition>[0],
  "newEditList"
>;

function popoverPosition(
  root: HTMLElement | null,
  range: KouboWordRange,
  event: PointerEvent,
): PopoverPosition {
  const width = 74;
  const height = 34;
  const anchorIndex = Math.max(range.start, range.end);
  const anchor = root?.querySelector<HTMLElement>(
    `[data-word-start-index="${anchorIndex}"], [data-word-end-index="${anchorIndex}"]`,
  );
  const rect = anchor?.getBoundingClientRect();
  if (!rect) {
    return {
      x: Math.max(8, Math.min(event.clientX + 8, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY - height / 2, window.innerHeight - height - 8)),
    };
  }
  const right = rect.right + 8;
  return {
    x: right + width <= window.innerWidth - 8
      ? right
      : Math.max(8, rect.left - width - 8),
    y: Math.max(
      8,
      Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - 8),
    ),
  };
}

function saveStatusLabel(saveState: ReturnType<typeof useProjectCutSelection>["saveState"]): string {
  if (saveState === "saving") return "保存中";
  if (saveState === "saved") return "已保存";
  if (saveState === "error") return "保存失败";
  if (saveState === "conflict") return "检测到其他修改，已重新载入";
  return "";
}

export function KouboViewPanel({ projectId, active }: KouboViewPanelProps) {
  const requestSeek = usePlayerStore((state) => state.requestSeek) as (
    time: number,
    options?: { keepPlaying?: boolean },
  ) => void;
  const timelineElements = usePlayerStore(
    (state) => state.elements,
  ) as unknown as readonly KouboTimelineElement[];
  const [selectionRange, setSelectionRange] = useState<KouboWordRange | null>(null);
  const [popover, setPopover] = useState<PopoverPosition | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const liveTimelineTimeRef = useRef(usePlayerStore.getState().currentTime);
  const editListDocumentRef = useRef<EditListDocument | null>(null);
  const pendingPlaybackTransitionRef = useRef<PendingPlaybackTransition | null>(null);

  const handleEditListDocumentChange = useCallback((newEditList: EditListDocument) => {
    editListDocumentRef.current = newEditList;
    const pending = pendingPlaybackTransitionRef.current;
    if (!pending) return;
    pendingPlaybackTransitionRef.current = null;
    requestEditListPlaybackTransition({
      ...pending,
      newEditList,
    }, requestSeek);
  }, [requestSeek]);

  const { cues, loading: transcriptLoading, error: transcriptError } =
    useKouboTranscript(projectId);
  const {
    cutWordIds,
    saveState,
    selectionLoading,
    selectionReady,
    updateCutWordIds,
  } = useProjectCutSelection(projectId, cues);
  const editList = useProjectEditList(projectId, {
    onDocumentChange: handleEditListDocumentChange,
  });
  editListDocumentRef.current = editList.document;

  const managedTimelineSegments = useMemo(
    () => buildManagedTimelineSegments(timelineElements),
    [timelineElements],
  );
  const sourceWords = useMemo(() => cues.flatMap((cue) => cue.words), [cues]);
  const displayedCutWordIds = useMemo(
    () => deriveActualCutWordIds(
      sourceWords,
      cutWordIds,
      editList.document,
      managedTimelineSegments,
    ),
    [cutWordIds, editList.document, managedTimelineSegments, sourceWords],
  );
  const indexedTranscript = useMemo(
    () => indexKouboTranscript(cues, displayedCutWordIds),
    [cues, displayedCutWordIds],
  );
  const [activeTranscript, setActiveTranscript] =
    useState<KouboActiveTranscriptPosition>({ cueId: null, wordId: null });
  const activeTranscriptRef = useRef(activeTranscript);
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
  const managedTimelineSegmentsRef = useRef(managedTimelineSegments);
  wordsRef.current = indexedTranscript.words;
  cutWordIdsRef.current = new Set(cutWordIds);
  displayedCutWordIdsRef.current = new Set(displayedCutWordIds);
  editingLockReasonRef.current = editingLockReason;
  managedTimelineSegmentsRef.current = managedTimelineSegments;

  useEffect(() => {
    pendingPlaybackTransitionRef.current = null;
    liveTimelineTimeRef.current = usePlayerStore.getState().currentTime;
  }, [projectId]);

  useEffect(() => {
    if (saveState === "error" || saveState === "conflict") {
      pendingPlaybackTransitionRef.current = null;
    }
  }, [saveState]);

  useEffect(() => {
    if (!active) return;
    const updateActiveTranscript = (timelineTime: number) => {
      liveTimelineTimeRef.current = timelineTime;
      const sourceTime = resolveSourcePlayheadTime(
        editList.document,
        timelineTime,
        managedTimelineSegments,
      );
      const next = resolveKouboActiveTranscriptPosition(
        indexedTranscript.cues,
        sourceTime,
      );
      if (isSameKouboActiveTranscriptPosition(activeTranscriptRef.current, next)) return;
      activeTranscriptRef.current = next;
      setActiveTranscript(next);
    };

    updateActiveTranscript(usePlayerStore.getState().currentTime);
    const unsubscribe = liveTime.subscribe(updateActiveTranscript);
    return () => {
      unsubscribe();
    };
  }, [
    active,
    editList.document,
    indexedTranscript.cues,
    managedTimelineSegments,
    projectId,
  ]);

  const seekSourceTime = useCallback(
    (sourceTime: number) => {
      requestSeek(resolveTranscriptSeekTime(
        editList.document,
        sourceTime,
        managedTimelineSegments,
      ));
    },
    [editList.document, managedTimelineSegments, requestSeek],
  );

  const applyRange = useCallback((range: KouboWordRange) => {
    if (editingLockReasonRef.current) return;
    const next = updateKouboCutSelection(
      wordsRef.current,
      cutWordIdsRef.current,
      displayedCutWordIdsRef.current,
      range,
    );
    pendingPlaybackTransitionRef.current = {
      oldEditList: editListDocumentRef.current,
      managedSegments: managedTimelineSegmentsRef.current,
      currentTimelineTime: liveTimelineTimeRef.current,
      wasPlaying: usePlayerStore.getState().isPlaying,
    };
    cutWordIdsRef.current = next;
    updateCutWordIds(next);
  }, [updateCutWordIds]);

  const dismissSelection = useCallback(() => {
    dragRef.current = null;
    setSelectionRange(null);
    setPopover(null);
  }, []);

  useEffect(() => {
    const wordRangeAtPoint = (event: PointerEvent): KouboWordRange | null => {
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
      if (!drag.moved && Math.hypot(
        event.clientX - drag.originX,
        event.clientY - drag.originY,
      ) >= 4) drag.moved = true;
      if (!drag.moved) return;
      const endpoint = wordRangeAtPoint(event);
      if (!endpoint) return;
      const backwards = endpoint.end < drag.start;
      drag.last = backwards ? endpoint.start : endpoint.end;
      setSelectionRange({
        start: backwards ? drag.end : drag.start,
        end: drag.last,
      });
      setPopover(null);
    };

    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (!drag.moved) {
        setSelectionRange(null);
        setPopover(null);
        if (drag.shiftKey) {
          applyRange({ start: drag.start, end: drag.end });
          return;
        }
        const word = wordsRef.current[drag.start];
        if (word) seekSourceTime(word.start);
        return;
      }
      const range = {
        start: drag.last < drag.start ? drag.end : drag.start,
        end: drag.last,
      };
      setSelectionRange(range);
      setPopover(popoverPosition(rootRef.current, range, event));
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
  }, [applyRange, dismissSelection, seekSourceTime]);

  useEffect(() => {
    if (!popover) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cf-koubo-popover")) return;
      dismissSelection();
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissSelection();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [dismissSelection, popover]);

  const selectedRangeWords = selectionRange
    ? indexedTranscript.words.slice(
        Math.min(selectionRange.start, selectionRange.end),
        Math.max(selectionRange.start, selectionRange.end) + 1,
      )
    : [];
  const selectionIsCut = selectedRangeWords.length > 0 &&
    selectedRangeWords.every((word) => displayedCutWordIds.has(word.id));
  const saveStatus = saveStatusLabel(saveState);

  const keyboardAnchor = useMemo(() => {
    let firstVisible: string | null = null;
    const visibleWordIds = new Set<string>();
    for (const cue of indexedTranscript.cues) {
      for (const { word } of cue.words) {
        const cut = word.sourceWordIds.every((wordId) => displayedCutWordIds.has(wordId));
        const gap = Math.max(0, word.end - word.start);
        if (word.isGap && gap < 0.35 && !cut) continue;
        firstVisible ??= word.id;
        visibleWordIds.add(word.id);
      }
    }
    return { firstVisible, visibleWordIds };
  }, [displayedCutWordIds, indexedTranscript.cues]);
  const keyboardAnchorWordId =
    activeTranscript.wordId && keyboardAnchor.visibleWordIds.has(activeTranscript.wordId)
      ? activeTranscript.wordId
      : keyboardAnchor.firstVisible;

  const handleWordKeyDown = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
    range: KouboWordRange,
    sourceTime: number,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.shiftKey) applyRange(range);
      else seekSourceTime(sourceTime);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
      event.key,
    )) return;
    const wordElements = Array.from(
      transcriptRef.current?.querySelectorAll<HTMLElement>("[data-word-id]") ?? [],
    ).filter((element) => element.offsetParent !== null);
    const index = wordElements.indexOf(event.currentTarget);
    if (index < 0 || wordElements.length === 0) return;
    const targetIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? wordElements.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : Math.min(wordElements.length - 1, index + 1);
    event.preventDefault();
    wordElements[targetIndex]?.focus();
  };

  const handleWordPointerDown = (
    start: number,
    end: number,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      start,
      end,
      last: end,
      moved: false,
      originX: event.clientX,
      originY: event.clientY,
      shiftKey: event.shiftKey,
    };
    setSelectionRange(null);
    setPopover(null);
  };

  return (
    <main
      ref={rootRef}
      className="cf-koubo-panel"
      data-studio-extension-view="koubo"
      data-active={active ? "true" : "false"}
    >
      <section className="cf-koubo-editor" aria-label="剪口播逐词审核">
        {editList.document?.mode === "manual" && (
          <div className="cf-koubo-notice is-warning" role="status">
            时间线已手动调整，逐词结果只读。
          </div>
        )}
        {transcriptError && (
          <div className="cf-koubo-notice is-error" role="alert">{transcriptError}</div>
        )}
        {(saveState === "error" || saveState === "conflict") && (
          <div className="cf-koubo-notice is-error" role="alert">{saveStatus}</div>
        )}

        <div
          ref={transcriptRef}
          className="cf-koubo-transcript"
          aria-label="逐词转录"
          aria-busy={transcriptLoading || selectionLoading || editList.loading}
          onScroll={dismissSelection}
        >
          {transcriptLoading && indexedTranscript.cues.length === 0 && (
            <p className="cf-koubo-empty">正在读取逐词转录…</p>
          )}
          {!transcriptLoading && indexedTranscript.cues.length === 0 && (
            <p className="cf-koubo-empty">暂无逐词转录，不能用字幕或占位内容代替。</p>
          )}
          {indexedTranscript.cues.map((cue, cueIndex) => (
            <article
              className={`cf-koubo-cue ${
                activeTranscript.cueId === cue.id
                  ? "is-active"
                  : ""
              }`}
              key={cue.id}
              data-cue-id={cue.id}
            >
              <button
                className="cf-koubo-cue-time"
                type="button"
                onClick={() => seekSourceTime(cue.start)}
                title="定位到这句"
              >
                <span>{String(cueIndex + 1).padStart(2, "0")}</span>
                <strong>{formatKouboTime(cue.start)}</strong>
              </button>
              <p className="cf-koubo-cue-words">
                {cue.words.map(({ word, startIndex, endIndex }) => {
                  const cut = word.sourceWordIds.every((wordId) =>
                    displayedCutWordIds.has(wordId));
                  const activeWord = activeTranscript.wordId === word.id;
                  const pending = isKouboWordInRange(startIndex, endIndex, selectionRange);
                  const gap = Math.max(0, word.end - word.start);
                  if (word.isGap && gap < 0.35 && !cut) return null;
                  return (
                    <span
                      key={word.id}
                      role="button"
                      tabIndex={keyboardAnchorWordId === word.id ? 0 : -1}
                      className={[
                        "cf-koubo-word",
                        word.isGap ? "is-gap" : "",
                        cut ? "is-cut" : "",
                        pending ? "is-pending" : "",
                        activeWord ? "is-current" : "",
                      ].filter(Boolean).join(" ")}
                      data-word-id={word.id}
                      data-word-start-index={startIndex}
                      data-word-end-index={endIndex}
                      aria-pressed={cut}
                      aria-label={word.isGap
                        ? `停顿 ${gap.toFixed(1)} 秒${cut ? "，已删除" : ""}`
                        : undefined}
                      title={editingLockReason ?? "单击定位；拖动划选；Shift 单击删除或恢复"}
                      onPointerDown={(event) => handleWordPointerDown(startIndex, endIndex, event)}
                      onKeyDown={(event) => handleWordKeyDown(
                        event,
                        { start: startIndex, end: endIndex },
                        word.start,
                      )}
                    >
                      {word.isGap ? `静音 ${gap.toFixed(1)}s` : word.text}
                    </span>
                  );
                })}
              </p>
            </article>
          ))}
        </div>

        {(saveState === "saving" || saveState === "saved") && (
          <div className="cf-koubo-save-state" role="status" aria-live="polite">
            {saveStatus}
          </div>
        )}
      </section>

      {popover && selectionRange && createPortal(
        <div
          className="cf-koubo-popover"
          role="toolbar"
          aria-label="划词操作"
          style={{ left: popover.x, top: popover.y }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            className={selectionIsCut ? "is-restore" : "is-delete"}
            disabled={Boolean(editingLockReason)}
            title={editingLockReason ?? undefined}
            onClick={() => {
              applyRange(selectionRange);
              dismissSelection();
            }}
          >
            {selectionIsCut ? "恢复" : "删除"}
          </button>
        </div>,
        document.body,
      )}
    </main>
  );
}
