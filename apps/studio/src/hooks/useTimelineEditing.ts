// fallow-ignore-file complexity
import { useCallback, useRef } from "react";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import { useRazorSplit } from "./useRazorSplit";
import { useTimelineAssetDropOps } from "./useTimelineAssetDropOps";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import { setCompositionDurationToContent } from "../utils/timelineAssetDrop";
import { furthestClipEndFromSource } from "../player/lib/timelineElementHelpers";
import { getTimelineElementLabel } from "../utils/studioHelpers";
import {
  applyTimelineStackingReorder,
  buildPatchTarget,
  patchIframeDomTiming,
  persistTimelineEdit,
  formatTimelineAttributeNumber,
  extendRootDurationIfNeeded,
  buildTimelineMoveTimingPatch,
  buildTimelineResizeTimingPatch,
} from "./timelineEditingHelpers";
import {
  captureDurationRollback,
  finishClipTimingFallback,
  readFileContent,
  syncPreviewContentDuration,
} from "./timelineTimingSync";
import type { PersistTimelineEditInput } from "./timelineEditingHelpers";
import type { TimelineStackingReorderIntent } from "../player/components/timelineEditing";
import {
  useTimelineElementVisibilityEditing,
  useTimelineTrackVisibilityEditing,
} from "./timelineTrackVisibility";
import { useTimelineGroupEditing } from "./useTimelineGroupEditing";
import { serializeZLaneGesture } from "../components/nle/zLaneGesture";
import { cutoverCommittedOrThrow, sdkTimingPersist } from "../utils/sdkCutover";
import type { UseTimelineEditingOptions } from "./useTimelineEditingTypes";
import { getStudioSaveErrorMessage } from "../utils/studioSaveDiagnostics";

type TimelineMoveUpdates = Pick<TimelineElement, "start" | "track"> & {
  stackingReorder?: TimelineStackingReorderIntent | null;
};

const timelineElementKey = (element: TimelineElement): string => element.key ?? element.id;
const timelineTimeChanged = (before: number, after: number): boolean =>
  Math.abs(before - after) > 0.000001;

