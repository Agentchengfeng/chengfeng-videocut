import { useEffect, useMemo, useRef, useState } from "react";
import { Wrench } from "../icons/SystemIcons";
import type { TimelineElement } from "../player";
import {
  buildCutTimeRanges,
  totalTimeRangeDuration,
  type TranscriptCue,
} from "./kouboTranscript";
import { readProjectJson } from "./projectJson";
import {
  buildVisualPlanSegments,
  isVisualTimelineElement,
  resolveSegmentElement,
  visualPlanMatchesCutSelection,
  withVisualPlanCutSync,
  type VisualPlanSegment,
} from "./visualPlan";

interface VisualStoryboardPanelProps {
  projectId: string;
  cues: TranscriptCue[];
  cutWordIds: ReadonlySet<string>;
  transcriptLoading: boolean;
  cutSelectionLoading: boolean;
  cutSelectionReady: boolean;
  playheadTime: number;
  elements: TimelineElement[];
  requestSeek: (time: number) => void;
  setSelectedElementId: (id: string | null) => void;
}

function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, "0")}.${tenths}`;
}

function elementKey(element: TimelineElement): string {
  return element.key ?? element.id;
}

export function VisualStoryboardPanel({
  projectId,
  cues,
  cutWordIds,
  transcriptLoading,
  cutSelectionLoading,
  cutSelectionReady,
  playheadTime,
  elements,
  requestSeek,
  setSelectedElementId,
}: VisualStoryboardPanelProps) {
  const [planPayload, setPlanPayload] = useState<unknown>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [repairState, setRepairState] = useState<"idle" | "saving" | "error">("idle");
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const visualElements = useMemo(
    () => elements.filter(isVisualTimelineElement),
    [elements],
  );
  const segments = useMemo(
    () => buildVisualPlanSegments(planPayload, cues, visualElements, cutWordIds),
    [cues, cutWordIds, planPayload, visualElements],
  );
  const cutRanges = useMemo(
    () => buildCutTimeRanges(cues.flatMap((cue) => cue.words), cutWordIds),
    [cues, cutWordIds],
  );
  const cutDuration = useMemo(() => totalTimeRangeDuration(cutRanges), [cutRanges]);
  const cutSynced = useMemo(
    () => visualPlanMatchesCutSelection(planPayload, cutWordIds),
    [cutWordIds, planPayload],
  );
  const visibleSegments = useMemo(
    () => cutSynced ? segments.filter((segment) => !segment.fullyCut) : segments,
    [cutSynced, segments],
  );
  const removedSegmentCount = segments.length - visibleSegments.length;
  const activeSegmentId = useMemo(
    () =>
      visibleSegments.find(
        (segment) => playheadTime >= segment.start && playheadTime < segment.end,
      )?.id ?? null,
    [playheadTime, visibleSegments],
  );

  useEffect(() => {
    let cancelled = false;
    setPlanLoading(true);
    setRepairState("idle");
    setPlanPayload(null);
    void (async () => {
      let nextPlanPayload: unknown | null = null;
      try {
        nextPlanPayload = await readProjectJson(projectId, "visual-plan.json");
      } catch {
        // Projects without an authored visual plan use the transcript fallback.
      }

      if (cancelled) return;
      setPlanPayload(nextPlanPayload);
      setPlanLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!activeSegmentId) return;
    cardRefs.current.get(activeSegmentId)?.scrollIntoView({
      block: "nearest",
      behavior: "auto",
    });
  }, [activeSegmentId]);

  const handleSelect = (segment: VisualPlanSegment) => {
    requestSeek(cutSynced ? segment.seekStart : segment.start);
    const element = resolveSegmentElement(segment, visualElements);
    setSelectedElementId(element ? elementKey(element) : null);
  };

  const handleRepair = () => {
    if (!cutSelectionReady) return;
    const nextPlan = withVisualPlanCutSync(
      planPayload,
      cutWordIds,
      new Date().toISOString(),
    );
    setRepairState("saving");
    void fetch(
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent("visual-plan.json")}`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(nextPlan, null, 2),
      },
    ).then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      setPlanPayload(nextPlan);
      setRepairState("idle");
    }).catch(() => {
      setRepairState("error");
    });
  };

  return (
    <section className="cf-visual-storyboard" aria-label="画面分段">
      {!cutSynced &&
        cutSelectionReady &&
        !transcriptLoading &&
        !cutSelectionLoading &&
        !planLoading && (
        <div className="cf-visual-repair" role="status">
          <span>
            <strong>画面时间待同步</strong>
            <small>
              {cutWordIds.size > 0
                ? `已删除 ${cutWordIds.size} 词，共 ${cutDuration.toFixed(1)}s`
                : "删减已恢复，需要重置画面时间"}
            </small>
          </span>
          <button
            type="button"
            onClick={handleRepair}
            disabled={repairState === "saving"}
          >
            <Wrench size={13} />
            <span>{repairState === "saving" ? "修复中" : "修复"}</span>
          </button>
          {repairState === "error" && <em>修复失败，请重试</em>}
        </div>
      )}
      <div className="cf-visual-storyboard-list">
        {transcriptLoading || cutSelectionLoading || planLoading ? (
          <div className="cf-task-empty">正在载入画面规划</div>
        ) : !cutSelectionReady ? (
          <div className="cf-task-empty">剪口播数据载入失败，画面同步已停用</div>
        ) : visibleSegments.length === 0 ? (
          <div className="cf-task-empty">暂无画面规划</div>
        ) : (
          visibleSegments.map((segment, index) => {
            const active = segment.id === activeSegmentId;
            const displayStart = cutSynced ? segment.editedStart : segment.start;
            const displayEnd = cutSynced ? segment.editedEnd : segment.end;
            return (
              <button
                key={segment.id}
                ref={(node) => {
                  if (node) cardRefs.current.set(segment.id, node);
                  else cardRefs.current.delete(segment.id);
                }}
                type="button"
                className={`cf-visual-scene-card${active ? " is-active" : ""}`}
                data-segment-id={segment.id}
                aria-current={active ? "true" : undefined}
                onClick={() => handleSelect(segment)}
              >
                <span className="cf-visual-scene-marker" aria-hidden="true" />
                <span className="cf-visual-scene-body">
                  <span className="cf-visual-scene-meta">
                    <strong>{String(index + 1).padStart(2, "0")}</strong>
                    <time>
                      {cutSynced && cutWordIds.size > 0 && <small>剪后</small>}
                      {formatTimestamp(displayStart)} - {formatTimestamp(displayEnd)}
                    </time>
                    <em>{segment.kind}</em>
                  </span>
                  <span className="cf-visual-scene-script">
                    {cutSynced ? segment.editedTranscript : segment.transcript}
                  </span>
                  <span className="cf-visual-scene-plan">
                    <strong>{segment.title}</strong>
                    <span>{segment.description}</span>
                    {segment.syncState !== "linked" && (
                      <span className="cf-visual-scene-sync">字幕锚点已变化，需要重新绑定</span>
                    )}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
      {cutSynced && removedSegmentCount > 0 && (
        <footer className="cf-visual-storyboard-footer">
          已随口播移除 {removedSegmentCount} 段画面
        </footer>
      )}
    </section>
  );
}
