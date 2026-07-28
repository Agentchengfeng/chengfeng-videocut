import { useCallback, useEffect, useMemo, useState } from "react";
import type { VisualDocument, VisualLayerTiming } from "@video-workbench/core";

export interface ProjectVisuals {
  document: VisualDocument | null;
  timings: VisualLayerTiming[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Where the preview fetches a module's HTML. */
  moduleUrl: (modulePath: string) => string;
}

interface VisualsResponse {
  document: VisualDocument | null;
  timings: VisualLayerTiming[];
}

function visualsUrl(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/visuals`;
}

/**
 * The visual layers of a project, with their moments already resolved.
 *
 * Timings arrive from the server rather than being computed here: they depend
 * on the transcript and the edit list, and a second implementation in the
 * browser is a second answer to "when is this on screen" that can disagree with
 * the one an export uses.
 */
export function useProjectVisuals(projectId: string): ProjectVisuals {
  const [state, setState] = useState<VisualsResponse>({ document: null, timings: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(visualsUrl(projectId), { headers: { Accept: "application/json" } });
      if (!response.ok) {
        // A project with no visuals is the normal case, not a failure.
        if (response.status === 404) {
          setState({ document: null, timings: [] });
          setError(null);
          return;
        }
        throw new Error(`视觉层读取失败：HTTP ${response.status}`);
      }
      const payload = await response.json() as VisualsResponse;
      setState({ document: payload.document ?? null, timings: payload.timings ?? [] });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const moduleUrl = useCallback(
    (modulePath: string) => `${visualsUrl(projectId)}/module/${
      modulePath.split("/").map((part) => encodeURIComponent(part)).join("/")
    }`,
    [projectId],
  );

  return useMemo(
    () => ({ document: state.document, timings: state.timings, loading, error, reload, moduleUrl }),
    [state.document, state.timings, loading, error, reload, moduleUrl],
  );
}
