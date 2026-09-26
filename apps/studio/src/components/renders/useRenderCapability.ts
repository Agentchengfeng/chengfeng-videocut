import { useCallback, useEffect, useRef, useState } from "react";

export interface RenderCapability { enabled: boolean; reason: string; source: string }
export const UNKNOWN_RENDER_CAPABILITY: RenderCapability = {
  enabled: false, reason: "尚未确认此工作台的通用 HTML 导出能力，请稍后重试。", source: "unknown",
};
export function parseRenderCapability(value: unknown): RenderCapability {
  const capability = (value as { genericHtmlRender?: Partial<RenderCapability> & { schemaVersion?: number } } | null)?.genericHtmlRender;
  if (!capability || capability.schemaVersion !== 1 || typeof capability.enabled !== "boolean"
    || typeof capability.reason !== "string" || !capability.reason.trim()
    || !["production-studio-adapter", "vite-producer-adapter"].includes(capability.source ?? "")) return UNKNOWN_RENDER_CAPABILITY;
  return { enabled: capability.enabled, reason: capability.reason, source: capability.source! };
}
export async function readRenderCapability(origin: string): Promise<RenderCapability> {
  try {
    const response = await fetch(new URL("/api/health", origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok) return UNKNOWN_RENDER_CAPABILITY;
    return parseRenderCapability(await response.json());
  } catch { return UNKNOWN_RENDER_CAPABILITY; }
}
// Scope changes invalidate cached enablement synchronously, before effects run.
export function useRenderCapability(scope: string | null, origin = window.location.origin) {
  const key = `${origin}\n${scope ?? ""}`;
  const currentKey = useRef(key); currentKey.current = key;
  const requestId = useRef(0);
  const [observed, setObserved] = useState({ key: "", capability: UNKNOWN_RENDER_CAPABILITY });
  const refresh = useCallback(async () => {
    const token = ++requestId.current;
    const capability = await readRenderCapability(origin);
    if (currentKey.current !== key || token !== requestId.current) return UNKNOWN_RENDER_CAPABILITY;
    setObserved({ key, capability });
    return capability;
  }, [key, origin]);
  useEffect(() => { void refresh(); return () => { requestId.current++; }; }, [refresh]);
  return { capability: observed.key === key ? observed.capability : UNKNOWN_RENDER_CAPABILITY, refresh };
}
