import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeVisualLayer,
  applyEditListOperation,
  type EditListDocument,
  type EditListOperation,
} from "@video-workbench/core";
import type { EditListActor } from "../components/editListApi";
import { useProjectCutSelection } from "../components/useProjectCutSelection";
import { useProjectEditList } from "../components/useProjectEditList";
import { useProjectSubtitles } from "../components/useProjectSubtitles";
import { useKouboTranscript } from "../extensions/koubo/useKouboTranscript";
import { CutFeaturePanel, type CutFeatureTab } from "./features/CutFeaturePanel";
import { CutInspector } from "./inspector/CutInspector";
import { SubtitlePane } from "./subtitle/SubtitlePane";
import type { ActiveSubtitle } from "./subtitle/SubtitleOverlay";
import type { ActiveVisual } from "./visual/VisualOverlay";
import { useProjectVisuals } from "./visual/useProjectVisuals";
import { SubtitlePlaybackMarker } from "./subtitle/SubtitlePlaybackMarker";
import { TranscriptPaneResizer, TRANSCRIPT_WIDTH_DEFAULT } from "./layout/TranscriptPaneResizer";
import { CutPlayer } from "./player/CutPlayer";
import { useAssembledVideoTransport } from "./player/useAssembledVideoTransport";
import { previewArtifactUrl, usePreviewArtifact } from "./player/previewArtifact";
import { CutTimeline } from "./timeline/CutTimeline";
import { KouboTranscriptPlaybackMarker } from "./transcript/KouboTranscriptPlaybackMarker";

interface PlaybackAnchor {
  editRevision: string;
  sourceTime: number;
  timelineTime: number;
}

interface PendingArtifactSeek {
  projectId: string;
  editRevision: string;
  timelineTime: number;
  options?: { keepPlaying?: boolean };
}

interface ProductUndoCommand {
  label: string;
  undo: () => Promise<void> | void;
}

const ANCHOR_EPSILON = 0.001;

export interface SourceTimelineAnchor {
  timelineTime: number;
  sourceTime: number;
  segmentId: string | null;
  reason: "retained" | "next-retained" | "end";
}

function sourceTimeForTimeline(document: EditListDocument | null, timelineTime: number): number | null {
  if (!document) return null;
  const segment = document.segments.find((item) =>
    timelineTime >= item.timelineStart &&
    timelineTime < item.timelineStart + (item.sourceEnd - item.sourceStart) / item.playbackRate
  );
  if (segment) return segment.sourceStart + (timelineTime - segment.timelineStart) * segment.playbackRate;
  if (timelineTime >= document.duration - ANCHOR_EPSILON) {
    return document.segments.at(-1)?.sourceEnd ?? null;
  }
  return null;
}

export function resolveTimelineAnchorForSourceTime(
  document: EditListDocument | null,
  sourceTime: number,
): SourceTimelineAnchor {
  if (!document) return { timelineTime: 0, sourceTime: 0, segmentId: null, reason: "end" };
  const segment = document.segments.find((item) =>
    sourceTime >= item.sourceStart && sourceTime < item.sourceEnd
  );
  if (segment) {
    return {
      timelineTime: Math.min(
      document.duration,
      Math.max(0, segment.timelineStart + (sourceTime - segment.sourceStart) / segment.playbackRate),
      ),
      sourceTime,
      segmentId: segment.id,
      reason: "retained",
    };
  }
  const last = document.segments.at(-1);
  if (last && sourceTime >= last.sourceEnd && sourceTime <= last.sourceEnd + ANCHOR_EPSILON) {
    return {
      timelineTime: document.duration,
      sourceTime: last.sourceEnd,
      segmentId: last.id,
      reason: "end",
    };
  }
  // The source point was deleted: preserve source continuity by landing on
  // the next retained source range. Its timeline position may be earlier
  // after a manual reorder, but that is still the deterministic S -> T'
  // mapping for a source-based transcript selection.
  const next = document.segments
    .filter((item) => item.sourceStart > sourceTime)
    .sort((left, right) => left.sourceStart - right.sourceStart || left.timelineStart - right.timelineStart)[0];
  if (next) {
    return {
      timelineTime: next.timelineStart,
      sourceTime: next.sourceStart,
      segmentId: next.id,
      reason: "next-retained",
    };
  }
  return {
    timelineTime: document.duration,
    sourceTime: document.segments.at(-1)?.sourceEnd ?? 0,
    segmentId: document.segments.at(-1)?.id ?? null,
    reason: "end",
  };
}

