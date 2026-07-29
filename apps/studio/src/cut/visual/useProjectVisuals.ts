import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** Identity of each module's entry file, keyed by module path. */
  moduleStamps: Record<string, string>;
}

/**
 * How often the preview asks whether the layers changed under it.
 *
 * The layers are written by an Agent through the CLI, not by this page — so
 * without asking, the page can only ever show the world as it was when it
 * loaded, and the person's actual experience was 「要刷新才能看到」. Two
 * seconds is far below the time it takes an Agent to produce a layer, and the
 * poll is one small JSON read that the server computes on every GET anyway.
 */
const POLL_MS = 2_000;

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
 *
 * The document is re-fetched on an interval, and applied only when it actually
 * differs — the fingerprint check is what lets a poll coexist with playback,
 * because a state update sixty times a minute would re-render the timeline for
 * nothing. Module edits are visible too: each layer's frame URL carries the
 * module file's stamp, so rewriting a module changes the URL and reloads
 * exactly that frame.
 */
export function useProjectVisuals(projectId: string): ProjectVisuals {
  const [state, setState] = useState<VisualsResponse>({
    document: null,
    timings: [],
    moduleStamps: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fingerprintRef = useRef("");

  const load = useCallback(async (options?: { background?: boolean }) => {
    if (!options?.background) setLoading(true);
    try {
      const response = await fetch(visualsUrl(projectId), { headers: { Accept: "application/json" } });
      if (!response.ok) {
        // A project with no visuals is the normal case, not a failure.
        if (response.status === 404) {
          if (fingerprintRef.current !== "none") {
            fingerprintRef.current = "none";
            setState({ document: null, timings: [], moduleStamps: {} });
          }
          setError(null);
          return;
        }
        throw new Error(`视觉层读取失败：HTTP ${response.status}`);
      }
      const payload = await response.json() as VisualsResponse & { revision?: string };
      const next: VisualsResponse = {
        document: payload.document ?? null,
        timings: payload.timings ?? [],
        moduleStamps: payload.moduleStamps ?? {},
      };
      // Timings and stamps can change while the document revision does not —
      // an edit to the cut moves every layer, an edit to a module file moves
      // nothing but the stamp — so the fingerprint covers all three.
      const fingerprint = JSON.stringify([payload.revision ?? "", next.timings, next.moduleStamps]);
      if (fingerprint !== fingerprintRef.current) {
        fingerprintRef.current = fingerprint;
        setState(next);
      }
      setError(null);
    } catch (cause) {
      // A background poll that fails says nothing the person can act on — the
      // next one recovers by itself. Only a requested load reports.
      if (!options?.background) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!options?.background) setLoading(false);
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    fingerprintRef.current = "";
    void load();
    const timer = setInterval(() => {
      void load({ background: true });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const moduleUrl = useCallback(
    (modulePath: string) => {
      const path = modulePath.split("/").map((part) => encodeURIComponent(part)).join("/");
      // The stamp in the URL is what turns "the Agent rewrote the module" into
      // "that one frame reloads". Without it the frame keeps the HTML it
      // fetched at mount, correctly, forever.
      const stamp = state.moduleStamps[modulePath];
      return `${visualsUrl(projectId)}/module/${path}${stamp ? `?v=${encodeURIComponent(stamp)}` : ""}`;
    },
    [projectId, state.moduleStamps],
  );

  return useMemo(
    () => ({ document: state.document, timings: state.timings, loading, error, reload, moduleUrl }),
    [state.document, state.timings, loading, error, reload, moduleUrl],
  );
}
