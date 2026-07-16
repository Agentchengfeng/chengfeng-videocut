import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { RotateCcw, Scissors, X } from "../icons/SystemIcons";
import { usePlayerStore } from "../player";
import {
  buildTranscriptDisplayCues,
  buildCutTimeRanges,
  KOU_BO_TRANSCRIPT_COPY,
  resolveCutPlaybackSkipTarget,
  toggleTranscriptCutRange,
  type TranscriptCue,
  type TranscriptDisplayWord,
  type TranscriptWord,
} from "./kouboTranscript";
import type { CutSaveState } from "./useProjectCutSelection";

interface KouboTranscriptPanelProps {
  cues: TranscriptCue[];
  loading: boolean;
  cutWordIds: ReadonlySet<string>;
  saveState: CutSaveState;
  onCutWordIdsChange: (next: ReadonlySet<string>) => void;
  playheadTime: number;
  duration: number;
  requestSeek: (time: number, options?: { keepPlaying?: boolean }) => void;
}

interface IndexedCue extends TranscriptCue {
  indexedWords: Array<{
    index: number;
    endIndex: number;
    word: TranscriptDisplayWord;
  }>;
}

interface WordRange {
  start: number;
  end: number;
}

interface PopoverPosition {
  x: number;
  y: number;
}

