import { useLayoutEffect, useMemo, useRef } from "react";
import {
  deriveActualCutWordIds,
  resolveSourcePlayheadTime,
} from "../../components/editListPlayback";
import type { useProjectCutSelection } from "../../components/useProjectCutSelection";
import type { ProjectEditListState } from "../../components/useProjectEditList";
import {
  indexKouboTranscript,
  isSameKouboActiveTranscriptPosition,
  resolveKouboActiveTranscriptPosition,
  type KouboActiveTranscriptPosition,
} from "../../extensions/koubo/kouboViewModel";
import type { useKouboTranscript } from "../../extensions/koubo/useKouboTranscript";

export interface KouboTranscriptPlaybackMarkerProps {
  projectId: string;
  editList: ProjectEditListState;
  transcript: ReturnType<typeof useKouboTranscript>;
  cutSelection: ReturnType<typeof useProjectCutSelection>;
  timelineTime: number;
}

interface MarkerNodes {
  cue: HTMLElement | null;
  word: HTMLElement | null;
}

function findNodeByDataId(
  root: HTMLElement,
  attribute: "cueId" | "wordId",
  value: string | null,
): HTMLElement | null {
  if (!value) return null;
  const attributeName = attribute === "cueId" ? "data-cue-id" : "data-word-id";
  return Array.from(root.querySelectorAll<HTMLElement>(`[${attributeName}]`)).find(
    (node) => node.dataset[attribute] === value,
  ) ?? null;
}

function clearMarkerNodes(nodes: MarkerNodes): void {
  nodes.cue?.classList.remove("is-active");
  nodes.word?.classList.remove("is-current");
  nodes.word?.removeAttribute("aria-current");
}

function clearUnexpectedMarkers(
  root: HTMLElement,
  next: KouboActiveTranscriptPosition,
): void {
  for (const cue of root.querySelectorAll<HTMLElement>("[data-cue-id].is-active")) {
    if (cue.dataset.cueId !== next.cueId) cue.classList.remove("is-active");
  }
  for (const word of root.querySelectorAll<HTMLElement>(
    '[data-word-id].is-current, [data-word-id][aria-current="true"]',
  )) {
    if (word.dataset.wordId !== next.wordId) {
      word.classList.remove("is-current");
      word.removeAttribute("aria-current");
    }
  }
}

function markCurrentNodes(
  root: HTMLElement,
  position: KouboActiveTranscriptPosition,
): MarkerNodes {
  const cue = findNodeByDataId(root, "cueId", position.cueId);
  const word = findNodeByDataId(root, "wordId", position.wordId);
  cue?.classList.add("is-active");
  if (word) {
    word.classList.add("is-current");
    word.setAttribute("aria-current", "true");
  }
  return { cue, word };
}

export function applyKouboTranscriptPlaybackMarker(
  root: HTMLElement,
  previous: KouboActiveTranscriptPosition,
  next: KouboActiveTranscriptPosition,
): MarkerNodes {
  if (!isSameKouboActiveTranscriptPosition(previous, next)) {
    clearMarkerNodes({
      cue: findNodeByDataId(root, "cueId", previous.cueId),
      word: findNodeByDataId(root, "wordId", previous.wordId),
    });
  }
  // Strict-mode remounts and a React reconciliation of the static transcript
  // can detach our node refs. Keep the DOM fail-closed: exactly one marker may
  // remain, even when a prior instance did not own the current refs.
  clearUnexpectedMarkers(root, next);
  return markCurrentNodes(root, next);
}

function findTranscriptRoot(projectId: string): HTMLElement | null {
  const workspace = Array.from(document.querySelectorAll<HTMLElement>("[data-project-id]"))
    .find((node) => node.dataset.projectId === projectId);
  return workspace?.querySelector<HTMLElement>("[data-cut-transcript-pane=true]") ?? null;
}

/**
 * Keeps real-time feedback out of the transcript React tree. Transport can
 * publish frame time freely; only a word/cue boundary mutates two DOM nodes.
 */
export function KouboTranscriptPlaybackMarker({
  projectId,
  editList,
  transcript,
  cutSelection,
  timelineTime,
}: KouboTranscriptPlaybackMarkerProps) {
  const sourceWords = useMemo(() => transcript.cues.flatMap((cue) => cue.words), [transcript.cues]);
  const displayedCutWordIds = useMemo(
    () => deriveActualCutWordIds(sourceWords, cutSelection.cutWordIds, editList.document),
    [cutSelection.cutWordIds, editList.document, sourceWords],
  );
  const indexedTranscript = useMemo(
    () => indexKouboTranscript(transcript.cues, displayedCutWordIds),
    [displayedCutWordIds, transcript.cues],
  );
  const activePositionRef = useRef<KouboActiveTranscriptPosition>({ cueId: null, wordId: null });
  const markerNodesRef = useRef<MarkerNodes>({ cue: null, word: null });

  useLayoutEffect(() => {
    activePositionRef.current = { cueId: null, wordId: null };
    markerNodesRef.current = { cue: null, word: null };
    return () => {
      clearMarkerNodes(markerNodesRef.current);
      markerNodesRef.current = { cue: null, word: null };
    };
  }, [projectId]);

  useLayoutEffect(() => {
    const root = findTranscriptRoot(projectId);
    if (!root) return;
    const sourceTime = resolveSourcePlayheadTime(editList.document, timelineTime);
    const next = resolveKouboActiveTranscriptPosition(indexedTranscript.cues, sourceTime);
    const previous = activePositionRef.current;
    const nodes = markerNodesRef.current;
    const markerIsCurrent = Boolean(nodes.cue?.isConnected)
      && nodes.cue?.classList.contains("is-active")
      && (next.wordId === null || Boolean(nodes.word?.isConnected && nodes.word.classList.contains("is-current")));
    clearUnexpectedMarkers(root, next);
    if (isSameKouboActiveTranscriptPosition(previous, next) && markerIsCurrent) return;
    markerNodesRef.current = applyKouboTranscriptPlaybackMarker(
      root,
      markerIsCurrent ? previous : { cueId: null, wordId: null },
      next,
    );
    activePositionRef.current = next;
  }, [editList.document, indexedTranscript.cues, projectId, timelineTime]);

  return null;
}
