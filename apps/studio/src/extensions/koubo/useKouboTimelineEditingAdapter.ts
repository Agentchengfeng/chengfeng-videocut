import { useMemo } from "react";
import type {
  StudioTimelineEditingAdapter,
  UseStudioTimelineEditingAdapter,
} from "../../hooks/timelineEditingExtension";
import { useProjectEditList } from "../../components/useProjectEditList";
import {
  buildEditListDeleteOperation,
  buildEditListMoveOperation,
  buildEditListSplitOperation,
  buildEditListTrimOperation,
  isEditListManagedElement,
} from "../../hooks/editListTimelineEditing";

/**
 * Product-owned persistence bridge for the official HyperFrames timeline.
 * Every mutation goes through useProjectEditList -> PATCH edit-list API -> CAS;
 * no composition HTML or project JSON is written by this adapter.
 */
export const useKouboTimelineEditingAdapter: UseStudioTimelineEditingAdapter = (projectId) => {
  const editList = useProjectEditList(projectId);

  return useMemo<StudioTimelineEditingAdapter>(
    () => ({
      handles: isEditListManagedElement,
      blockClipboard: true,
      async move(element, updates) {
        if (!isEditListManagedElement(element)) return;
        await editList.patchOperation(buildEditListMoveOperation(element, updates.start));
      },
      async resize(element, updates) {
        if (!isEditListManagedElement(element)) return;
        await editList.patchOperation(buildEditListTrimOperation(element, updates));
      },
      async delete(element) {
        if (!isEditListManagedElement(element)) return;
        await editList.patchOperation(buildEditListDeleteOperation(element));
      },
      async split(element, splitTime) {
        if (!isEditListManagedElement(element)) return;
        await editList.patchOperation(buildEditListSplitOperation(element, splitTime));
      },
    }),
    [editList.patchOperation],
  );
};