export function timelineTimeForSourceAnchor(
  document: EditListDocument | null,
  sourceTime: number,
): number {
  return resolveTimelineAnchorForSourceTime(document, sourceTime).timelineTime;
}

function sameEditListDocument(left: EditListDocument, right: EditListDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invertTimelineOperation(
  document: EditListDocument | null,
  operation: EditListOperation,
): EditListOperation[] | null {
  if (!document) return null;
  try {
    const next = applyEditListOperation(document, operation);
    if (sameEditListDocument(document, next)) return null;
    if (operation.type === "restore") {
      const priorIds = new Set(document.segments.map((candidate) => candidate.id));
      const restored = next.segments.find((candidate) => !priorIds.has(candidate.id));
      return restored ? [{ type: "delete", clipId: restored.id }] : null;
    }
    if (operation.type === "delete-range") {
      return [{
        type: "restore-snapshot",
        expectedSegments: next.segments,
        beforeSegments: document.segments,
        beforeMode: document.mode,
        inverse: operation,
      }];
    }
    if (operation.type === "restore-snapshot") return null;
    const segment = document.segments.find((candidate) => candidate.id === operation.clipId);
    if (!segment) return null;
    if (operation.type === "move") {
      return [{ type: "move", clipId: segment.id, start: segment.timelineStart }];
    }
    if (operation.type === "trim") {
      return [{
        type: "trim",
        clipId: segment.id,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
      }];
    }
    if (operation.type === "split") {
      const beforeIds = new Set(document.segments.map((candidate) => candidate.id));
      const right = next.segments.find((candidate) => !beforeIds.has(candidate.id));
      if (!right) return null;
      return [
        {
          type: "trim",
          clipId: segment.id,
          sourceStart: segment.sourceStart,
          sourceEnd: segment.sourceEnd,
        },
        { type: "delete", clipId: right.id },
      ];
    }
    if (operation.type === "delete") {
      const previous = document.segments[indexOfSegment(document, segment) - 1];
      const nextSegment = document.segments[indexOfSegment(document, segment) + 1];
      return [{
        type: "restore",
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        ...(previous ? { previousSegmentId: previous.id } : {}),
        ...(nextSegment ? { nextSegmentId: nextSegment.id } : {}),
      }];
    }
  } catch {
    return null;
  }
  return null;
}

function indexOfSegment(document: EditListDocument, segment: { id: string }): number {
  return document.segments.findIndex((candidate) => candidate.id === segment.id);
}

function sameWordIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

export function CutWorkspace({
  projectId,
  initialTimelineTime,
  onTimelineTimeCommit,
}: {
  projectId: string;
  initialTimelineTime: number;
  onTimelineTimeCommit: (time: number) => void;
}) {
  const editList = useProjectEditList(projectId);
  const transcript = useKouboTranscript(projectId);
  const cutSelection = useProjectCutSelection(projectId, transcript.cues);
  const subtitles = useProjectSubtitles(projectId);
  const [featureTab, setFeatureTab] = useState<CutFeatureTab>("koubo");
  const [selectedSubtitleCueId, setSelectedSubtitleCueId] = useState<string | null>(null);
  const artifact = usePreviewArtifact(projectId, editList.revision);
  const artifactSource = artifact.state.source
    ? previewArtifactUrl(projectId, artifact.state.source)
    : null;
  // The transport is handed finished media, never an edit list to follow.
  //
  // It used to be given the ledger and told to jump `currentTime` at every retained
  // boundary. That leaked 150-400ms of deleted speech at each seam — setting
  // `currentTime` stops the decoder, not the sound already handed to the sound card
  // — and every available measurement said it was clean. Assembling the retained
  // ranges into one continuous stream first removes the boundary entirely.
  const fragmentUrl = useCallback(
    (source: string) => previewArtifactUrl(projectId, source),
    [projectId],
  );
  const transport = useAssembledVideoTransport({
    stream: artifact.state.stream ?? null,
    sourceUrl: artifactSource,
    resolveFragmentUrl: fragmentUrl,
    duration: editList.document?.duration ?? 0,
    initialTimelineTime,
  });
  // The transport publishes a new wrapper when timelineTime advances. Its seek
  // function itself is stable for one media source, so use that function as the
  // dependency of transcript seeking. Depending on the wrapper would recreate
  // `onSeek` every frame and defeat memoized cues.
  const transportSeek = transport.seek;
  const activeSource = artifactSource;
  const previousRevisionRef = useRef(editList.revision);
  const previousDocumentRef = useRef(editList.document);
  const desiredPlayingRef = useRef(false);
  const pendingAnchorRef = useRef<PlaybackAnchor | null>(null);
  const pendingArtifactSeekRef = useRef<PendingArtifactSeek | null>(null);
  const undoCommandsRef = useRef<ProductUndoCommand[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const [transcriptWidth, setTranscriptWidth] = useState(TRANSCRIPT_WIDTH_DEFAULT);
  const [isResizingTranscript, setIsResizingTranscript] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const editListPatchRef = useRef(editList.patchOperation);
  const cutSelectionUpdateRef = useRef(cutSelection.updateCutWordIds);
  editListPatchRef.current = editList.patchOperation;
  cutSelectionUpdateRef.current = cutSelection.updateCutWordIds;

  const syncUndoDepth = useCallback(() => {
    setUndoDepth(undoCommandsRef.current.length);
  }, []);

  const clearUndoCommands = useCallback(() => {
    undoCommandsRef.current = [];
    syncUndoDepth();
  }, [syncUndoDepth]);

  const pushUndoCommand = useCallback((command: ProductUndoCommand) => {
    undoCommandsRef.current = [...undoCommandsRef.current, command];
    syncUndoDepth();
  }, [syncUndoDepth]);

  const seek = useCallback((time: number, options?: { keepPlaying?: boolean }) => {
    const revisionAnchorPending = pendingAnchorRef.current?.editRevision === editList.revision;
    if (!artifact.current || revisionAnchorPending) {
      // A new EDL has no current media yet. Never seek the visible old artifact,
      // and do not let a just-arrived artifact's anchor overwrite the user's
      // newest target. Keep it until the revision migration is complete.
      pendingArtifactSeekRef.current = {
        projectId,
        editRevision: editList.revision,
        timelineTime: time,
        ...(options ? { options: { ...options } } : {}),
      };
      return;
    }
    pendingArtifactSeekRef.current = null;
    // Let transport preserve its private play intent. During a magnetic jump
    // the video is briefly paused even though playback should resume.
    if (options) void transportSeek(time, options);
    else void transportSeek(time);
  }, [artifact.current, editList.revision, projectId, transportSeek]);

  const patchTimelineOperation = useCallback(async (
    operation: EditListOperation,
    actor?: EditListActor,
  ) => {
    const inverseOperations = invertTimelineOperation(editList.document, operation);
    const nextDocument = await editList.patchOperation(operation, actor);
    if (inverseOperations) {
      pushUndoCommand({
        label: `timeline:${operation.type}`,
        undo: async () => {
          for (const inverse of inverseOperations) {
            await editListPatchRef.current(inverse);
          }
        },
      });
    }
    return nextDocument;
  }, [editList.document, editList.patchOperation, pushUndoCommand]);

  const updateCutWordIdsWithHistory = useCallback(async (
    next: ReadonlySet<string>,
    options: { recordUndo?: boolean } = {},
  ) => {
    const previous = new Set(cutSelection.cutWordIds);
    const shouldRecord = options.recordUndo !== false && !sameWordIdSet(previous, next);
    const saved = await cutSelection.updateCutWordIds(next, options);
    if (saved && shouldRecord) {
      pushUndoCommand({
        label: "transcript:selection",
        undo: async () => {
          await cutSelectionUpdateRef.current(previous, { recordUndo: false });
        },
      });
    }
    return saved;
  }, [cutSelection.cutWordIds, cutSelection.updateCutWordIds, pushUndoCommand]);

  // The two surfaces are indistinguishable once they reach the API, so each
  // declares itself here. Without this, the event log could say an edit happened
  // but never which pane the person was using.
  const patchFromTimeline = useCallback(
    (operation: EditListOperation) => patchTimelineOperation(operation, "studio-timeline"),
    [patchTimelineOperation],
  );
  const patchFromTranscript = useCallback(
    (operation: EditListOperation) => patchTimelineOperation(operation, "studio-transcript"),
    [patchTimelineOperation],
  );

  const timelineEditList = useMemo(() => ({
    ...editList,
    patchOperation: patchFromTimeline,
    canUndo: false,
    undoLastEditListChange: async () => undefined,
  }), [editList, patchFromTimeline]);

  const transcriptEditList = useMemo(() => ({
    projectId: editList.projectId,
    document: editList.document,
    revision: editList.revision,
    loading: editList.loading,
    ready: editList.ready,
    saveState: editList.saveState,
    reload: editList.reload,
    patchOperation: patchFromTranscript,
    canUndo: false,
    undoLastEditListChange: async () => undefined,
  }), [
    editList.document,
    editList.loading,
    editList.projectId,
    editList.ready,
    editList.reload,
    editList.revision,
    editList.saveState,
    patchTimelineOperation,
  ]);

  const transcriptForPanel = useMemo(() => ({
    cues: transcript.cues,
    loading: transcript.loading,
    error: transcript.error,
  }), [transcript.cues, transcript.error, transcript.loading]);

  const transcriptCutSelection = useMemo(() => ({
    cutWordIds: cutSelection.cutWordIds,
    saveState: cutSelection.saveState,
    selectionLoading: cutSelection.selectionLoading,
    selectionReady: cutSelection.selectionReady,
    updateCutWordIds: updateCutWordIdsWithHistory,
    canUndo: false,
    undoLastCutChange: () => undefined,
  }), [
    cutSelection.cutWordIds,
    cutSelection.saveState,
    cutSelection.selectionLoading,
    cutSelection.selectionReady,
    updateCutWordIdsWithHistory,
  ]);

  // Which line is on screen right now, already resolved to one style. The
  // player only draws; it is not given the document to interpret. Time comes
  // from the cut, like every other time in the product.
  const activeSubtitle = useMemo<ActiveSubtitle | null>(() => {
    const subtitleDocument = subtitles.document;
    if (!subtitleDocument) return null;
    const timing = subtitles.timings.find((candidate) => !candidate.orphaned
      && transport.timelineTime >= candidate.start
      && transport.timelineTime < candidate.end);
    if (!timing) return null;
    const cue = subtitleDocument.cues.find((candidate) => candidate.id === timing.cueId);
    if (!cue || !cue.text.trim()) return null;
    return { cueId: cue.id, text: cue.text, style: subtitleDocument.style };
  }, [subtitles.document, subtitles.timings, transport.timelineTime]);

  // Which module is on screen right now, already resolved to a URL. The player
  // only draws; it is not given the document to interpret. Time comes from the
  // cut, like every other time in the product.
  const visuals = useProjectVisuals(projectId);
  const activeVisual = useMemo<ActiveVisual | null>(() => {
    const timing = activeVisualLayer(visuals.timings, transport.timelineTime);
    if (!timing) return null;
    const layer = visuals.document?.layers.find((candidate) => candidate.id === timing.layerId);
    if (!layer) return null;
    // The script under the layer, moved onto the layer's own clock. Computed
    // from the same timings the subtitles draw from, so a module and a caption
    // can never disagree about when a sentence is said.
    const cues = subtitles.timings
      .filter((candidate) => !candidate.orphaned
        && candidate.end > timing.start && candidate.start < timing.end)
      .map((candidate) => ({
        text: subtitles.document?.cues.find((cue) => cue.id === candidate.cueId)?.text ?? "",
        start: candidate.start - timing.start,
        end: candidate.end - timing.start,
      }));
    return {
      layerId: layer.id,
      src: visuals.moduleUrl(layer.module),
      start: timing.start,
      duration: timing.duration,
      cues,
    };
  }, [
    visuals.document, visuals.timings, visuals.moduleUrl,
    subtitles.document, subtitles.timings, transport.timelineTime,
  ]);

  const canUndo = undoDepth > 0 && editList.saveState !== "saving" && cutSelection.saveState !== "saving";
  const undoLastChange = useCallback(async () => {
    if (editList.saveState === "saving" || cutSelection.saveState === "saving") return;
    const command = undoCommandsRef.current.at(-1);
    if (!command) return;
    undoCommandsRef.current = undoCommandsRef.current.slice(0, -1);
    syncUndoDepth();
    try {
      await command.undo();
    } catch (error) {
      undoCommandsRef.current = [...undoCommandsRef.current, command];
      syncUndoDepth();
      throw error;
    }
  }, [cutSelection.saveState, editList.saveState, syncUndoDepth]);

  useEffect(() => {
    clearUndoCommands();
  }, [clearUndoCommands, projectId]);

  useEffect(() => {
    if (editList.saveState !== "saving") return;
    const protectPendingSave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectPendingSave);
    return () => window.removeEventListener("beforeunload", protectPendingSave);
  }, [editList.saveState]);

  useEffect(() => {
    desiredPlayingRef.current = transport.desiredPlaying;
  }, [transport.desiredPlaying]);

  useEffect(() => {
    if (previousRevisionRef.current !== editList.revision) {
      if (previousDocumentRef.current) {
        const sourceTime = sourceTimeForTimeline(previousDocumentRef.current, transport.timelineTime);
        pendingAnchorRef.current = {
          editRevision: editList.revision,
          sourceTime: sourceTime ?? transport.timelineTime,
          timelineTime: transport.timelineTime,
        };
      }
      previousRevisionRef.current = editList.revision;
    }
    previousDocumentRef.current = editList.document;
  }, [editList.document, editList.revision, transport.desiredPlaying, transport.timelineTime]);

  useEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor || anchor.editRevision !== editList.revision || !artifact.current) return;
    const nextTimelineTime = timelineTimeForSourceAnchor(
      editList.document,
      anchor.sourceTime,
    );
    pendingAnchorRef.current = null;
    void transport.restoreIntent(nextTimelineTime, desiredPlayingRef.current);
    onTimelineTimeCommit(nextTimelineTime);
  }, [artifact.current, editList.document, editList.revision, onTimelineTimeCommit, transport]);

  useEffect(() => {
    const pending = pendingArtifactSeekRef.current;
    if (!pending) return;
    if (pending.projectId !== projectId || pending.editRevision !== editList.revision) {
      pendingArtifactSeekRef.current = null;
      return;
    }
    if (!artifact.current) return;
    pendingArtifactSeekRef.current = null;
    if (pending.options) void transport.seek(pending.timelineTime, pending.options);
    else void transport.seek(pending.timelineTime);
  }, [artifact.current, editList.revision, projectId, transport]);

  return (
    <section
      ref={workspaceRef}
      className="cf-cut-workspace"
      style={{ "--cf-cut-transcript-width": `${transcriptWidth}px` } as CSSProperties}
      data-project-id={projectId}
      data-player-media-count={activeSource ? "1" : "0"}
      data-koubo-layout="single-page"
      data-preview-artifact-phase={artifact.state.phase}
      data-preview-artifact-current={artifact.current ? "true" : "false"}
      data-preview-artifact-profile={artifact.state.profile ?? "none"}
      data-product-undo-depth={undoDepth}
      data-product-can-undo={canUndo ? "true" : "false"}
      data-edit-list-save-state={editList.saveState}
      data-cut-selection-save-state={cutSelection.saveState}
      data-transcript-resizing={isResizingTranscript ? "true" : "false"}
    >
      <CutFeaturePanel
        projectId={projectId}
        editList={transcriptEditList}
        transcript={transcriptForPanel}
        cutSelection={transcriptCutSelection}
        onSeek={seek}
        activeTab={featureTab}
        onTabChange={setFeatureTab}
        subtitleProblemCount={subtitles.stale.length}
        subtitleContent={
          <SubtitlePane
            subtitles={subtitles}
            transcriptCues={transcript.cues}
            selectedCueId={selectedSubtitleCueId}
            onSelectCue={setSelectedSubtitleCueId}
            onSeek={seek}
          />
        }
      />

      <SubtitlePlaybackMarker
        projectId={projectId}
        timings={subtitles.timings}
        timelineTime={transport.timelineTime}
      />

      <KouboTranscriptPlaybackMarker
        projectId={projectId}
        editList={transcriptEditList}
        transcript={transcriptForPanel}
        cutSelection={transcriptCutSelection}
        timelineTime={transport.timelineTime}
      />

      <TranscriptPaneResizer
        workspaceRef={workspaceRef}
        onWidthChange={setTranscriptWidth}
        onResizingChange={setIsResizingTranscript}
      />

      <CutPlayer
        sourceUrl={activeSource}
        transport={transport}
        onTimelineTimeCommit={onTimelineTimeCommit}
        artifactPhase={artifact.state.phase}
        artifactProfile={artifact.state.profile}
        onArtifactRetry={artifact.retry}
        subtitle={activeSubtitle}
        visual={activeVisual}
      />

      <CutInspector subtitles={subtitles} />

      <CutTimeline
        projectId={projectId}
        editList={timelineEditList}
        timelineTime={transport.timelineTime}
        onSeek={seek}
        canUndo={canUndo}
        onUndo={undoLastChange}
      />
    </section>
  );
}
