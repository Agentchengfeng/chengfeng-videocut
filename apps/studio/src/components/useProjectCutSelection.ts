import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CutSelectionApiError,
  getProjectCutSelection,
  putProjectCutSelection,
} from "./cutSelectionApi";
import { readStudioFileChangePath } from "./editor/manualEdits";
import { type TranscriptCue } from "./kouboTranscript";

export type CutSaveState = "idle" | "saving" | "saved" | "error" | "conflict";

interface CutSelectionPayload {
  cutWordIds?: unknown;
  selectedWordIds?: unknown;
  deletedWordIds?: unknown;
  initialization?: unknown;
  updatedAt?: unknown;
}

function parseCutWordIds(payload: unknown): Set<string> {
  if (!payload || typeof payload !== "object") return new Set();
  const selection = payload as CutSelectionPayload;
  const ids = Array.isArray(selection.cutWordIds)
    ? selection.cutWordIds
    : Array.isArray(selection.selectedWordIds)
      ? selection.selectedWordIds
      : selection.deletedWordIds;
  return new Set(Array.isArray(ids) ? ids.map(String) : []);
}

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

function isCutSelectionFileChange(payload: unknown, projectId: string): boolean {
  const path = readStudioFileChangePath(payload);
  return (
    readFileChangeProjectId(payload) === projectId &&
    (path === "cut-selection.json" || Boolean(path?.endsWith("/cut-selection.json")))
  );
}

export function shouldSyncCutSelectionAfterFileChange(
  payload: unknown,
  projectId: string,
  pendingSaves: number,
): boolean {
  return isCutSelectionFileChange(payload, projectId) && pendingSaves <= 0;
}

