import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCaptionStore } from "../captions/store";
import { readStudioFileChangePath } from "./editor/manualEdits";
import {
  mergeCaptionModelIntoCues,
  parseTranscriptPayload,
  type TranscriptCue,
} from "./kouboTranscript";
import { readProjectJson } from "./projectJson";

const TRANSCRIPT_FILES = ["transcript.json", "subtitles_words.json"] as const;

function isTranscriptFileChange(payload: unknown): boolean {
  const path = readStudioFileChangePath(payload);
  return Boolean(
    path && TRANSCRIPT_FILES.some((file) => path === file || path.endsWith(`/${file}`)),
  );
}

export function useProjectTranscript(projectId: string): {
  cues: TranscriptCue[];
  loading: boolean;
} {
  const captionModel = useCaptionStore((state) => state.model);
  const [sourceCues, setSourceCues] = useState<TranscriptCue[]>([]);
  const [loading, setLoading] = useState(true);
  const loadRevisionRef = useRef(0);

  const loadTranscript = useCallback(async () => {
    const revision = ++loadRevisionRef.current;
    setLoading(true);
    let nextCues: TranscriptCue[] = [];
    for (const filePath of TRANSCRIPT_FILES) {
      try {
        const payload = await readProjectJson(projectId, filePath);
        if (payload == null) continue;
        nextCues = parseTranscriptPayload(payload);
        if (nextCues.length > 0) break;
      } catch {
        // Try the next supported transcript source.
      }
    }
    if (loadRevisionRef.current !== revision) return;
    setSourceCues(nextCues);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setSourceCues([]);
    setLoading(true);
    void loadTranscript().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      loadRevisionRef.current += 1;
    };
  }, [loadTranscript]);

  useEffect(() => {
    const handleChange = (payload: unknown) => {
      if (isTranscriptFileChange(payload)) void loadTranscript();
    };
    if (import.meta.hot) {
      import.meta.hot.on("hf:file-change", handleChange);
      return () => import.meta.hot?.off?.("hf:file-change", handleChange);
    }
    const events = new EventSource("/api/events");
    events.addEventListener("file-change", handleChange);
    return () => events.close();
  }, [loadTranscript]);

  const cues = useMemo(
    () => mergeCaptionModelIntoCues(sourceCues, captionModel),
    [captionModel, sourceCues],
  );

  return { cues, loading: loading && cues.length === 0 };
}
