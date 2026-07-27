import { memo, useMemo, useRef } from "react";
import type { SubtitleCue, SubtitleCueTiming } from "@video-workbench/core";
import type { SubtitleStaleCue } from "../../components/subtitlesApi";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";
import type { TranscriptCue } from "../../components/kouboTranscript";

export interface SubtitlePaneProps {
  subtitles: ProjectSubtitles;
  /** Used only to show which words a screen covers; timing never comes from here. */
  transcriptCues: TranscriptCue[];
  selectedCueId: string | null;
  onSelectCue: (cueId: string | null) => void;
  onSeek: (time: number, options?: { keepPlaying?: boolean }) => void;
}

/**
 * Which word a caret offset falls on.
 *
 * Exact while the text is still the words joined up, which is the case for
 * every screen nobody has retyped. Once it has been edited the two lengths no
 * longer correspond, and the honest answer is the proportional one — the person
 * is looking at the result and can move the break again.
 */
function wordIndexAt(
  words: readonly { text: string }[],
  text: string,
  caret: number,
): number {
  let consumed = 0;
  for (const [index, word] of words.entries()) {
    consumed += word.text.length;
    if (consumed >= caret) return Math.max(1, index + (consumed === caret ? 1 : 0));
  }
  if (consumed === text.length) return words.length;
  const share = text.length > 0 ? caret / text.length : 0;
  return Math.min(words.length - 1, Math.max(1, Math.round(share * words.length)));
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * What is wrong with this screen, in the words a person can act on.
 *
 * Deliberately specific. The product is not allowed to say "subtitles may be
 * out of date" — the whole reason cues are anchored on word ids is so the
 * notice can name what was lost.
 */
function problems(timing: SubtitleCueTiming | undefined, stale: SubtitleStaleCue | undefined) {
  const notes: Array<{ kind: string; label: string }> = [];
  if (stale?.orphaned) notes.push({ kind: "orphaned", label: "这几个字已被剪掉" });
  else if (stale && stale.cutWordIds.length > 0) {
    notes.push({ kind: "cut", label: `剪掉了「${stale.cutText}」` });
  }
  if (stale && stale.missingWordIds.length > 0) {
    notes.push({ kind: "missing", label: "转录里已经没有这几个字" });
  }
  if (timing?.tooFast && !timing.orphaned) notes.push({ kind: "fast", label: "读不完" });
  if (timing?.tooShort && !timing.orphaned) notes.push({ kind: "short", label: "停留太短" });
  return notes;
}

const SubtitleRow = memo(function SubtitleRow({
  cue,
  index,
  timing,
  stale,
  words,
  selected,
  onSelect,
  onSeek,
  onTextChange,
  onMerge,
  onSplit,
}: {
  cue: SubtitleCue;
  index: number;
  timing: SubtitleCueTiming | undefined;
  stale: SubtitleStaleCue | undefined;
  words: Array<{ id: string; text: string }>;
  selected: boolean;
  onSelect: () => void;
  onSeek: () => void;
  onTextChange: (text: string) => void;
  onMerge: () => void;
  onSplit: (at: { wordIndex: number; textOffset: number }) => void;
}) {
  const notes = problems(timing, stale);
  return (
    <li
      className="cf-subtitle-row"
      data-cue-id={cue.id}
      // Owned by SubtitlePlaybackMarker, which sets it imperatively. Declared
      // here so the attribute exists before the first frame arrives.
      data-playing="false"
      data-selected={selected ? "true" : "false"}
      data-problem={notes[0]?.kind ?? "none"}
    >
      <button
        type="button"
        className="cf-subtitle-row__stamp"
        title="跳到这一屏"
        onClick={() => {
          onSelect();
          onSeek();
        }}
      >
        <span className="cf-subtitle-row__index">{index + 1}</span>
        <span className="cf-subtitle-row__time">
          {timing && !timing.orphaned ? formatTime(timing.start) : "—"}
        </span>
      </button>

      <div className="cf-subtitle-row__main">
        <textarea
          className="cf-subtitle-row__text"
          rows={1}
          value={cue.text}
          aria-label={`第 ${index + 1} 屏字幕`}
          onFocus={onSelect}
          onChange={(event) => onTextChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            const field = event.currentTarget;
            const at = field.selectionStart;
            const collapsed = at === field.selectionEnd;
            // Regrouping the screens *is* editing the text, so it is done by
            // editing the text. A row of buttons for it was a second way to say
            // the same thing, and it pushed the actual words down the row.
            if (event.key === "Enter" && !event.shiftKey && collapsed) {
              event.preventDefault();
              // The caret says exactly where the *text* breaks. Which word it
              // falls on has to be worked out, because one word can be several
              // characters and the text may have been rewritten since.
              onSplit({ wordIndex: wordIndexAt(words, cue.text, at), textOffset: at });
              return;
            }
            if (event.key === "Backspace" && collapsed && at === 0 && index > 0) {
              event.preventDefault();
              onMerge();
            }
          }}
        />
        {notes.length > 0 && (
          <p className="cf-subtitle-row__notes">
            {notes.map((note) => (
              <span key={note.kind} data-kind={note.kind}>{note.label}</span>
            ))}
          </p>
        )}
      </div>
    </li>
  );
});

