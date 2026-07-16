import { useLayoutEffect } from "react";
import { useCaptionStore } from "../captions/store";

export function resetCaptionStoreForProjectChange(): void {
  useCaptionStore.getState().reset();
}

/**
 * Caption editing state belongs to one project only. Reset it before paint
 * whenever Studio resolves a different project so a previous project's model
 * can never appear as a caption track in the next project.
 */
export function useCaptionProjectIsolation(projectId: string | null): void {
  useLayoutEffect(() => {
    resetCaptionStoreForProjectChange();
  }, [projectId]);
}
