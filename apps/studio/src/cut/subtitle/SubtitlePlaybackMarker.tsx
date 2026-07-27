import { useLayoutEffect, useRef } from "react";
import type { SubtitleCueTiming } from "@video-workbench/core";

export interface SubtitlePlaybackMarkerProps {
  projectId: string;
  timings: readonly SubtitleCueTiming[];
  timelineTime: number;
}

function findPaneRoot(projectId: string): HTMLElement | null {
  const workspace = Array.from(document.querySelectorAll<HTMLElement>("[data-project-id]"))
    .find((node) => node.dataset.projectId === projectId);
  return workspace?.querySelector<HTMLElement>("[data-cut-subtitle-pane=true]") ?? null;
}

function rowFor(root: HTMLElement, cueId: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-cue-id]"))
    .find((node) => node.dataset.cueId === cueId) ?? null;
}

/**
 * Keeps the playhead out of the subtitle list's React tree.
 *
 * The list is one row per screen with an editable field in each, and the
 * transport publishes a new time every frame. Passing that time down as a prop
 * re-renders the whole column on every tick — and because the tab strip is one
 * memoized component, it took the transcript pane down with it. That is the
 * regression a render-count test has been guarding against since the transcript
 * marker was written; this is the same answer applied to the same problem.
 *
 * Only a screen boundary touches the DOM, and only two nodes.
 */
export function SubtitlePlaybackMarker({
  projectId,
  timings,
  timelineTime,
}: SubtitlePlaybackMarkerProps) {
  const activeRef = useRef<string | null>(null);
  const scrolledRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    activeRef.current = null;
    scrolledRef.current = null;
  }, [projectId]);

  useLayoutEffect(() => {
    const root = findPaneRoot(projectId);
    if (!root) return;
    let next: string | null = null;
    for (const timing of timings) {
      if (timing.orphaned) continue;
      if (timelineTime >= timing.start && timelineTime < timing.end) {
        next = timing.cueId;
        break;
      }
    }
    const previous = activeRef.current;
    const marked = previous ? rowFor(root, previous) : null;
    if (previous === next && marked?.dataset.playing === "true") return;
    // Fail closed: a re-render or a strict-mode remount can detach the node we
    // marked, and two highlighted rows is worse than a late one.
    for (const row of root.querySelectorAll<HTMLElement>('[data-cue-id][data-playing="true"]')) {
      if (row.dataset.cueId !== next) row.dataset.playing = "false";
    }
    activeRef.current = next;
    if (!next) return;
    const row = rowFor(root, next);
    if (!row) return;
    row.dataset.playing = "true";
    // Follow playback, but only when the screen actually changes — scrolling on
    // every frame would fight a person reading further down the list.
    if (scrolledRef.current !== next) {
      scrolledRef.current = next;
      row.scrollIntoView({ block: "nearest" });
    }
  }, [projectId, timelineTime, timings]);

  return null;
}
