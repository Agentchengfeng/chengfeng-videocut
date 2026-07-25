import { useCallback, useEffect, useRef, useState } from "react";

export type PreviewArtifactPhase = "generating" | "current" | "failed" | "stale";
export interface PreviewArtifactState {
  phase: PreviewArtifactPhase;
  editRevision: string;
  artifactRevision: string | null;
  source: string | null;
  profile?: "sharp-canonical-v1" | "fast-proxy-v1" | null;
  sourceKind?: "canonical" | "fast-proxy" | null;
  width?: number | null;
  height?: number | null;
  error: string | null;
}

export function previewArtifactUrl(projectId: string, source: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/preview/${source.split("/").map(encodeURIComponent).join("/")}`;
}

export function usePreviewArtifact(projectId: string, editRevision: string) {
  const [state, setState] = useState<PreviewArtifactState>({
    phase: "stale", editRevision, artifactRevision: null, source: null, profile: null, sourceKind: null, width: null, height: null, error: null,
  });
  const [retryToken, setRetryToken] = useState(0);
  const pendingRetryTokenRef = useRef<{
    token: number;
    projectId: string;
    editRevision: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const pendingRetry = pendingRetryTokenRef.current;
        const shouldPostRetry = Boolean(
          pendingRetry &&
          pendingRetry.token === retryToken &&
          pendingRetry.projectId === projectId &&
          pendingRetry.editRevision === editRevision,
        );
        if (pendingRetry && !shouldPostRetry) pendingRetryTokenRef.current = null;
        if (shouldPostRetry) pendingRetryTokenRef.current = null;
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/preview-artifact`, {
          method: shouldPostRetry ? "POST" : "GET",
          headers: { Accept: "application/json" }, cache: "no-store",
        });
        if (!response.ok) throw new Error(`preview artifact ${response.status}`);
        const next = await response.json() as PreviewArtifactState;
        if (cancelled) return;
        setState(next);
        if (next.phase !== "failed" && (next.phase !== "current" || next.artifactRevision !== editRevision)) {
          timer = setTimeout(poll, 350);
        }
      } catch (error) {
        if (!cancelled) {
          setState((current) => ({ ...current, phase: "failed", editRevision, error: String(error) }));
        }
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [editRevision, projectId, retryToken]);
  const current = state.phase === "current" && state.artifactRevision === editRevision && Boolean(state.source);
  const retry = useCallback(() => {
    setState((currentState) => ({ ...currentState, phase: "generating", error: null }));
    setRetryToken((value) => {
      const next = value + 1;
      pendingRetryTokenRef.current = { token: next, projectId, editRevision };
      return next;
    });
  }, [editRevision, projectId]);
  return { state, current, retry };
}
