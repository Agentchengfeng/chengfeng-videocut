import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from "@video-workbench/core";
import { subscribeProjectFileChanges } from "../product/projectEvents";
import { readStudioFileChangePath } from "./editor/manualEdits";
import {
  getProjectSubtitles,
  putProjectSubtitles,
  SubtitlesApiError,
  type SubtitleResource,
  type SubtitleStaleCue,
} from "./subtitlesApi";
import type { SubtitleCueTiming } from "@video-workbench/core";

export type SubtitleSaveState = "idle" | "saving" | "saved" | "error" | "conflict";

/**
 * How long typing settles before it is written.
 *
 * Subtitle text is edited a character at a time; saving each keystroke would
 * put a revision conflict between the person and their own next keystroke.
 */
const TYPING_SETTLE_MS = 600;

function readFileChangeProjectId(payload: unknown): string | null {
  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value.startsWith("{")) return null;
    try {
      return readFileChangeProjectId(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.projectId === "string") return record.projectId;
  return "data" in record ? readFileChangeProjectId(record.data) : null;
}

/**
 * True for a change to something the subtitle surface displays.
 *
 * That is three files, not one: the cues themselves, and — because timing and
 * staleness are derived, never stored — the transcript and the cut they are
 * derived from. Watching only `subtitles.json` would leave the staleness notice
 * showing the answer from before the person's last cut.
 */
function affectsSubtitles(payload: unknown, projectId: string): boolean {
  if (readFileChangeProjectId(payload) !== projectId) return false;
  const path = readStudioFileChangePath(payload);
  if (!path) return false;
  const name = path.split("/").pop();
  return name === "subtitles.json" || name === "edit-list.json" || name === "transcript.json";
}