function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, "0")}.${tenths}`;
}

function indexCues(
  cues: TranscriptCue[],
  cutWordIds: ReadonlySet<string>,
): { indexedCues: IndexedCue[]; words: TranscriptWord[] } {
  const words = cues.flatMap((cue) => cue.words);
  const indexByWordId = new Map(words.map((word, index) => [word.id, index] as const));
  const indexedCues = buildTranscriptDisplayCues(cues, cutWordIds).map((cue) => ({
    ...cue,
    indexedWords: cue.words.map((word) => {
      const indexes = word.sourceWordIds
        .map((wordId) => indexByWordId.get(wordId))
        .filter((index): index is number => index !== undefined);
      return {
        index: indexes[0] ?? 0,
        endIndex: indexes.at(-1) ?? indexes[0] ?? 0,
        word,
      };
    }),
  }));
  return { indexedCues, words };
}

function isWithinRange(start: number, end: number, range: WordRange | null): boolean {
  if (!range) return false;
  const rangeStart = Math.min(range.start, range.end);
  const rangeEnd = Math.max(range.start, range.end);
  return start <= rangeEnd && end >= rangeStart;
}

function popoverPosition(range: WordRange, event: PointerEvent): PopoverPosition {
  const width = 126;
  const height = 38;
  const anchorIndex = Math.max(range.start, range.end);
  const anchor = document.querySelector<HTMLElement>(
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
  const x = right + width <= window.innerWidth - 8
    ? right
    : Math.max(8, rect.left - width - 8);
  const y = Math.max(
    8,
    Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - 8),
  );
  return { x, y };
}

export function KouboTranscriptPanel({
  cues,
  loading,
  cutWordIds,
  saveState,
  onCutWordIdsChange,
  playheadTime,
  duration,
  requestSeek,
}: KouboTranscriptPanelProps) {
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const [selectionRange, setSelectionRange] = useState<WordRange | null>(null);
  const [popover, setPopover] = useState<PopoverPosition | null>(null);
  const dragRef = useRef<{
    start: number;
    end: number;
    last: number;
    moved: boolean;
    originX: number;
    originY: number;
    shiftKey: boolean;
  } | null>(null);
  const wordsRef = useRef<TranscriptWord[]>([]);
  const cutWordIdsRef = useRef<Set<string>>(new Set());
  const lastSkippedRangeRef = useRef<string | null>(null);

  const { indexedCues, words } = useMemo(
    () => indexCues(cues, cutWordIds),
    [cues, cutWordIds],
  );
  const cutTimeRanges = useMemo(
    () => buildCutTimeRanges(words, cutWordIds),
    [cutWordIds, words],
  );
  wordsRef.current = words;
  cutWordIdsRef.current = new Set(cutWordIds);

  useEffect(() => {
    const updateDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const travel = Math.hypot(
        event.clientX - drag.originX,
        event.clientY - drag.originY,
      );
      if (travel >= 4) drag.moved = true;

      const target = document.elementFromPoint(event.clientX, event.clientY);
      const wordElement = target instanceof Element
        ? target.closest<HTMLElement>("[data-word-start-index]")
        : null;
      const nextStart = Number(wordElement?.dataset.wordStartIndex);
      const nextEnd = Number(wordElement?.dataset.wordEndIndex);
      if (!Number.isInteger(nextStart) || !Number.isInteger(nextEnd)) return;
      const backwards = nextEnd < drag.start;
      drag.last = backwards ? nextStart : nextEnd;
      drag.moved = drag.moved || nextStart !== drag.start || nextEnd !== drag.end;
      if (drag.moved) {
        setSelectionRange({
          start: backwards ? drag.end : drag.start,
          end: drag.last,
        });
      }
    };
    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (!drag.moved) {
        const word = wordsRef.current[drag.start];
        setSelectionRange(null);
        setPopover(null);
        if (drag.shiftKey) {
          const nextCut = toggleTranscriptCutRange(
            wordsRef.current,
            cutWordIdsRef.current,
            drag.start,
            drag.end,
          );
          cutWordIdsRef.current = nextCut;
          onCutWordIdsChange(nextCut);
          return;
        }
        if (word) requestSeek(word.start);
        return;
      }
      const range = {
        start: drag.last < drag.start ? drag.end : drag.start,
        end: drag.last,
      };
      setSelectionRange(range);
      setPopover(popoverPosition(range, event));
    };
    const cancelDrag = () => {
      dragRef.current = null;
      setSelectionRange(null);
      setPopover(null);
    };
    document.addEventListener("pointermove", updateDrag);
    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", cancelDrag);
    return () => {
      document.removeEventListener("pointermove", updateDrag);
      document.removeEventListener("pointerup", finishDrag);
      document.removeEventListener("pointercancel", cancelDrag);
    };
  }, [onCutWordIdsChange, requestSeek]);

  useEffect(() => {
    if (!isPlaying) {
      lastSkippedRangeRef.current = null;
      return;
    }
    const activeRange = cutTimeRanges.find(
      (range) => playheadTime >= range.start && playheadTime < range.end,
    );
    if (!activeRange) {
      lastSkippedRangeRef.current = null;
      return;
    }
    const rangeKey = `${activeRange.start}:${activeRange.end}`;
    if (lastSkippedRangeRef.current === rangeKey) return;
    lastSkippedRangeRef.current = rangeKey;
    requestSeek(resolveCutPlaybackSkipTarget(activeRange, duration), {
      keepPlaying: true,
    });
  }, [cutTimeRanges, duration, isPlaying, playheadTime, requestSeek]);

  useEffect(() => {
    if (!popover) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cf-cut-popover")) return;
      setSelectionRange(null);
      setPopover(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectionRange(null);
      setPopover(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popover]);

  const selectedRangeWords = selectionRange
    ? words.slice(
        Math.min(selectionRange.start, selectionRange.end),
        Math.max(selectionRange.start, selectionRange.end) + 1,
      )
    : [];
  const selectionIsCut =
    selectedRangeWords.length > 0 &&
    selectedRangeWords.every((word) => cutWordIds.has(word.id));

  const applySelection = () => {
    if (!selectionRange) return;
    const nextCut = new Set(cutWordIdsRef.current);
    for (const word of selectedRangeWords) {
      if (selectionIsCut) nextCut.delete(word.id);
      else nextCut.add(word.id);
    }
    cutWordIdsRef.current = nextCut;
    setSelectionRange(null);
    setPopover(null);
    onCutWordIdsChange(nextCut);
  };

  const handleWordPointerDown = (
    startIndex: number,
    endIndex: number,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      start: startIndex,
      end: endIndex,
      last: endIndex,
      moved: false,
      originX: event.clientX,
      originY: event.clientY,
      shiftKey: event.shiftKey,
    };
    setSelectionRange(null);
    setPopover(null);
  };

  const handleWordPointerEnter = (
    startIndex: number,
    endIndex: number,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => {
    const drag = dragRef.current;
    if (!drag || event.buttons !== 1) return;
    const backwards = endIndex < drag.start;
    drag.last = backwards ? startIndex : endIndex;
    drag.moved = drag.moved || startIndex !== drag.start || endIndex !== drag.end;
    if (drag.moved) {
      setSelectionRange({
        start: backwards ? drag.end : drag.start,
        end: drag.last,
      });
    }
  };

  const cutDuration = cutTimeRanges.reduce(
    (total, range) => total + range.end - range.start,
    0,
  );
  return (
    <section className="cf-cut-transcript" aria-label={KOU_BO_TRANSCRIPT_COPY.sectionLabel}>
      <div
        className="cf-cut-transcript-list"
        onScroll={() => {
          setSelectionRange(null);
          setPopover(null);
        }}
      >
        {loading ? (
          <div className="cf-task-empty">{KOU_BO_TRANSCRIPT_COPY.loading}</div>
        ) : indexedCues.length === 0 ? (
          <div className="cf-task-empty">{KOU_BO_TRANSCRIPT_COPY.empty}</div>
        ) : (
          indexedCues.map((cue, cueIndex) => {
            const active = playheadTime >= cue.start && playheadTime < cue.end;
            return (
              <article
                key={cue.id}
                className={`cf-cut-cue${active ? " is-active" : ""}`}
                data-cue-id={cue.id}
              >
                <button
                  type="button"
                  className="cf-cut-cue-time"
                  onClick={() => requestSeek(cue.start)}
                  title="定位到这句"
                >
                  <span>{String(cueIndex + 1).padStart(2, "0")}</span>
                  <strong>{formatTimestamp(cue.start)}</strong>
                </button>
                <p className="cf-cut-cue-words">
                  {cue.indexedWords.map(({ index, endIndex, word }) => {
                    const cut = word.sourceWordIds.every((wordId) => cutWordIds.has(wordId));
                    const pending = isWithinRange(index, endIndex, selectionRange);
                    const classes = [
                      "cf-cut-word",
                      word.isGap ? "is-gap" : "",
                      cut ? "is-cut-selected" : "",
                      pending ? "is-pending-selection" : "",
                      playheadTime >= word.start && playheadTime < word.end ? "is-current" : "",
                    ].filter(Boolean).join(" ");
                    return (
                      <span
                        key={word.id}
                        className={classes}
                        data-word-id={word.id}
                        data-word-start-index={index}
                        data-word-end-index={endIndex}
                        onPointerDown={(event) => handleWordPointerDown(index, endIndex, event)}
                        onPointerEnter={(event) => handleWordPointerEnter(index, endIndex, event)}
                      >
                        {word.isGap
                          ? `静音 ${(word.end - word.start).toFixed(1)}s`
                          : word.text}
                      </span>
                    );
                  })}
                </p>
              </article>
            );
          })
        )}
      </div>

      <footer className="cf-cut-transcript-footer">
        <span>
          已删除 <strong>{cutTimeRanges.length} 段</strong>
          {" · "}<strong>{cutDuration.toFixed(1)}s</strong>
        </span>
        <span>
          {saveState === "saving" && "保存中"}
          {saveState === "saved" && "已保存"}
          {saveState === "error" && "保存失败"}
          {saveState === "conflict" && "检测到其他修改，已重新载入"}
          {saveState === "idle" && formatTimestamp(Math.max(0, duration - cutDuration))}
        </span>
      </footer>

      {popover && selectionRange &&
        createPortal(
          <div
            className="cf-cut-popover"
            style={{ left: popover.x, top: popover.y }}
            role="toolbar"
            aria-label={KOU_BO_TRANSCRIPT_COPY.selectionActionsLabel}
            data-testid="cut-selection-popover"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className={selectionIsCut ? "is-restore" : "is-danger"}
              onClick={applySelection}
            >
              {selectionIsCut ? <RotateCcw size={14} /> : <Scissors size={14} />}
              <span>{selectionIsCut ? "恢复" : "删除"}</span>
            </button>
            <button
              type="button"
              className="cf-cut-popover-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => {
                setSelectionRange(null);
                setPopover(null);
              }}
            >
              <X size={13} />
            </button>
          </div>,
          document.body,
        )}
    </section>
  );
}
