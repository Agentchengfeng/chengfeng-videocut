import { useEffect, useState } from "react";

export interface ProjectReviewPassCandidate {
  id: string;
  kind: "repeat";
  decision: "listen_then_decide";
  removeWordIds: string[];
  keepWordIds: string[];
  reason: string;
}

export type ProjectReviewPassesState = "loading" | "missing" | "stale" | "invalid" | "current";

export interface ProjectReviewPasses {
  state: ProjectReviewPassesState;
  removedWordIds: string[];
  candidates: ProjectReviewPassCandidate[];
  reason: string | null;
}

const INITIAL_STATE: ProjectReviewPasses = {
  state: "loading",
  removedWordIds: [],
  candidates: [],
  reason: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCandidate(value: unknown): ProjectReviewPassCandidate | null {
  if (!isRecord(value) ||
    typeof value.id !== "string" ||
    value.kind !== "repeat" ||
    value.decision !== "listen_then_decide" ||
    typeof value.reason !== "string" ||
    !Array.isArray(value.removeWordIds) ||
    !Array.isArray(value.keepWordIds) ||
    !value.removeWordIds.every((id) => typeof id === "string") ||
    !value.keepWordIds.every((id) => typeof id === "string")
  ) return null;
  return {
    id: value.id,
    kind: "repeat",
    decision: "listen_then_decide",
    removeWordIds: value.removeWordIds as string[],
    keepWordIds: value.keepWordIds as string[],
    reason: value.reason,
  };
}

function parseResource(value: unknown): ProjectReviewPasses | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.state !== "string") return null;
  const state = value.state;
  if (state !== "missing" && state !== "stale" && state !== "invalid" && state !== "current") return null;
  if (!Array.isArray(value.removedWordIds) || !value.removedWordIds.every((id) => typeof id === "string")) return null;
  if (!Array.isArray(value.candidates)) return null;
  const candidates = value.candidates.map(parseCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  if (state === "current" && candidates.length === 0) return null;
  return {
    state,
    removedWordIds: value.removedWordIds as string[],
    candidates: candidates as ProjectReviewPassCandidate[],
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

export function useProjectReviewPasses(projectId: string): ProjectReviewPasses {
  const [resource, setResource] = useState<ProjectReviewPasses>(INITIAL_STATE);

  useEffect(() => {
    let current = true;
    setResource(INITIAL_STATE);
    void fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/review-passes`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) throw new Error(`review-passes ${response.status}`);
      return parseResource(await response.json());
    }).then((next) => {
      if (!current) return;
      setResource(next ?? { state: "invalid", removedWordIds: [], candidates: [], reason: "第二遍候选返回无效" });
    }).catch((error) => {
      if (!current) return;
      setResource({
        state: "invalid",
        removedWordIds: [],
        candidates: [],
        reason: error instanceof Error ? error.message : "无法读取第二遍候选",
      });
    });
    return () => {
      current = false;
    };
  }, [projectId]);

  return resource;
}
