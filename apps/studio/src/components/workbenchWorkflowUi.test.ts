import { describe, expect, it } from "vitest";
import {
  APPLY_CUT_CONFIRMATION_MESSAGE,
  confirmWorkflowAction,
  isWorkflowActionBlocked,
  normalizeWorkbenchFinalConfig,
  isWorkflowActionAvailable,
  resolveWorkflowHeaderAction,
  resolveWorkflowNotice,
  shouldPollWorkflow,
  shouldShowVisualArtifact,
} from "./workbenchWorkflowUi";
import type { WorkbenchWorkflowResource } from "./workflowApi";

function workflow(
  status: string,
  codexContinue: WorkbenchWorkflowResource["project"]["codexContinue"] = null,
): WorkbenchWorkflowResource {
  return {
    schemaVersion: 1,
    projectId: "demo",
    revision: "a".repeat(64),
    editListRevision: "e".repeat(64),
    artifact: {
      state: "current",
      editListRevision: "e".repeat(64),
      path: "剪口播/3_审核/source_cut.mp4",
    },
    project: {
      status,
      config: null,
      artifacts: null,
      codexContinue,
    },
  };
}

describe("workbench workflow UI contract", () => {
  it("requires a native second confirmation only for apply-cut", () => {
    const reject = (message: string) => {
      expect(message).toBe(APPLY_CUT_CONFIRMATION_MESSAGE);
      return false;
    };
    expect(confirmWorkflowAction("apply-cut", reject)).toBe(false);
    expect(confirmWorkflowAction("start-final", () => {
      throw new Error("final actions must not open the cut confirmation");
    })).toBe(true);
  });

  it("exposes only the action owned by the active task tab", () => {
    expect(resolveWorkflowHeaderAction("cut_review_ready", "cut")).toEqual({
      action: "apply-cut",
      label: "执行剪辑",
    });
    expect(resolveWorkflowHeaderAction("cut_review_ready", "visual")).toBeNull();
    expect(resolveWorkflowHeaderAction("final_config_ready", "visual")).toEqual({
      action: "start-final",
      label: "开始成片",
    });
    expect(resolveWorkflowHeaderAction("storyboard_review_ready", "visual")?.label)
      .toBe("确认分镜");
    expect(resolveWorkflowHeaderAction("animation_review_ready", "visual")?.label)
      .toBe("确认动画");
    expect(resolveWorkflowHeaderAction("timeline_review_ready", "visual")?.label)
      .toBe("确认时间线");
    expect(resolveWorkflowHeaderAction("codex_continue_required", "visual"))
      .toBeNull();
    expect(resolveWorkflowHeaderAction("animation_running", "visual")).toBeNull();
    expect(isWorkflowActionAvailable("cut_review_ready", "apply-cut")).toBe(true);
    expect(isWorkflowActionAvailable("cutting", "apply-cut")).toBe(false);
  });

  it("uses the product defaults and preserves a supported saved ratio", () => {
    expect(normalizeWorkbenchFinalConfig(null)).toEqual({
      aspectRatio: "3:4",
      animationStyle: "xiaohei",
      requirements: "",
    });
    expect(normalizeWorkbenchFinalConfig({
      aspectRatio: "4:3",
      animationStyle: "custom",
      requirements: "保留录屏",
    })).toEqual({
      aspectRatio: "4:3",
      animationStyle: "custom",
      requirements: "保留录屏",
    });
  });

  it("blocks visual production and explains every non-current cut artifact", () => {
    for (const state of ["missing", "legacy", "stale"] as const) {
      const resource = workflow("final_config_ready");
      resource.artifact = state === "missing"
        ? { state, editListRevision: null, path: null }
        : state === "legacy"
          ? { state, editListRevision: null, path: "剪口播/3_审核/source_cut.mp4" }
          : { state, editListRevision: "d".repeat(64), path: "剪口播/3_审核/source_cut.mp4" };

      expect(isWorkflowActionBlocked(resource, "start-final")).toBe(true);
      expect(resolveWorkflowNotice(resource, "visual")).toEqual({
        tone: "error",
        title: "成片需重新生成",
        detail: "当前剪后视频未生成、来自旧版或已与最新编辑不一致；不可开始画面成片。请先在“剪口播”执行剪辑。",
      });
    }

    const current = workflow("final_config_ready");
    expect(isWorkflowActionBlocked(current, "start-final")).toBe(false);
  });

  it("shows the real Agent continuation instead of inventing an artifact", () => {
    const notice = resolveWorkflowNotice(workflow("codex_continue_required", {
      required: true,
      stage: "subtitle_rebuild",
      reason: "基于剪后视频重新转写并校对字幕。",
    }), "cut");
    expect(notice).toEqual({
      tone: "progress",
      title: "等待 Agent 重建字幕",
      detail: "基于剪后视频重新转写并校对字幕。",
    });
    expect(shouldShowVisualArtifact("codex_continue_required")).toBe(false);
    expect(shouldShowVisualArtifact("animation_running")).toBe(false);
    expect(shouldShowVisualArtifact("storyboard_review_ready")).toBe(true);
    expect(shouldShowVisualArtifact("done")).toBe(true);
  });

  it("describes cutting and failure without exposing a duplicate action", () => {
    expect(resolveWorkflowNotice(workflow("cutting"), "cut")).toMatchObject({
      tone: "progress",
      title: "正在执行剪辑",
    });
    expect(resolveWorkflowHeaderAction("cutting", "cut")).toBeNull();
    expect(resolveWorkflowNotice(workflow("failed"), "cut")).toMatchObject({
      tone: "error",
      title: "任务执行失败",
    });
    expect(resolveWorkflowHeaderAction("failed", "cut")).toBeNull();
  });

  it("polls only waiting/running states that can advance externally", () => {
    expect(shouldPollWorkflow("codex_continue_required")).toBe(true);
    expect(shouldPollWorkflow("cutting")).toBe(true);
    expect(shouldPollWorkflow("timeline_running")).toBe(true);
    expect(shouldPollWorkflow("verifying")).toBe(true);
    expect(shouldPollWorkflow("cut_review_ready")).toBe(false);
    expect(shouldPollWorkflow("failed")).toBe(false);
  });

  it("keeps the verified final result visible after the workflow is done", () => {
    const finished = workflow("done");
    finished.project.config = { aspectRatio: "4:3" };
    finished.project.artifacts = { finalVideo: "renders/final.mp4" };
    expect(resolveWorkflowNotice(finished, "visual")).toEqual({
      tone: "success",
      title: "成片已完成",
      detail: "4:3 · 音频、画面、字幕与验证帧均已通过检查。",
    });
    expect(resolveWorkflowHeaderAction("done", "visual")).toBeNull();
  });
});