export function useTimelineEditing({
  projectId,
  activeCompPath,
  timelineElements,
  showToast,
  writeProjectFile,
  observeProjectFileVersion,
  recordEdit,
  domEditSaveTimestampRef,
  reloadPreview,
  previewIframeRef,
  pendingTimelineEditPathRef,
  uploadProjectFiles,
  isRecordingRef,
  sdkSession,
  publishSdkSession,
  forceReloadSdkSession,
  handleDomZIndexReorderCommitRef,
  timelineEditingAdapter,
}: UseTimelineEditingOptions) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const editQueueRef = useRef(Promise.resolve());
  const lastBlockedTimelineToastAtRef = useRef(0);

  const enqueueEdit = useCallback(
    (
      element: TimelineElement,
      label: string,
      buildPatches: PersistTimelineEditInput["buildPatches"],
      coalesceKey?: string,
    ): Promise<void> => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return Promise.resolve();
      }
      const pid = projectIdRef.current;
      if (!pid) return Promise.resolve();
      const queued = editQueueRef.current
        .then(() =>
          persistTimelineEdit({
            projectId: pid,
            element,
            activeCompPath,
            label,
            buildPatches,
            writeProjectFile,
            recordEdit,
            domEditSaveTimestampRef,
            pendingTimelineEditPathRef,
            coalesceKey,
          }),
        )
        .then(() => {
          forceReloadSdkSession?.();
        });
      editQueueRef.current = queued.catch((error) => {
        console.error(`[Timeline] Failed to persist: ${label}`, error);
      });
      return queued;
    },
    [
      activeCompPath,
      recordEdit,
      writeProjectFile,
      domEditSaveTimestampRef,
      pendingTimelineEditPathRef,
      showToast,
      isRecordingRef,
      forceReloadSdkSession,
    ],
  );
  const groupEditing = useTimelineGroupEditing({
    activeCompPath,
    domEditSaveTimestampRef,
    editQueueRef,
    forceReloadSdkSession,
    isRecordingRef,
    pendingTimelineEditPathRef,
    previewIframeRef,
    projectIdRef,
    recordEdit,
    reloadPreview,
    sdkSession,
    publishSdkSession,
    showToast,
    writeProjectFile,
  });
  const handleTimelineElementMove = useCallback(
    // fallow-ignore-next-line complexity
    (element: TimelineElement, updates: TimelineMoveUpdates) => {
      if (timelineEditingAdapter?.handles(element)) {
        return timelineEditingAdapter
          .move(element, updates)
          .then(() => {
            forceReloadSdkSession?.();
            reloadPreview();
          })
          .catch((error) => {
            showToast(getStudioSaveErrorMessage(error), "error");
            throw error;
          });
      }
      const commitMove = () => {
        const targetPath = element.sourceFile || activeCompPath || "index.html";
        const startChanged = updates.start !== element.start;
        // A vertical-only lane move arrives with start unchanged but track changed
        // (on this single-element path the drag commit has already folded the
        // AUTHORED persist track into updates.track). It must persist like any
        // other move — early-returning on !startChanged alone silently dropped
        // the file write, so the lane snapped back on reload.
        const trackChanged = updates.track !== element.track;

        if (startChanged || trackChanged) {
          const liveAttrs: Array<[string, string]> = [];
          if (startChanged) {
            liveAttrs.push(["data-start", formatTimelineAttributeNumber(updates.start)]);
          }
          if (trackChanged) {
            liveAttrs.push(["data-track-index", formatTimelineAttributeNumber(updates.track)]);
          }
          patchIframeDomTiming(previewIframeRef.current, element, liveAttrs, activeCompPath);
        }

        const reorderDone = applyTimelineStackingReorder({
          element,
          stackingReorder: updates.stackingReorder,
          timelineElements,
          iframe: previewIframeRef.current,
          activeCompPath,
          commit: handleDomZIndexReorderCommitRef?.current,
        });

        if (!startChanged && !trackChanged) return reorderDone;

        // Snapshot the duration BEFORE the optimistic updates below so a failed
        // persist can roll the readout + live root back (see captureDurationRollback).
        const rollbackDuration = captureDurationRollback(previewIframeRef.current);
        // needsExtension gates the SDK path (setTiming can't grow the root duration), so read the store BEFORE the readout sync below optimistically updates it.
        const needsExtension = extendRootDurationIfNeeded(updates.start + element.duration);
        // Optimistic duration readout: content-driven (grow AND shrink), from the just-patched live DOM. See syncPreviewContentDuration.
        syncPreviewContentDuration(previewIframeRef.current);

        const buildMovePatches: PersistTimelineEditInput["buildPatches"] = (original, target) => {
          // Persist lane changes too — data-start-only writes let reload snap the lane back.
          const track = trackChanged ? updates.track : undefined;
          return buildTimelineMoveTimingPatch(
            original,
            target,
            updates.start,
            element.duration,
            track,
          );
        };
        const coalesceKey = `timeline-move:${element.hfId ?? element.id}`;
        const moveFallback = () =>
          enqueueEdit(element, "Move timeline clip", buildMovePatches, coalesceKey).then(() =>
            // Soft-reload with the server's rewritten GSAP script — the timing-only move already patched
            // DOM + store, so swapping the script avoids the all-clips flash; falls back to reloadPreview().
            finishClipTimingFallback({
              iframe: previewIframeRef.current,
              reloadPreview,
              projectId: projectIdRef.current,
              targetPath,
              domId: element.domId,
              label: "Move timeline clip",
              coalesceKey,
              recordEdit,
              edit: { kind: "shift", delta: updates.start - element.start },
            }),
          );
        return reorderDone
          .then(() => {
            // The SDK setTiming path writes start only — a lane change must take
            // the fallback, whose patch builder writes data-track-index too.
            if (sdkSession && element.hfId && !needsExtension && !trackChanged) {
              return sdkTimingPersist(
                element.hfId,
                targetPath,
                { start: updates.start },
                sdkSession,
                {
                  editHistory: { recordEdit },
                  writeProjectFile,
                  reloadPreview,
                  domEditSaveTimestampRef,
                  compositionPath: activeCompPath,
                  // Capture on-disk bytes as the undo `before` so undoing a timing move
                  // restores the file verbatim, not a normalized full-DOM re-emit.
                  readProjectFile: (path) => readFileContent(projectIdRef.current ?? "", path),
                  publishSession: publishSdkSession,
                },
                { label: "Move timeline clip", coalesceKey },
              ).then((result) => {
                if (!cutoverCommittedOrThrow(result)) return moveFallback();
              });
            }
            return moveFallback();
          })
          .catch((error) => {
            // Failed persist: revert the optimistic duration readout + live root.
            rollbackDuration();
            showToast(getStudioSaveErrorMessage(error), "error");
            throw error;
          });
      };
      return updates.stackingReorder ? serializeZLaneGesture(commitMove) : commitMove();
    },
    [
      previewIframeRef,
      enqueueEdit,
      activeCompPath,
      sdkSession,
      publishSdkSession,
      recordEdit,
      writeProjectFile,
      reloadPreview,
      domEditSaveTimestampRef,
      timelineElements,
      handleDomZIndexReorderCommitRef,
      showToast,
      timelineEditingAdapter,
      forceReloadSdkSession,
    ],
  );

  const handleTimelineElementResize = useCallback(
    // fallow-ignore-next-line complexity
    (
      element: TimelineElement,
      updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
    ) => {
      if (timelineEditingAdapter?.handles(element)) {
        return timelineEditingAdapter
          .resize(element, updates)
          .then(() => {
            forceReloadSdkSession?.();
            reloadPreview();
          })
          .catch((error) => {
            showToast(getStudioSaveErrorMessage(error), "error");
            throw error;
          });
      }
      const liveAttrs: Array<[string, string]> = [
        ["data-start", formatTimelineAttributeNumber(updates.start)],
        ["data-duration", formatTimelineAttributeNumber(updates.duration)],
      ];
      if (updates.playbackStart != null) {
        const liveAttr =
          element.playbackStartAttr === "playback-start"
            ? "data-playback-start"
            : "data-media-start";
        liveAttrs.push([liveAttr, formatTimelineAttributeNumber(updates.playbackStart)]);
      }
      patchIframeDomTiming(previewIframeRef.current, element, liveAttrs, activeCompPath);
      // Snapshot the duration BEFORE the optimistic updates below so a failed
      // persist can roll the readout + live root back (see captureDurationRollback).
      const rollbackDuration = captureDurationRollback(previewIframeRef.current);
      // needsExtension gates the SDK path (setTiming can't grow the root duration), so read the store BEFORE the readout sync below optimistically updates it.
      const needsExtension = extendRootDurationIfNeeded(updates.start + updates.duration);
      // Optimistic duration readout: content-driven (grow AND shrink), from the just-patched live DOM. See syncPreviewContentDuration.
      syncPreviewContentDuration(previewIframeRef.current);
      const targetPath = element.sourceFile || activeCompPath || "index.html";
      const buildResizePatches: PersistTimelineEditInput["buildPatches"] = (original, target) => {
        return buildTimelineResizeTimingPatch(original, target, element, updates);
      };
      const hasPbsAdjustment =
        updates.playbackStart != null ||
        (updates.start !== element.start && element.playbackStart != null);
      // Server-path fallback: after persisting the attr patch, scale GSAP tween
      // positions/durations on the server, then soft-reload with the rewritten
      // script (timing-only resize) — same no-flash path as move; full reload is
      // the fallback.
      const coalesceKey = `timeline-resize:${element.hfId ?? element.id}`;
      const resizeFallback = () =>
        enqueueEdit(element, "Resize timeline clip", buildResizePatches, coalesceKey).then(() =>
          finishClipTimingFallback({
            iframe: previewIframeRef.current,
            reloadPreview,
            projectId: projectIdRef.current,
            targetPath,
            domId: element.domId,
            label: "Resize timeline clip",
            coalesceKey,
            recordEdit,
            edit: {
              kind: "scale",
              from: { start: element.start, duration: element.duration },
              to: { start: updates.start, duration: updates.duration },
            },
          }),
        );
      const persistDone =
        sdkSession && element.hfId && !hasPbsAdjustment && !needsExtension
          ? sdkTimingPersist(
              element.hfId,
              targetPath,
              { start: updates.start, duration: updates.duration },
              sdkSession,
              {
                editHistory: { recordEdit },
                writeProjectFile,
                reloadPreview,
                domEditSaveTimestampRef,
                compositionPath: activeCompPath,
                // Capture on-disk bytes as the undo `before` so undoing a timing
                // resize restores the file verbatim, not a normalized full-DOM re-emit.
                readProjectFile: (path) => readFileContent(projectIdRef.current ?? "", path),
                publishSession: publishSdkSession,
              },
              { label: "Resize timeline clip", coalesceKey },
            ).then((result) => {
              if (!cutoverCommittedOrThrow(result)) return resizeFallback();
            })
          : resizeFallback();
      return persistDone.catch((error) => {
        // Failed persist: revert the optimistic duration readout + live root.
        rollbackDuration();
        showToast(getStudioSaveErrorMessage(error), "error");
        throw error;
      });
    },
    [
      previewIframeRef,
      enqueueEdit,
      activeCompPath,
      sdkSession,
      publishSdkSession,
      recordEdit,
      writeProjectFile,
      reloadPreview,
      domEditSaveTimestampRef,
      showToast,
      timelineEditingAdapter,
      forceReloadSdkSession,
    ],
  );

  const handleToggleTrackHidden = useTimelineTrackVisibilityEditing({
    projectIdRef,
    activeCompPath,
    timelineElements,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    forceReloadSdkSession,
  });

  const handleToggleElementHidden = useTimelineElementVisibilityEditing({
    projectIdRef,
    activeCompPath,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    forceReloadSdkSession,
  });

  // fallow-ignore-next-line complexity
  const handleTimelineElementDelete = useCallback(
    // fallow-ignore-next-line complexity
    async (element: TimelineElement) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");
      const label = getTimelineElementLabel(element);

      if (timelineEditingAdapter?.handles(element)) {
        try {
          await timelineEditingAdapter.delete(element);
          usePlayerStore.getState().setSelectedElementId(null);
          forceReloadSdkSession?.();
          reloadPreview();
          showToast(`Deleted ${label}.`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to delete timeline clip";
          showToast(message, "error");
          throw error;
        }
        return;
      }

      const targetPath = element.sourceFile || activeCompPath || "index.html";
      try {
        const originalContent = await readFileContent(pid, targetPath);

        const patchTarget = buildPatchTarget(element);
        if (!patchTarget) {
          throw new Error(`Timeline element ${element.id} is missing a patchable target`);
        }

        const removeResponse = await fetch(
          `/api/projects/${pid}/file-mutations/remove-element/${encodeURIComponent(targetPath)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: patchTarget }),
          },
        );
        if (!removeResponse.ok) {
          throw new Error(`Failed to delete ${element.id} from ${targetPath}`);
        }

        const removeData = (await removeResponse.json()) as {
          changed?: boolean;
          content?: string;
        };
        const removedContent =
          typeof removeData.content === "string" ? removeData.content : originalContent;
        // Content-driven duration: shrink the composition to the furthest
        // remaining clip end, read from the post-removal SOURCE (raw
        // data-duration), so deleting the last/longest clip removes trailing
        // empty space. Measured from the source, not the store, whose
        // durations are runtime-truncated.
        const deleteContentEnd = furthestClipEndFromSource(removedContent);
        const patchedContent = setCompositionDurationToContent(removedContent, deleteContentEnd);
        // Optimistically reflect the shrunk length in the readout/seek bar,
        // rolling it back if the persist below fails (see captureDurationRollback).
        const rollbackDuration = captureDurationRollback(previewIframeRef.current);
        if (deleteContentEnd > 0 && targetPath === (activeCompPath || "index.html")) {
          usePlayerStore.getState().setDuration(deleteContentEnd);
        }

        domEditSaveTimestampRef.current = Date.now();
        try {
          await saveProjectFilesWithHistory({
            projectId: pid,
            label: "Delete timeline clip",
            kind: "timeline",
            files: { [targetPath]: patchedContent },
            readFile: async () => originalContent,
            writeFile: writeProjectFile,
            recordEdit,
          });
        } catch (error) {
          rollbackDuration();
          throw error;
        }

        usePlayerStore
          .getState()
          .setElements(
            timelineElements.filter((te) => (te.key ?? te.id) !== (element.key ?? element.id)),
          );
        usePlayerStore.getState().setSelectedElementId(null);
        forceReloadSdkSession?.();
        reloadPreview();
        showToast(`Deleted ${label}. Use Undo to restore it.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete timeline clip";
        showToast(message);
      }
    },
    [
      activeCompPath,
      recordEdit,
      showToast,
      timelineElements,
      writeProjectFile,
      domEditSaveTimestampRef,
      reloadPreview,
      isRecordingRef,
      forceReloadSdkSession,
      previewIframeRef,
      timelineEditingAdapter,
    ],
  );

  const { handleTimelineAssetDrop, handleTimelineFileDrop } = useTimelineAssetDropOps({
    projectIdRef,
    activeCompPath,
    timelineElements,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    uploadProjectFiles,
    isRecordingRef,
    forceReloadSdkSession,
  });

  const handleBlockedTimelineEdit = useCallback(
    (_element: TimelineElement) => {
      const now = Date.now();
      if (now - lastBlockedTimelineToastAtRef.current < 1500) return;
      lastBlockedTimelineToastAtRef.current = now;
      showToast("This clip can't be moved or resized from the timeline yet.", "info");
    },
    [showToast],
  );

  const { handleRazorSplit, handleRazorSplitAll } = useRazorSplit({
    projectId,
    activeCompPath,
    showToast,
    writeProjectFile,
    observeProjectFileVersion,
    recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    forceReloadSdkSession,
    isRecordingRef,
    timelineEditingAdapter,
  });

  const handleTimelineGroupMove = useCallback(
    async (
      changes: Parameters<typeof groupEditing.handleTimelineGroupMove>[0],
      options?: Parameters<typeof groupEditing.handleTimelineGroupMove>[1],
    ) => {
      const managed = timelineEditingAdapter
        ? changes.filter((change) => timelineEditingAdapter.handles(change.element))
        : [];
      if (managed.length === 0) return groupEditing.handleTimelineGroupMove(changes, options);
      const primary = options?.primaryElementKey
        ? managed.find(
            (change) => timelineElementKey(change.element) === options.primaryElementKey,
          )
        : undefined;
      const topologyCompanionsAreTrackOnly = managed.every(
        (change) =>
          change === primary || !timelineTimeChanged(change.element.start, change.start),
      );
      const singleManagedChange =
        changes.length === 1 &&
        managed.length === 1 &&
        options?.multiSelection !== true &&
        (!options?.primaryElementKey || primary != null);
      // HyperFrames' native track-insert drag persists one batch: the grabbed
      // clip plus every row whose authored track is renumbered. Product A-roll
      // has one fixed magnetic track, so those start-unchanged companions have
      // no EDL meaning and are intentionally ignored. Explicit gesture metadata
      // keeps this exception from swallowing a real multi-select or mixed batch.
      const singleManagedTrackInsert =
        options?.operation === "track-insert" &&
        options.multiSelection === false &&
        primary != null &&
        managed.length === changes.length &&
        topologyCompanionsAreTrackOnly;
      if (!singleManagedChange && !singleManagedTrackInsert) {
        const error = new Error("Managed A-roll clips must be moved one at a time");
        showToast(error.message, "error");
        throw error;
      }
      try {
        await options?.beforeTiming;
        const change = primary ?? managed[0];
        await timelineEditingAdapter!.move(change.element, {
          start: change.start,
          track: change.track ?? change.element.track,
        });
        forceReloadSdkSession?.();
        reloadPreview();
      } catch (error) {
        showToast(getStudioSaveErrorMessage(error), "error");
        throw error;
      }
    },
    [forceReloadSdkSession, groupEditing.handleTimelineGroupMove, reloadPreview, showToast, timelineEditingAdapter],
  );

  const handleTimelineGroupResize = useCallback(
    async (
      changes: Parameters<typeof groupEditing.handleTimelineGroupResize>[0],
      options?: Parameters<typeof groupEditing.handleTimelineGroupResize>[1],
    ) => {
      const managed = timelineEditingAdapter
        ? changes.filter((change) => timelineEditingAdapter.handles(change.element))
        : [];
      if (managed.length === 0) return groupEditing.handleTimelineGroupResize(changes, options);
      const [change] = managed;
      const primaryMatches =
        !options?.primaryElementKey ||
        timelineElementKey(change.element) === options.primaryElementKey;
      if (
        managed.length !== 1 ||
        changes.length !== 1 ||
        options?.multiSelection === true ||
        !primaryMatches
      ) {
        const error = new Error("Managed A-roll clips must be resized one at a time");
        showToast(error.message, "error");
        throw error;
      }
      try {
        await options?.beforeTiming;
        await timelineEditingAdapter!.resize(change.element, {
          start: change.start,
          duration: change.duration,
          playbackStart: change.playbackStart,
        });
        forceReloadSdkSession?.();
        reloadPreview();
      } catch (error) {
        showToast(getStudioSaveErrorMessage(error), "error");
        throw error;
      }
    },
    [forceReloadSdkSession, groupEditing.handleTimelineGroupResize, reloadPreview, showToast, timelineEditingAdapter],
  );

  return {
    handleTimelineElementMove,
    handleTimelineElementResize,
    handleToggleTrackHidden,
    handleToggleElementHidden,
    handleTimelineElementDelete,
    handleTimelineElementSplit: handleRazorSplit,
    handleRazorSplit,
    handleRazorSplitAll,
    handleTimelineAssetDrop,
    handleTimelineFileDrop,
    handleBlockedTimelineEdit,
    handleTimelineGroupMove,
    handleTimelineGroupResize,
  };
}
