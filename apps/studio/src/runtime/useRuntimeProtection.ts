import { useLayoutEffect, useMemo } from "react";
import { runtimeProtection } from "./activity";

/** Failed or abandoned drafts stay protected across a project/component switch. */
export function useRuntimeProtection(dirty: boolean, playing = false, scope = "editor") {
  const key = useMemo(() => Symbol(scope), [scope]);
  useLayoutEffect(() => { runtimeProtection.set(key, dirty, playing); }, [key, dirty, playing]);
  useLayoutEffect(() => () => { runtimeProtection.detach(key); }, [key]);
}

export function isUnsavedState(state: string) {
  return state === "saving" || state === "error" || state === "conflict";
}

export function useRuntimeIdleCoverageGuard() {
  const key = useMemo(() => Symbol("incomplete-editor-save-coverage"), []);
  useLayoutEffect(() => { runtimeProtection.guard(key); }, [key]);
}