export function useProjectCutSelection(
  projectId: string,
  cues: TranscriptCue[],
): {
  cutWordIds: ReadonlySet<string>;
  saveState: CutSaveState;
  selectionLoading: boolean;
  selectionReady: boolean;
  updateCutWordIds: (next: ReadonlySet<string>) => void;
} {
  const [cutWordIds, setCutWordIds] = useState<Set<string>>(() => new Set());
  const [saveState, setSaveState] = useState<CutSaveState>("idle");
  const [selectionLoading, setSelectionLoading] = useState(true);
  const [selectionReady, setSelectionReady] = useState(false);
  const loadRevisionRef = useRef(0);
  const projectEpochRef = useRef(0);
  const saveRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveGenerationRef = useRef(0);
  const pendingSavesRef = useRef(0);
  const serverRevisionRef = useRef("none");
  const selectionDocumentRef = useRef<unknown>(null);
  const selectionReadyRef = useRef(false);

  const words = useMemo(() => cues.flatMap((cue) => cue.words), [cues]);

  const loadSelection = useCallback(async (): Promise<boolean> => {
    const revision = ++loadRevisionRef.current;
    try {
      const resource = await getProjectCutSelection(projectId);
      if (loadRevisionRef.current !== revision) return false;
      serverRevisionRef.current = resource.revision;
      selectionDocumentRef.current = resource.document;
      selectionReadyRef.current = true;
      setSelectionReady(true);
      setCutWordIds(parseCutWordIds(resource.document));
      setSelectionLoading(false);
      return true;
    } catch {
      if (loadRevisionRef.current === revision) {
        selectionReadyRef.current = false;
        setSelectionReady(false);
        setCutWordIds(parseCutWordIds(selectionDocumentRef.current));
        setSelectionLoading(false);
        setSaveState("error");
      }
      return false;
    }
  }, [projectId]);

  const reloadSelection = useCallback((): Promise<boolean> => {
    selectionReadyRef.current = false;
    setSelectionReady(false);
    setSelectionLoading(true);
    return loadSelection();
  }, [loadSelection]);

  useEffect(() => {
    const projectEpoch = ++projectEpochRef.current;
    loadRevisionRef.current += 1;
    saveRevisionRef.current += 1;
    saveGenerationRef.current += 1;
    saveQueueRef.current = Promise.resolve();
    pendingSavesRef.current = 0;
    serverRevisionRef.current = "none";
    selectionDocumentRef.current = null;
    selectionReadyRef.current = false;
    setSelectionReady(false);
    setCutWordIds(new Set());
    setSelectionLoading(true);
    setSaveState("idle");
    void reloadSelection();
    return () => {
      loadRevisionRef.current += 1;
      saveRevisionRef.current += 1;
      saveGenerationRef.current += 1;
      if (projectEpochRef.current === projectEpoch) projectEpochRef.current += 1;
    };
  }, [reloadSelection]);

  useEffect(() => {
    const handleChange = (payload: unknown) => {
      if (
        isCutSelectionFileChange(payload, projectId) &&
        pendingSavesRef.current > 0
      ) {
        // The cuts API writes cut-selection.json before resolving the request,
        // so the project watcher reports our own optimistic save while it is
        // still pending. The API response already carries the canonical
        // document + revision; reloading here would temporarily unmount the
        // transcript and reset its scroll position to the top. A genuine
        // concurrent external write is still protected by the revision CAS and
        // reloads through the conflict path below.
        return;
      }
      if (
        shouldSyncCutSelectionAfterFileChange(
          payload,
          projectId,
          pendingSavesRef.current,
        )
      ) {
        // A single API write is also observed later by the native project
        // watcher. That second event can arrive after the PUT has resolved, so
        // pendingSaves alone cannot identify it as our own write. Synchronize
        // the canonical document without entering the initial-loading state:
        // replacing the transcript with a loading placeholder would unmount
        // its scroll container and reset the user to the first cue.
        void loadSelection();
      }
    };
    if (import.meta.hot) {
      import.meta.hot.on("hf:file-change", handleChange);
      return () => import.meta.hot?.off?.("hf:file-change", handleChange);
    }
    const events = new EventSource("/api/events");
    events.addEventListener("file-change", handleChange);
    return () => events.close();
  }, [loadSelection, projectId]);

  const updateCutWordIds = useCallback((next: ReadonlySet<string>) => {
    const nextCut = new Set(next);
    if (!selectionReadyRef.current) {
      setSaveState("error");
      return;
    }
    const revision = ++saveRevisionRef.current;
    const generation = saveGenerationRef.current;
    const projectEpoch = projectEpochRef.current;
    const requestedWordIds = words
      .filter((word) => nextCut.has(word.id))
      .map((word) => word.id);
    loadRevisionRef.current += 1;
    setCutWordIds(nextCut);
    setSaveState("saving");
    pendingSavesRef.current += 1;

    const saveOperation = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (
          projectEpoch !== projectEpochRef.current ||
          generation !== saveGenerationRef.current
        ) return false;
        try {
          const resource = await putProjectCutSelection(
            projectId,
            serverRevisionRef.current,
            requestedWordIds,
          );
          if (
            projectEpoch !== projectEpochRef.current ||
            generation !== saveGenerationRef.current
          ) return false;
          serverRevisionRef.current = resource.revision;
          selectionDocumentRef.current = resource.document;
          return true;
        } catch (error) {
          if (
            projectEpoch === projectEpochRef.current &&
            generation === saveGenerationRef.current
          ) {
            saveGenerationRef.current += 1;
            const conflict =
              error instanceof CutSelectionApiError &&
              error.code === "revision_conflict";
            if (conflict) {
              const reloaded = await reloadSelection();
              if (projectEpoch === projectEpochRef.current) {
                setSaveState(reloaded ? "conflict" : "error");
              }
            } else {
              setCutWordIds(parseCutWordIds(selectionDocumentRef.current));
              setSaveState("error");
            }
          }
          throw error;
        }
      });
    const trackedOperation = saveOperation.then(
      (saved) => {
        if (projectEpoch !== projectEpochRef.current) return saved;
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        return saved;
      },
      (error) => {
        if (projectEpoch !== projectEpochRef.current) throw error;
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        throw error;
      },
    );
    saveQueueRef.current = trackedOperation.then(
      () => undefined,
      () => undefined,
    );
    void trackedOperation.then(
      (saved) => {
        if (saveRevisionRef.current !== revision) return;
        if (saved) setSaveState("saved");
      },
      () => undefined,
    );
  }, [projectId, reloadSelection, words]);

  return {
    cutWordIds,
    saveState,
    selectionLoading,
    selectionReady,
    updateCutWordIds,
  };
}
