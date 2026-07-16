import { useEffect, useId, useState } from "react";
import { Film, Scissors } from "../icons/SystemIcons";
import { liveTime, usePlayerStore } from "../player";
import { KouboTranscriptPanel } from "./KouboTranscriptPanel";
import { useProjectCutSelection } from "./useProjectCutSelection";
import { useProjectTranscript } from "./useProjectTranscript";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { VisualStoryboardPanel } from "./VisualStoryboardPanel";
import {
  confirmWorkflowAction,
  normalizeWorkbenchFinalConfig,
  resolveWorkflowHeaderAction,
  resolveWorkflowNotice,
  shouldShowVisualArtifact,
  type WorkbenchTaskTab,
  type WorkflowNoticeCopy,
} from "./workbenchWorkflowUi";
import type {
  WorkbenchFinalConfig,
  WorkbenchWorkflowAction,
  WorkbenchWorkflowResource,
} from "./workflowApi";

function projectPreviewAssetUrl(projectId: string, relativePath: string): string {
  const path = relativePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/api/projects/${encodeURIComponent(projectId)}/preview/${path}`;
}

function FinalVideoResult({
  projectId,
  workflow,
}: {
  projectId: string;
  workflow: WorkbenchWorkflowResource;
}) {
  const [open, setOpen] = useState(false);
  const value = workflow.project.artifacts?.finalVideo;
  const finalVideo = typeof value === "string" ? value.trim() : "";
  if (workflow.project.status !== "done" || !finalVideo) return null;
  const source = projectPreviewAssetUrl(projectId, finalVideo);
  return (
    <div className="cf-final-video-result">
      <div className="cf-final-video-link">
        <span>已验证成片</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起成片" : "播放成片"}
        </button>
      </div>
      {open && (
        <video
          className="cf-final-video-player"
          src={source}
          controls
          playsInline
          preload="metadata"
        />
      )}
    </div>
  );
}

function WorkflowNotice({ notice }: { notice: WorkflowNoticeCopy }) {
  return (
    <div
      className={`cf-workflow-notice is-${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
      aria-live={notice.tone === "error" ? "assertive" : "polite"}
    >
      <strong>{notice.title}</strong>
      <span>{notice.detail}</span>
    </div>
  );
}

function WorkflowStatePanel({
  notice,
  status,
  retry,
  retrying,
}: {
  notice: WorkflowNoticeCopy | null;
  status: string;
  retry?: () => void;
  retrying?: boolean;
}) {
  const fallback: WorkflowNoticeCopy = {
    tone: "neutral",
    title: "当前没有可审核的画面产物",
    detail: `任务状态：${status}`,
  };
  const copy = notice ?? fallback;
  return (
    <section className="cf-workflow-state" aria-live="polite">
      <WorkflowNotice notice={copy} />
      {retry && (
        <button type="button" onClick={retry} disabled={retrying}>
          {retrying ? "刷新中" : "重新加载"}
        </button>
      )}
    </section>
  );
}

function FinalConfigPanel({
  formId,
  config,
  disabled,
  onChange,
  onSubmit,
}: {
  formId: string;
  config: WorkbenchFinalConfig;
  disabled: boolean;
  onChange: (next: WorkbenchFinalConfig) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      id={formId}
      className="cf-final-config"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="cf-final-config-intro">
        <strong>成片配置</strong>
        <span>确认后由 Agent 生成分镜；当前不会预先生成画面。</span>
      </div>
      <div className="cf-final-config-grid">
        <label>
          <span>画面比例</span>
          <select
            value={config.aspectRatio}
            disabled={disabled}
            onChange={(event) => onChange({
              ...config,
              aspectRatio: event.target.value as WorkbenchFinalConfig["aspectRatio"],
            })}
          >
            <option value="3:4">3:4</option>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
          </select>
        </label>
        <label>
          <span>动画风格</span>
          <input
            value={config.animationStyle}
            disabled={disabled}
            required
            onChange={(event) => onChange({
              ...config,
              animationStyle: event.target.value,
            })}
          />
        </label>
        <label className="cf-final-config-requirements">
          <span>补充要求</span>
          <textarea
            rows={3}
            value={config.requirements}
            disabled={disabled}
            placeholder="例如：优先保留真人画面，关键概念再做解释动画"
            onChange={(event) => onChange({
              ...config,
              requirements: event.target.value,
            })}
          />
        </label>
      </div>
    </form>
  );
}

