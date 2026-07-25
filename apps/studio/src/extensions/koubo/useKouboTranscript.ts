import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseTranscriptPayload,
  type TranscriptCue,
} from "../../components/kouboTranscript";
import { readProjectJson } from "../../components/projectJson";
import { subscribeProjectFileChanges } from "../../product/projectEvents";

const TRANSCRIPT_FILES = ["transcript.json", "subtitles_words.json"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readFileChangePath(payload: unknown): string | null {
  if (typeof payload === "string") {
    const source = payload.trim();
    if (!source.startsWith("{")) return source || null;
    try {
      return readFileChangePath(JSON.parse(source) as unknown);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;
  if (typeof payload.path === "string") return payload.path;
  if (typeof payload.filePath === "string") return payload.filePath;
  return "data" in payload ? readFileChangePath(payload.data) : null;
}

export function isKouboTranscriptFileChange(payload: unknown): boolean {
  const path = readFileChangePath(payload);
  return Boolean(path && TRANSCRIPT_FILES.some(
    (file) => path === file || path.endsWith(`/${file}`),
  ));
}

export function useKouboTranscript(projectId: string): {
  cues: TranscriptCue[];
  loading: boolean;
  error: string | null;
} {
  const [cues, setCues] = useState<TranscriptCue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const hasCuesRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!hasCuesRef.current) setLoading(true);
    setError(null);
    try {
      let nextCues: TranscriptCue[] = [];
      for (const filePath of TRANSCRIPT_FILES) {
        const payload = await readProjectJson(projectId, filePath);
        if (payload == null) continue;
        nextCues = parseTranscriptPayload(payload);
        if (nextCues.length > 0) break;
      }
      if (generation !== generationRef.current) return;
      hasCuesRef.current = nextCues.length > 0;
      setCues(nextCues);
      setLoading(false);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId]);

  useEffect(() => {
    generationRef.current += 1;
    hasCuesRef.current = false;
    setCues([]);
    setLoading(true);
    setError(null);
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const handleChange = (payload: unknown) => {
      if (isKouboTranscriptFileChange(payload)) void load();
    };
    return subscribeProjectFileChanges(handleChange);
  }, [load]);

  return { cues, loading: loading && cues.length === 0, error };
}
