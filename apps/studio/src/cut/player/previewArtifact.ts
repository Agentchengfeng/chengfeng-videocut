import { useCallback, useEffect, useRef, useState } from "react";

export type PreviewArtifactPhase = "generating" | "current" | "failed" | "stale";

// `ledger-proxy` is not a rendered artifact: the source is the whole preview
// proxy and the edit list decides what plays, so there is no generation step and
// no edit can make it stale. The two encoded kinds remain for what the ledger
// cannot express — several source files, or a segment whose speed is not 1x.
export type PreviewArtifactProfile = "sharp-canonical-v1" | "fast-proxy-v1" | "ledger-proxy-v1";
export type PreviewArtifactSourceKind = "canonical" | "fast-proxy" | "ledger-proxy";

export interface PreviewArtifactStreamSegment {
  source: string;
  /** Extra media at the fragment's head, from keyframe-aligned cutting. Trim it. */
  headExtra: number;
  /** Where the fragment starts on the assembled timeline. */
  out: number;
  dur: number;
}

export interface PreviewArtifactStream {
  segments: PreviewArtifactStreamSegment[];
  totalSeconds: number;
  mimeType: string;
}

export interface PreviewArtifactState {
  phase: PreviewArtifactPhase;
  editRevision: string;
  artifactRevision: string | null;
  source: string | null;
  profile?: PreviewArtifactProfile | null;
  sourceKind?: PreviewArtifactSourceKind | null;
  width?: number | null;
  height?: number | null;
  /**
   * Fragments to assemble, in order. Present means assemble; absent means a single
   * finished file plays straight through. Either way playback never jumps — a
   * player that jumps leaks the deleted audio it jumps over.
   */
  stream?: PreviewArtifactStream | null;
  error: string | null;
}

/** True when the player must follow the edit list instead of playing the source straight through. */
export function playsFromLedger(state: PreviewArtifactState): boolean {
  return state.sourceKind === "ledger-proxy";
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
    // A failed poll is a moment, not a verdict.
    //
    // Giving up on the first error meant one 58ms blip right after an edit left the
    // player disabled until the page was reloaded — which is exactly what "deleting
    // freezes it, refreshing fixes it" was. The service had already recovered on its
    // own; nobody was asking it any more.
    let consecutiveFailures = 0;
    const retryDelay = () => Math.min(350 * 2 ** Math.max(0, consecutiveFailures - 1), 5_000);
    /** Report failure only once it has stopped looking like a blip. */
    const FAILURES_BEFORE_REPORTING = 3;
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
        consecutiveFailures = 0;
        setState(next);
        // A failure the service *reports* stays put on purpose: it means generation
        // itself failed, retrying costs real work, and there is a button for it.
        // What must not stay put is a failure we merely failed to ask about.
        if (next.phase !== "failed" && (next.phase !== "current" || next.artifactRevision !== editRevision)) {
          timer = setTimeout(poll, 350);
        }
      } catch (error) {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAILURES_BEFORE_REPORTING) {
          setState((current) => ({ ...current, phase: "failed", editRevision, error: String(error) }));
        }
        timer = setTimeout(poll, retryDelay());
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