export function WorkbenchTaskPanel({ projectId }: { projectId: string }) {
  const [activeTab, setActiveTab] = useState<WorkbenchTaskTab>("cut");
  const [playheadTime, setPlayheadTime] = useState(
    () => usePlayerStore.getState().currentTime,
  );
  const finalConfigFormId = useId();
  const elements = usePlayerStore((state) => state.elements);
  const duration = usePlayerStore((state) => state.duration);
  const setSelectedElementId = usePlayerStore(
    (state) => state.setSelectedElementId,
  );
  const requestSeek = usePlayerStore((state) => state.requestSeek);
  const { cues, loading: transcriptLoading } = useProjectTranscript(projectId);
  const {
    cutWordIds,
    saveState,
    selectionLoading,
    selectionReady,
    updateCutWordIds,
  } = useProjectCutSelection(projectId, cues);
  const {
    workflow,
    loading: workflowLoading,
    refreshing,
    pendingAction,
    committedAction,
    error: workflowError,
    refresh: refreshWorkflow,
    runAction,
  } = useProjectWorkflow(projectId);
  const [finalConfig, setFinalConfig] = useState<WorkbenchFinalConfig>(() =>
    normalizeWorkbenchFinalConfig(null),
  );

  useEffect(() => {
    setPlayheadTime(usePlayerStore.getState().currentTime);
    const unsubscribe = liveTime.subscribe(setPlayheadTime);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!workflow || workflow.project.status !== "final_config_ready") return;
    setFinalConfig(normalizeWorkbenchFinalConfig(workflow.project.config));
  }, [workflow]);

  const status = workflow?.project.status ?? null;
  const headerAction = resolveWorkflowHeaderAction(status, activeTab);
  const workflowNotice = workflow ? resolveWorkflowNotice(workflow, activeTab) : null;
  const notice: WorkflowNoticeCopy | null = committedAction
    ? {
        tone: "progress",
        title: "动作已提交",
        detail: "正在等待服务更新任务状态，请勿重复提交。",
      }
    : workflowNotice;
  const cutActionBlocked =
    !selectionReady ||
    selectionLoading ||
    transcriptLoading ||
    saveState === "saving" ||
    saveState === "error";
  const actionDisabled = Boolean(
    !headerAction ||
    pendingAction ||
    committedAction ||
    refreshing ||
    (headerAction?.action === "apply-cut" && cutActionBlocked) ||
    (headerAction?.action === "start-final" && !finalConfig.animationStyle.trim()),
  );
  const actionTitle = headerAction?.action === "apply-cut" && cutActionBlocked
    ? "请等待转录和删减选择保存完成"
    : undefined;

  const submitAction = (action: WorkbenchWorkflowAction) => {
    if (!confirmWorkflowAction(action, (message) => window.confirm(message))) return;
    const config = action === "start-final"
      ? {
          ...finalConfig,
          animationStyle: finalConfig.animationStyle.trim(),
          requirements: finalConfig.requirements.trim(),
        }
      : undefined;
    void runAction(action, config);
  };

  const headerButton = headerAction ? (() => {
    const formAction = headerAction.action === "start-final";
    return (
      <button
        type={formAction ? "submit" : "button"}
        form={formAction ? finalConfigFormId : undefined}
        className="cf-workflow-primary-action"
        disabled={actionDisabled}
        title={actionTitle}
        onClick={formAction ? undefined : () => submitAction(headerAction.action)}
      >
        {pendingAction === headerAction.action
          ? "提交中"
          : committedAction === headerAction.action
            ? "已提交"
            : headerAction.label}
      </button>
    );
  })() : null;

  const visualContent = (() => {
    if (!workflow) {
      return (
        <WorkflowStatePanel
          notice={{
            tone: workflowError ? "error" : "progress",
            title: workflowError ? "任务状态读取失败" : "正在读取任务状态",
            detail: workflowError ?? "正在连接本地 chengfeng-videocut 服务。",
          }}
          status="loading"
          retry={workflowError ? () => void refreshWorkflow() : undefined}
          retrying={workflowLoading || refreshing}
        />
      );
    }
    if (workflow.project.status === "final_config_ready") {
      return (
        <FinalConfigPanel
          formId={finalConfigFormId}
          config={finalConfig}
          disabled={Boolean(pendingAction) || refreshing}
          onChange={setFinalConfig}
          onSubmit={() => {
            if (!actionDisabled) submitAction("start-final");
          }}
        />
      );
    }
    if (shouldShowVisualArtifact(workflow.project.status)) {
      return (
        <>
          {notice && <WorkflowNotice notice={notice} />}
          <FinalVideoResult projectId={projectId} workflow={workflow} />
          <VisualStoryboardPanel
            projectId={projectId}
            cues={cues}
            cutWordIds={cutWordIds}
            transcriptLoading={transcriptLoading}
            cutSelectionLoading={selectionLoading}
            cutSelectionReady={selectionReady}
            playheadTime={playheadTime}
            elements={elements}
            requestSeek={requestSeek}
            setSelectedElementId={setSelectedElementId}
          />
        </>
      );
    }
    return (
      <WorkflowStatePanel
        notice={notice}
        status={workflow.project.status}
        retry={workflow.project.status === "failed"
          ? () => void refreshWorkflow()
          : undefined}
        retrying={refreshing}
      />
    );
  })();

  return (
    <aside className="cf-task-panel" aria-label="口播任务功能区">
      <div className="cf-task-header">
        <div className="cf-task-tabs" role="tablist" aria-label="任务类型">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "cut"}
            className={activeTab === "cut" ? "is-active" : ""}
            onClick={() => setActiveTab("cut")}
          >
            <Scissors size={15} />
            <span>剪口播</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "visual"}
            className={activeTab === "visual" ? "is-active" : ""}
            onClick={() => setActiveTab("visual")}
          >
            <Film size={15} />
            <span>画面成片</span>
          </button>
        </div>
        <div className="cf-task-header-action">{headerButton}</div>
      </div>

      <div
        className="cf-task-panel-body"
        aria-busy={Boolean(pendingAction || committedAction)}
      >
        {workflowError && workflow && (
          <div className="cf-workflow-error" role="alert" aria-live="assertive">
            <span>
              {workflowError}
              {headerAction && !committedAction
                ? " 可再次点击右上主按钮重试。"
                : ""}
            </span>
            <button
              type="button"
              onClick={() => void refreshWorkflow()}
              disabled={refreshing}
            >
              {refreshing ? "刷新中" : "刷新状态"}
            </button>
          </div>
        )}
        {activeTab === "cut" ? (
          workflow ? (
            <>
              {notice && <WorkflowNotice notice={notice} />}
              <KouboTranscriptPanel
                cues={cues}
                loading={transcriptLoading || selectionLoading}
                cutWordIds={cutWordIds}
                saveState={saveState}
                onCutWordIdsChange={updateCutWordIds}
                playheadTime={playheadTime}
                duration={duration}
                requestSeek={requestSeek}
              />
            </>
          ) : (
            <WorkflowStatePanel
              notice={{
                tone: workflowError ? "error" : "progress",
                title: workflowError ? "任务状态读取失败" : "正在读取任务状态",
                detail: workflowError ?? "正在连接本地 chengfeng-videocut 服务。",
              }}
              status="loading"
              retry={workflowError ? () => void refreshWorkflow() : undefined}
              retrying={workflowLoading || refreshing}
            />
          )
        ) : visualContent}
      </div>
    </aside>
  );
}
