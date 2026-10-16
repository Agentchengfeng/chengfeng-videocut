import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { timelineTimeToSourcePosition } from "@video-workbench/core";
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

// The active line may sit anywhere inside this band without moving the list;
// once it leaves, the list jumps so the line lands about a third of the way
// down. Scrolling on every line would fight a person reading along.
const FOLLOW_BAND_TOP = 0.12;
const FOLLOW_BAND_BOTTOM = 0.72;
const FOLLOW_ANCHOR = 0.3;
// A playhead move larger than this between two updates is a seek, not playback.
const SEEK_JUMP_SECONDS = 1;
// Scroll events inside this window after our own scroll are ours, not the person's.
const PROGRAMMATIC_SCROLL_MS = 800;

/** Where the transcript scroll owner should go to keep `cue` in view; null when it already is. */
export function followScrollTarget(owner: HTMLElement, cue: HTMLElement): number | null {
  const height = owner.clientHeight;
  if (height <= 0) return null;
  const ownerTop = owner.getBoundingClientRect().top;
  const cueRect = cue.getBoundingClientRect();
  const top = cueRect.top - ownerTop;
  const bottom = cueRect.bottom - ownerTop;
  if (top >= height * FOLLOW_BAND_TOP && bottom <= height * FOLLOW_BAND_BOTTOM) return null;
  const max = Math.max(0, owner.scrollHeight - height);
  const target = Math.max(0, Math.min(max, Math.round(owner.scrollTop + top - height * FOLLOW_ANCHOR)));
  return Math.abs(target - owner.scrollTop) < 2 ? null : target;
}

function cueIsVisible(owner: HTMLElement, cue: HTMLElement): boolean {
  const ownerRect = owner.getBoundingClientRect();
  const cueRect = cue.getBoundingClientRect();
  return cueRect.bottom > ownerRect.top && cueRect.top < ownerRect.bottom;
}

function findScrollOwner(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-cut-transcript-scroll-owner=true]");
}

interface FollowState {
  suspended: boolean;
  programmaticUntil: number;
  pointerDown: boolean;
  lastTime: number | null;
  owner: HTMLElement | null;
  detach: (() => void) | null;
}

