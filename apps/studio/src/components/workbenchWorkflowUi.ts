import type {
  WorkbenchAspectRatio,
  WorkbenchFinalConfig,
  WorkbenchWorkflowAction,
  WorkbenchWorkflowResource,
} from "./workflowApi";

export type WorkbenchTaskTab = "cut" | "visual";

export interface WorkflowHeaderAction {
  action: WorkbenchWorkflowAction;
  label: string;
}

export const APPLY_CUT_CONFIRMATION_MESSAGE =
  "确认执行剪辑？\n\n将按当前已删除区间生成剪后视频，执行期间不可重复提交。";

export function confirmWorkflowAction(
  action: WorkbenchWorkflowAction,
  confirmAction: (message: string) => boolean,
): boolean {
  return action !== "apply-cut" || confirmAction(APPLY_CUT_CONFIRMATION_MESSAGE);
}

const VISUAL_REVIEW_ACTIONS: Partial<Record<string, WorkflowHeaderAction>> = {
  final_config_ready: { action: "start-final", label: "开始成片" },
  storyboard_review_ready: {
    action: "confirm-storyboard",
    label: "确认分镜",
  },
  animation_review_ready: {
    action: "confirm-animation",
    label: "确认动画",
  },
  timeline_review_ready: {
    action: "confirm-timeline",
    label: "确认时间线",
  },
};

const ACTION_ALLOWED_STATUS: Record<WorkbenchWorkflowAction, string> = {
  "apply-cut": "cut_review_ready",
  "start-final": "final_config_ready",
  "confirm-storyboard": "storyboard_review_ready",
  "confirm-animation": "animation_review_ready",
  "confirm-timeline": "timeline_review_ready",
};

export function isWorkflowActionAvailable(
  status: string,
  action: WorkbenchWorkflowAction,
): boolean {
  return ACTION_ALLOWED_STATUS[action] === status;
}

export function isWorkflowActionBlocked(
  workflow: WorkbenchWorkflowResource,
  action: WorkbenchWorkflowAction,
): boolean {
  return action === "start-final" && workflow.artifact.state !== "current";
}

export function resolveWorkflowHeaderAction(
  status: string | null | undefined,
  tab: WorkbenchTaskTab,
): WorkflowHeaderAction | null {
  if (!status) return null;
  if (tab === "cut") {
    return status === "cut_review_ready"
      ? { action: "apply-cut", label: "执行剪辑" }
      : null;
  }
  return VISUAL_REVIEW_ACTIONS[status] ?? null;
}

export function isWorkflowRunningStatus(status: string): boolean {
  return (
    status === "cutting" ||
    status === "render_requested" ||
    status === "rendering" ||
    status === "verifying" ||
    status.endsWith("_running")
  );
}

export function shouldPollWorkflow(status: string | null | undefined): boolean {
  return Boolean(
    status &&
    (status === "codex_continue_required" || isWorkflowRunningStatus(status)),
  );
}

function readConfigString(
  config: Record<string, unknown> | null,
  key: string,
): string {
  return typeof config?.[key] === "string" ? config[key].trim() : "";
}

export function normalizeWorkbenchFinalConfig(
  config: Record<string, unknown> | null | undefined,
): WorkbenchFinalConfig {
  const aspectRatio = readConfigString(config ?? null, "aspectRatio");
  const validAspectRatio: WorkbenchAspectRatio =
    aspectRatio === "16:9" || aspectRatio === "4:3" ? aspectRatio : "3:4";
  return {
    aspectRatio: validAspectRatio,
    animationStyle: readConfigString(config ?? null, "animationStyle") || "xiaohei",
    requirements: readConfigString(config ?? null, "requirements"),
  };
}

export interface WorkflowNoticeCopy {
  tone: "neutral" | "progress" | "error" | "success";
  title: string;
  detail: string;
}

function continueDetail(workflow: WorkbenchWorkflowResource): string {
  const continuation = workflow.project.codexContinue;
  return (
    (typeof continuation?.reason === "string" && continuation.reason.trim()) ||
    (typeof continuation?.prompt === "string" && continuation.prompt.trim()) ||
    "Agent 已收到下一步，完成后工作台会刷新状态。"
  );
}

export function resolveWorkflowNotice(
  workflow: WorkbenchWorkflowResource,
  tab: WorkbenchTaskTab,
): WorkflowNoticeCopy | null {
  const status = workflow.project.status;
  if (status === "failed") {
    return {
      tone: "error",
      title: "任务执行失败",
      detail: "刷新状态后可重试；工作台不会重复提交正在执行的动作。",
    };
  }
  if (status === "cutting") {
    return {
      tone: "progress",
      title: "正在执行剪辑",
      detail: "正在生成剪后视频，请勿重复提交。",
    };
  }
  if (workflow.artifact.state !== "current") {
    return {
      tone: "error",
      title: "成片需重新生成",
      detail: "当前剪后视频未生成、来自旧版或已与最新编辑不一致；不可开始画面成片。请先在“剪口播”执行剪辑。",
    };
  }
  if (status === "codex_continue_required") {
    const stage = workflow.project.codexContinue?.stage;
    return {
      tone: "progress",
      title: stage === "subtitle_rebuild"
        ? "等待 Agent 重建字幕"
        : "Agent 下一步",
      detail: continueDetail(workflow),
    };
  }
  if (isWorkflowRunningStatus(status)) {
    return {
      tone: "progress",
      title: "Agent 正在处理下一步",
      detail: continueDetail(workflow),
    };
  }
  if (status === "done") {
    const aspectRatio = readConfigString(workflow.project.config, "aspectRatio");
    return {
      tone: "success",
      title: "成片已完成",
      detail: `${aspectRatio ? `${aspectRatio} · ` : ""}音频、画面、字幕与验证帧均已通过检查。`,
    };
  }
  if (tab === "cut" && status === "final_config_ready") {
    return {
      tone: "success",
      title: "剪辑与转录已完成",
      detail: "可切换到“画面成片”设置比例和动画风格。",
    };
  }
  if (
    tab === "visual" &&
    ["cut_review_ready", "cutting", "subtitle_rebuild_running"].includes(status)
  ) {
    return {
      tone: "neutral",
      title: "画面成片尚未开始",
      detail: "先完成剪口播和剪后转录，再进入成片配置。",
    };
  }
  return null;
}

export function shouldShowVisualArtifact(status: string): boolean {
  return [
    "storyboard_review_ready",
    "animation_review_ready",
    "timeline_review_ready",
    "render_requested",
    "rendering",
    "verifying",
    "done",
  ].includes(status);
}
