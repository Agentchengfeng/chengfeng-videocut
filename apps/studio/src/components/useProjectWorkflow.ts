import { useCallback, useEffect, useRef, useState } from "react";
import {
  getProjectWorkflow,
  postProjectWorkflowAction,
  WorkflowApiError,
  type WorkbenchFinalConfig,
  type WorkbenchWorkflowAction,
  type WorkbenchWorkflowResource,
} from "./workflowApi";
import {
  isWorkflowActionAvailable,
  shouldPollWorkflow,
} from "./workbenchWorkflowUi";

type LoadMode = "foreground" | "background";

function workflowErrorMessage(error: unknown): string {
  if (!(error instanceof WorkflowApiError)) {
    return "任务状态读取失败，请重试。";
  }
  if (error.status === 0) {
    return "无法连接本地 chengfeng-videocut 服务，请确认服务已启动。";
  }
  if (error.code === "revision_conflict") {
    return "任务状态已更新，请按最新状态重试。";
  }
  if (error.code === "revision_required") {
    return "缺少用户确认时的时间线版本，请重新确认后再执行剪辑。";
  }
  if (error.code === "missing_artifact") {
    return "所需产物尚未准备好，请先让 Agent 完成当前步骤。";
  }
  if (error.code === "invalid_state") {
    return "当前步骤已经变化，请刷新后重试。";
  }
  if (error.code === "task_running") {
    return "已有任务正在执行，请等待状态刷新。";
  }
  if (error.status === 409) {
    return "任务状态已更新，请按最新状态重试。";
  }
  return error.message || "工作流操作失败，请重试。";
}

export interface ProjectWorkflowState {
  workflow: WorkbenchWorkflowResource | null;
  loading: boolean;
  refreshing: boolean;
  pendingAction: WorkbenchWorkflowAction | null;
  committedAction: WorkbenchWorkflowAction | null;
  error: string | null;
  refresh: () => Promise<boolean>;
  runAction: (
    action: WorkbenchWorkflowAction,
    config?: WorkbenchFinalConfig,
    expectedEditListRevision?: string,
  ) => Promise<boolean>;
}

export function useProjectWorkflow(projectId: string): ProjectWorkflowState {
  const [workflow, setWorkflow] = useState<WorkbenchWorkflowResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<WorkbenchWorkflowAction | null>(null);
  const [committedAction, setCommittedAction] =
    useState<WorkbenchWorkflowAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workflowRef = useRef<WorkbenchWorkflowResource | null>(null);
  const projectEpochRef = useRef(0);
  const loadRevisionRef = useRef(0);
  const actionPendingRef = useRef(false);
  const committedActionRef = useRef<WorkbenchWorkflowAction | null>(null);

  const loadWorkflow = useCallback(async (mode: LoadMode): Promise<boolean> => {
    const epoch = projectEpochRef.current;
    const revision = ++loadRevisionRef.current;
    if (mode === "foreground") {
      if (workflowRef.current) setRefreshing(true);
      else setLoading(true);
      setError(null);
    }
    try {
      const resource = await getProjectWorkflow(projectId);
      if (
        projectEpochRef.current !== epoch ||
        loadRevisionRef.current !== revision
      ) return false;
      workflowRef.current = resource;
      setWorkflow(resource);
      const committed = committedActionRef.current;
      if (
        committed &&
        !isWorkflowActionAvailable(resource.project.status, committed)
      ) {
        committedActionRef.current = null;
        setCommittedAction(null);
      }
      setLoading(false);
      if (mode === "foreground") setError(null);
      return true;
    } catch (caught) {
      if (
        projectEpochRef.current === epoch &&
        loadRevisionRef.current === revision &&
        mode === "foreground"
      ) {
        setLoading(false);
        setError(workflowErrorMessage(caught));
      }
      return false;
    } finally {
      if (
        projectEpochRef.current === epoch &&
        loadRevisionRef.current === revision &&
        mode === "foreground"
      ) {
        setRefreshing(false);
      }
    }
  }, [projectId]);

  const refresh = useCallback(
    () => loadWorkflow("foreground"),
    [loadWorkflow],
  );

  useEffect(() => {
    projectEpochRef.current += 1;
    loadRevisionRef.current += 1;
    actionPendingRef.current = false;
    committedActionRef.current = null;
    workflowRef.current = null;
    setWorkflow(null);
    setLoading(true);
    setRefreshing(false);
    setPendingAction(null);
    setCommittedAction(null);
    setError(null);
    void loadWorkflow("foreground");
    return () => {
      projectEpochRef.current += 1;
      loadRevisionRef.current += 1;
      actionPendingRef.current = false;
      committedActionRef.current = null;
    };
  }, [loadWorkflow]);

  useEffect(() => {
    if (
      (!committedAction && !shouldPollWorkflow(workflow?.project.status)) ||
      pendingAction
    ) return;
    const interval = window.setInterval(() => {
      void loadWorkflow("background");
    }, 3000);
    return () => window.clearInterval(interval);
  }, [committedAction, loadWorkflow, pendingAction, workflow?.project.status]);

  const runAction = useCallback(async (
    action: WorkbenchWorkflowAction,
    config?: WorkbenchFinalConfig,
    expectedEditListRevision?: string,
  ): Promise<boolean> => {
    const current = workflowRef.current;
    if (
      !current ||
      actionPendingRef.current ||
      committedActionRef.current
    ) return false;
    const epoch = projectEpochRef.current;
    actionPendingRef.current = true;
    setPendingAction(action);
    setError(null);
    try {
      await postProjectWorkflowAction({
        projectId,
        action,
        expectedRevision: current.revision,
        expectedEditListRevision: action === "apply-cut"
          ? expectedEditListRevision
          : undefined,
        config,
      });
      if (projectEpochRef.current !== epoch) return false;
      committedActionRef.current = action;
      setCommittedAction(action);
      const refreshed = await loadWorkflow("foreground");
      if (!refreshed && projectEpochRef.current === epoch) {
        setError("动作已提交，但状态刷新失败，请重试刷新。");
      }
      return true;
    } catch (caught) {
      if (projectEpochRef.current !== epoch) return false;
      if (
        caught instanceof WorkflowApiError &&
        (caught.status === 409 || caught.code === "revision_conflict")
      ) {
        await loadWorkflow("background");
      }
      if (projectEpochRef.current === epoch) {
        setError(workflowErrorMessage(caught));
      }
      return false;
    } finally {
      if (projectEpochRef.current === epoch) {
        actionPendingRef.current = false;
        setPendingAction(null);
      }
    }
  }, [loadWorkflow, projectId]);

  return {
    workflow,
    loading,
    refreshing,
    pendingAction,
    committedAction,
    error,
    refresh,
    runAction,
  };
}