/**
 * Keeps real-time feedback out of the transcript React tree. Transport can
 * publish frame time freely; only a word/cue boundary mutates two DOM nodes
 * and, while following, the scroll owner's scrollTop.
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
  const followRef = useRef<FollowState>({
    suspended: false,
    programmaticUntil: 0,
    pointerDown: false,
    lastTime: null,
    owner: null,
    detach: null,
  });
  const [returnTarget, setReturnTarget] = useState<HTMLElement | null>(null);
  const returnTargetRef = useRef<HTMLElement | null>(null);

  const showReturn = useCallback((target: HTMLElement | null) => {
    if (returnTargetRef.current === target) return;
    returnTargetRef.current = target;
    setReturnTarget(target);
  }, []);

  const refreshReturn = useCallback((root: HTMLElement | null) => {
    const follow = followRef.current;
    const owner = follow.owner;
    const cue = markerNodesRef.current.cue;
    const hidden = Boolean(root && owner && cue?.isConnected && !cueIsVisible(owner, cue));
    showReturn(follow.suspended && hidden ? root : null);
  }, [showReturn]);

  const scrollToCue = useCallback((owner: HTMLElement, cue: HTMLElement | null) => {
    if (!cue?.isConnected) return;
    const target = followScrollTarget(owner, cue);
    if (target === null) return;
    followRef.current.programmaticUntil = performance.now() + PROGRAMMATIC_SCROLL_MS;
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof owner.scrollTo === "function") {
      owner.scrollTo({ top: target, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      owner.scrollTop = target;
    }
  }, []);

  // Attach to the scroll owner the pane currently renders. The pane can remount
  // (tab switch, project reload), so this is re-checked on every tick and is
  // cheap when the owner is unchanged.
  const attachOwner = useCallback((root: HTMLElement): HTMLElement | null => {
    const follow = followRef.current;
    const owner = findScrollOwner(root);
    if (owner === follow.owner) return owner;
    follow.detach?.();
    follow.detach = null;
    follow.owner = owner;
    if (!owner) return null;
    const onScroll = () => {
      if (performance.now() < follow.programmaticUntil) return;
      // Any scroll we did not start is the person taking over: stop following.
      follow.suspended = true;
      refreshReturn(owner.closest<HTMLElement>("[data-cut-transcript-pane=true]"));
    };
    const onPointerDown = () => { follow.pointerDown = true; };
    const onPointerUp = () => { follow.pointerDown = false; };
    owner.addEventListener("scroll", onScroll, { passive: true });
    owner.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    follow.detach = () => {
      owner.removeEventListener("scroll", onScroll);
      owner.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    return owner;
  }, [refreshReturn]);

  useEffect(() => () => {
    followRef.current.detach?.();
    followRef.current.detach = null;
    followRef.current.owner = null;
  }, []);

  useLayoutEffect(() => {
    activePositionRef.current = { cueId: null, wordId: null };
    markerNodesRef.current = { cue: null, word: null };
    followRef.current.suspended = false;
    followRef.current.lastTime = null;
    showReturn(null);
    return () => {
      clearMarkerNodes(markerNodesRef.current);
      markerNodesRef.current = { cue: null, word: null };
    };
  }, [projectId, showReturn]);

  useLayoutEffect(() => {
    const root = findTranscriptRoot(projectId);
    if (!root) return;
    const sourceTime = resolveSourcePlayheadTime(editList.document, timelineTime);
    const identity = editList.document?.schemaVersion === 2
      ? timelineTimeToSourcePosition(editList.document, timelineTime) ?? {}
      : undefined;
    const next = resolveKouboActiveTranscriptPosition(indexedTranscript.cues, sourceTime, identity);
    const previous = activePositionRef.current;
    const nodes = markerNodesRef.current;
    const markerIsCurrent = Boolean(nodes.cue?.isConnected)
      && nodes.cue?.classList.contains("is-active")
      && (next.wordId === null || Boolean(nodes.word?.isConnected && nodes.word.classList.contains("is-current")));
    clearUnexpectedMarkers(root, next);

    const follow = followRef.current;
    const owner = attachOwner(root);
    const jumped = follow.lastTime !== null
      && Math.abs(timelineTime - follow.lastTime) > SEEK_JUMP_SECONDS;
    follow.lastTime = timelineTime;
    // Jumping the playhead (timeline click, word click, keyboard seek) is an
    // explicit "take me there": it ends a manual-scroll pause.
    if (jumped) follow.suspended = false;
    const cueChanged = previous.cueId !== next.cueId || !markerIsCurrent;

    if (!(isSameKouboActiveTranscriptPosition(previous, next) && markerIsCurrent)) {
      markerNodesRef.current = applyKouboTranscriptPlaybackMarker(
        root,
        markerIsCurrent ? previous : { cueId: null, wordId: null },
        next,
      );
      activePositionRef.current = next;
    }

    if (!owner) return;
    const busy = follow.pointerDown
      || Boolean(root.querySelector("[data-cut-transcript-selection=true]"));
    if (!follow.suspended && !busy && (cueChanged || jumped)) {
      scrollToCue(owner, markerNodesRef.current.cue);
    }
    if (cueChanged || jumped) refreshReturn(root);
  }, [attachOwner, editList.document, indexedTranscript.cues, projectId, refreshReturn, scrollToCue, timelineTime]);

  const returnToPlayback = useCallback(() => {
    const follow = followRef.current;
    follow.suspended = false;
    showReturn(null);
    if (follow.owner) scrollToCue(follow.owner, markerNodesRef.current.cue);
  }, [scrollToCue, showReturn]);

  if (!returnTarget) return null;
  return createPortal(
    <button
      type="button"
      className="cut-transcript-follow"
      data-cut-transcript-follow="true"
      onClick={returnToPlayback}
    >
      回到播放位置
    </button>,
    returnTarget,
  );
}
