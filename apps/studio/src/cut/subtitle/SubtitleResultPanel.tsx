import { useEffect, useRef, useState } from "react";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";

/** Provenance is evidence, not a claim that a Skill is installed or loaded. */
export function SubtitleResultPanel({ subtitles }: { subtitles: ProjectSubtitles }) {
  const state = subtitles.resultState;
  const [note, setNote] = useState("");
  const submitted = useRef<{ text: string; revision: string } | null>(null);
  useEffect(() => {
    // A failed submission is not acknowledged by an unrelated later save.
    // Keep the note copyable, but forget that failed attempt's revision.
    if (subtitles.saveState === "error" || subtitles.saveState === "conflict") {
      submitted.current = null;
      return;
    }
    if (subtitles.saveState === "saved" && submitted.current && subtitles.revision !== submitted.current.revision) {
      const text = submitted.current.text;
      setNote(current => current === text ? "" : current);
      submitted.current = null;
    }
  }, [subtitles.saveState, subtitles.revision]);
  useEffect(() => {
    if (!note.trim()) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [note]);
  if (!state || state.status === "missing") return null;
  const generator = typeof state.provenance?.generator === "string" ? state.provenance.generator : "Skill 结果";
  const changed = state.changedSources.map(source => source === "edit-list" ? "剪辑时间线" : "转录").join("、");
  const busy = subtitles.saveState === "saving";
  const blocked = subtitles.loading || busy || subtitles.saveState === "conflict" || subtitles.saveState === "error";
  return <details className="cf-subtitle-result" data-testid="subtitle-result" data-status={state.status}>
    <summary>
      {state.status === "legacy" ? "审核意见" : state.sourceStale ? `${changed}已变更 · 需要复核` : "来源版本已绑定"}
      {state.status !== "legacy" && <span> · {subtitles.revision.slice(0, 8)}</span>}
    </summary>
    <div className="cf-subtitle-result__body">
      {state.status !== "legacy" && <><p title={generator}>生成来源：{generator}</p>
          <p>转录 {state.sources?.transcriptSha256.slice(0, 8)} · 剪辑 {state.sources?.editListSha256.slice(0, 8)}</p>
          {state.sourceStale && <p role="status">源版本与生成时不同。当前播放时码仍按现有时间线计算，请将审核意见交回 Skill 后重新生成。</p>}</>}
      <p>已记录 {state.review.editCount} 次审核修改、{state.review.noteCount} 条意见。意见不会自动改动画或字幕。</p>
      {subtitles.addReviewNote && <form onSubmit={event => {
        event.preventDefault();
        if (blocked || submitted.current || !note.trim()) return;
        submitted.current = { text: note, revision: subtitles.revision };
        subtitles.addReviewNote?.(note.trim());
      }}>
        <label htmlFor="subtitle-review-note">交给 Skill 的审核意见</label>
        <textarea id="subtitle-review-note" value={note} maxLength={2000} rows={2}
          placeholder="例如：保留专名修正，下一轮调整分屏。"
          onChange={event => setNote(event.currentTarget.value)} />
        <button type="submit" disabled={blocked || !note.trim()}>保存审核意见</button>
      </form>}
    </div>
  </details>;
}
