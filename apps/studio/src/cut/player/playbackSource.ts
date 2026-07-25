import type { EditListDocument } from "@video-workbench/core";

const ABSOLUTE_URL = /^(?:https?:|blob:|data:)/i;

export interface PlaybackSourceResolution {
  url: string | null;
  source: string | null;
  consistent: boolean;
}

export function resolveEditListPlaybackSource(
  projectId: string,
  document: EditListDocument | null,
): PlaybackSourceResolution {
  const sources = Array.from(new Set(
    document?.segments.map((segment) => segment.source.trim()).filter(Boolean) ?? [],
  ));
  const source = sources[0] ?? null;
  if (!source) return { url: null, source: null, consistent: true };
  if (sources.length > 1) return { url: null, source, consistent: false };
  if (ABSOLUTE_URL.test(source)) {
    return { url: source, source, consistent: true };
  }
  const relative = source.replace(/^\/+/, "");
  const encodedRelative = relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return {
    url: `/api/projects/${encodeURIComponent(projectId)}/preview/${encodedRelative}`,
    source,
    consistent: true,
  };
}