function freeCueId(cues: readonly SubtitleCue[], base: string): string {
  const taken = new Set(cues.map((cue) => cue.id));
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ProjectSubtitles {
  projectId: string;
  document: SubtitleDocument | null;
  revision: string;
  timings: SubtitleCueTiming[];
  /** Screens the cut broke. Empty when nothing did. */
  stale: SubtitleStaleCue[];
  loading: boolean;
  /** True once the server has answered at least once. */
  ready: boolean;
  saveState: SubtitleSaveState;
  error: string | null;
  reload: () => Promise<void>;
  /** Replace the whole document. Text edits settle before writing. */
  save: (next: SubtitleDocument, options?: { immediate?: boolean }) => void;
  setCueText: (cueId: string, text: string) => void;
  /** One look for the whole document. There is deliberately no per-screen style. */
  setStyle: (style: SubtitleStyle) => void;
  /**
   * Move this screen's words onto the end of the one before it.
   *
   * Returns where the join happened — the surviving screen and the text offset
   * of the seam — so the caller can put the caret there. Merging is a text
   * edit (backspace across a screen break), and a text edit that loses the
   * caret breaks the illusion that the list is one document.
   */
  mergeWithPrevious: (cueId: string) => { cueId: string; offset: number } | null;
  /**
   * Break this screen in two. The text splits exactly at `textOffset` — the
   * caret, which is where the person pressed Enter — and the words split at
   * `wordIndex`. They are separate numbers because the text is the person's
   * own writing: its character positions stopped corresponding to word
   * boundaries the moment it was edited, and one word ("Codex") can be many
   * characters. Returns the id of the new second screen.
   */
  splitAt: (
    cueId: string,
    at: { wordIndex: number; textOffset: number },
  ) => string | null;
}

export function useProjectSubtitles(projectId: string): ProjectSubtitles {
  const [document, setDocument] = useState<SubtitleDocument | null>(null);
  const [revision, setRevision] = useState("none");
  const [timings, setTimings] = useState<SubtitleCueTiming[]>([]);
  const [stale, setStale] = useState<SubtitleStaleCue[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SubtitleSaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const loadEpochRef = useRef(0);
  const revisionRef = useRef("none");
  const documentRef = useRef<SubtitleDocument | null>(null);
  const pendingSavesRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const applyResource = useCallback((resource: SubtitleResource) => {
    revisionRef.current = resource.revision;
    documentRef.current = resource.document;
    setRevision(resource.revision);
    setDocument(resource.document);
    setTimings(resource.timings);
    setStale(resource.stale);
  }, []);

  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    try {
      const resource = await getProjectSubtitles(projectId);
      if (loadEpochRef.current !== epoch) return;
      applyResource(resource);
      setError(null);
      setReady(true);
    } catch (cause) {
      if (loadEpochRef.current !== epoch) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setReady(false);
    } finally {
      if (loadEpochRef.current === epoch) setLoading(false);
    }
  }, [applyResource, projectId]);

  const reload = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  useEffect(() => {
    loadEpochRef.current += 1;
    revisionRef.current = "none";
    documentRef.current = null;
    pendingSavesRef.current = 0;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setDocument(null);
    setRevision("none");
    setTimings([]);
    setStale([]);
    setReady(false);
    setSaveState("idle");
    setError(null);
    setLoading(true);
    void load();
    return () => {
      loadEpochRef.current += 1;
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    return subscribeProjectFileChanges((payload) => {
      // Our own write comes back through the watcher while it is still
      // in flight. The response already carries the canonical revision, and
      // reloading here would drop whatever the person typed since.
      if (pendingSavesRef.current > 0) return;
      if (!affectsSubtitles(payload, projectId)) return;
      void load();
    });
  }, [load, projectId]);

  const commit = useCallback((next: SubtitleDocument) => {
    pendingSavesRef.current += 1;
    setSaveState("saving");
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const resource = await putProjectSubtitles(projectId, revisionRef.current, next);
          applyResource(resource);
          setSaveState("saved");
          setError(null);
        } catch (cause) {
          const conflict = cause instanceof SubtitlesApiError
            && cause.code === "revision_conflict";
          setSaveState(conflict ? "conflict" : "error");
          setError(cause instanceof Error ? cause.message : String(cause));
          // Someone else wrote it. Show theirs rather than silently keeping a
          // local copy that can never be saved.
          if (conflict) await load();
        } finally {
          pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        }
      });
  }, [applyResource, load, projectId]);

  const save = useCallback((next: SubtitleDocument, options: { immediate?: boolean } = {}) => {
    documentRef.current = next;
    setDocument(next);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    if (options.immediate) {
      settleTimerRef.current = null;
      commit(next);
      return;
    }
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      const latest = documentRef.current;
      if (latest) commit(latest);
    }, TYPING_SETTLE_MS);
  }, [commit]);

  const withCues = useCallback((build: (cues: SubtitleCue[]) => SubtitleCue[] | null) => {
    const current = documentRef.current;
    if (!current) return null;
    const cues = build([...current.cues]);
    if (!cues) return null;
    return { ...current, cues };
  }, []);

  const setCueText = useCallback((cueId: string, text: string) => {
    const next = withCues((cues) =>
      cues.map((cue) => (cue.id === cueId ? { ...cue, text } : cue)));
    if (next) save(next);
  }, [save, withCues]);

  const setStyle = useCallback((style: SubtitleStyle) => {
    const current = documentRef.current;
    if (!current) return;
    save({ ...current, style }, { immediate: true });
  }, [save]);

  const mergeWithPrevious = useCallback((cueId: string) => {
    let seam: { cueId: string; offset: number } | null = null;
    const next = withCues((cues) => {
      const index = cues.findIndex((cue) => cue.id === cueId);
      if (index <= 0) return null;
      const previous = cues[index - 1] as SubtitleCue;
      const current = cues[index] as SubtitleCue;
      seam = { cueId: previous.id, offset: previous.text.length };
      const merged: SubtitleCue = {
        ...previous,
        wordIds: [...previous.wordIds, ...current.wordIds],
        // Joined the way the two screens read, not the way the words tokenise:
        // the person may have typed punctuation into either half.
        text: `${previous.text}${current.text}`,
      };
      return [...cues.slice(0, index - 1), merged, ...cues.slice(index + 1)];
    });
    if (!next) return null;
    save(next, { immediate: true });
    return seam;
  }, [save, withCues]);

  const splitAt = useCallback((
    cueId: string,
    at: { wordIndex: number; textOffset: number },
  ) => {
    let created: string | null = null;
    const next = withCues((cues) => {
      const index = cues.findIndex((cue) => cue.id === cueId);
      if (index < 0) return null;
      const current = cues[index] as SubtitleCue;
      // A break at the very edge produces a screen with nothing on it — either
      // no text to display or no words to give it a time. Refuse both.
      if (at.wordIndex <= 0 || at.wordIndex >= current.wordIds.length) return null;
      if (at.textOffset <= 0 || at.textOffset >= current.text.length) return null;
      const left: SubtitleCue = {
        ...current,
        wordIds: current.wordIds.slice(0, at.wordIndex),
        text: current.text.slice(0, at.textOffset),
      };
      const right: SubtitleCue = {
        ...current,
        // A duplicate cue id is refused on save, and splitting the same screen
        // twice would produce one. Take the first suffix nobody holds.
        id: freeCueId(cues, current.id),
        wordIds: current.wordIds.slice(at.wordIndex),
        text: current.text.slice(at.textOffset),
      };
      created = right.id;
      return [...cues.slice(0, index), left, right, ...cues.slice(index + 1)];
    });
    if (!next) return null;
    save(next, { immediate: true });
    return created;
  }, [save, withCues]);

  // Stable while nothing changed. The subtitle list is memoized on this object,
  // and a fresh one every render would re-render every row on every playback
  // frame — the same fault the transcript pane already had to be protected from.
  return useMemo(() => ({
    projectId,
    document,
    revision,
    timings,
    stale,
    loading,
    ready,
    saveState,
    error,
    reload,
    save,
    setCueText,
    setStyle,
    mergeWithPrevious,
    splitAt,
  }), [
    document,
    error,
    loading,
    mergeWithPrevious,
    projectId,
    ready,
    reload,
    revision,
    save,
    saveState,
    setCueText,
    setStyle,
    splitAt,
    stale,
    timings,
  ]);
}
