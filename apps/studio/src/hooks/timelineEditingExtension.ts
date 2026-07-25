import type { TimelineElement } from "../player";

export type StudioTimelineMoveUpdates = Pick<TimelineElement, "start" | "track">;
export type StudioTimelineResizeUpdates = Pick<
  TimelineElement,
  "start" | "duration" | "playbackStart"
>;

/**
 * Product-owned mutation seam for timeline elements whose source of truth is
 * not composition HTML. HyperFrames keeps ownership of gestures and UI; the
 * embedding product owns persistence for elements accepted by `handles`.
 */
export interface StudioTimelineEditingAdapter {
  handles: (element: TimelineElement) => boolean;
  move: (element: TimelineElement, updates: StudioTimelineMoveUpdates) => Promise<void>;
  resize: (element: TimelineElement, updates: StudioTimelineResizeUpdates) => Promise<void>;
  delete: (element: TimelineElement) => Promise<void>;
  split: (element: TimelineElement, splitTime: number) => Promise<void>;
  /** Managed clips are source projections and must not be copied back into HTML. */
  blockClipboard?: boolean;
}

/**
 * Hook supplied by the embedding product. The function identity is expected to
 * remain stable for the lifetime of StudioApp, just like any React hook.
 */
export type UseStudioTimelineEditingAdapter = (
  projectId: string | null,
) => StudioTimelineEditingAdapter | null;

export function useEmptyStudioTimelineEditingAdapter(
  _projectId: string | null,
): StudioTimelineEditingAdapter | null {
  return null;
}