/**
 * The 字幕 tab: one row per screen.
 *
 * This surface may change what is written and how the words are grouped. It may
 * not change *when* anything plays — that belongs to 剪口播, and every time
 * shown here is read back from it rather than stored.
 */
export const SubtitlePane = memo(function SubtitlePane({
  subtitles,
  transcriptCues,
  selectedCueId,
  onSelectCue,
  onSeek,
}: SubtitlePaneProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const wordsById = useMemo(() => {
    const map = new Map<string, { id: string; text: string }>();
    for (const cue of transcriptCues) {
      for (const word of cue.words) map.set(word.id, { id: word.id, text: word.text ?? "" });
    }
    return map;
  }, [transcriptCues]);

  const timingByCue = useMemo(() => {
    const map = new Map<string, SubtitleCueTiming>();
    for (const timing of subtitles.timings) map.set(timing.cueId, timing);
    return map;
  }, [subtitles.timings]);

  const staleByCue = useMemo(() => {
    const map = new Map<string, SubtitleStaleCue>();
    for (const item of subtitles.stale) map.set(item.cueId, item);
    return map;
  }, [subtitles.stale]);

  const document = subtitles.document;

  if (subtitles.loading) {
    return (
      <div className="cf-subtitle-pane" data-testid="subtitle-pane">
        <p className="cf-subtitle-pane__status" role="status">正在读取字幕…</p>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="cf-subtitle-pane" data-testid="subtitle-pane">
        <p className="cf-subtitle-pane__status" role="status">
          还没有字幕。
        </p>
        <p className="cf-subtitle-pane__hint">
          在终端运行 <code>chengfeng-videocut subtitle build {subtitles.projectId}</code>
          {" "}先按剪好的结果分一遍屏，然后回到这里逐屏改字。
        </p>
        {subtitles.error && (
          <p className="cf-subtitle-pane__error" role="alert">{subtitles.error}</p>
        )}
      </div>
    );
  }

  const brokenCount = subtitles.stale.length;

  return (
    <div
      className="cf-subtitle-pane"
      data-testid="subtitle-pane"
      data-cut-subtitle-pane="true"
    >
      <header className="cf-subtitle-pane__header">
        <span>{document.cues.length} 屏</span>
        {brokenCount > 0 && (
          <button
            type="button"
            className="cf-subtitle-pane__jump"
            onClick={() => {
              const first = subtitles.stale[0];
              if (!first) return;
              onSelectCue(first.cueId);
              listRef.current
                ?.querySelector(`[data-cue-id="${CSS.escape(first.cueId)}"]`)
                ?.scrollIntoView({ block: "center" });
            }}
          >
            {brokenCount} 屏被剪辑改动，去看看
          </button>
        )}
        <span className="cf-subtitle-pane__save" data-state={subtitles.saveState}>
          {subtitles.saveState === "saving" && "保存中"}
          {subtitles.saveState === "conflict" && "别处改过了，已重新载入"}
          {subtitles.saveState === "error" && "保存失败"}
        </span>
      </header>

      <ol className="cf-subtitle-pane__list" ref={listRef}>
        {document.cues.map((cue, index) => (
          <SubtitleRow
            key={cue.id}
            cue={cue}
            index={index}
            timing={timingByCue.get(cue.id)}
            stale={staleByCue.get(cue.id)}
            words={cue.wordIds.map((id) => wordsById.get(id) ?? { id, text: "?" })}
            selected={selectedCueId === cue.id}
            onSelect={() => onSelectCue(cue.id)}
            onSeek={() => {
              const timing = timingByCue.get(cue.id);
              if (timing && !timing.orphaned) onSeek(timing.start, { keepPlaying: true });
            }}
            onTextChange={(text) => subtitles.setCueText(cue.id, text)}
            onMerge={() => subtitles.mergeWithPrevious(cue.id)}
            onSplit={(at) => subtitles.splitAt(cue.id, at)}
          />
        ))}
      </ol>
    </div>
  );
});
