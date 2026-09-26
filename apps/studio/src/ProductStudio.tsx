import { useEffect, useSyncExternalStore } from "react";
import { useRuntimeIdleCoverageGuard } from "./runtime/useRuntimeProtection";
import { runtimeActivityCapability } from "./runtime/activity";
import { StudioApp } from "./App";
import "./styles/studio.css";
import { studioBootGuard } from "./bootstrap/studioBootGuard";
import { useKouboTimelineEditingAdapter } from "./extensions/koubo/useKouboTimelineEditingAdapter";

export function ProductStudio() {
  // Generic DOM/source/storyboard editors do not yet expose one authoritative
  // saved-state contract. Fail closed: no idle shutdown for this editor session.
  useRuntimeIdleCoverageGuard();
  const idleEnabled = useSyncExternalStore(runtimeActivityCapability.subscribe, runtimeActivityCapability.getSnapshot);
  useEffect(() => {
    studioBootGuard()?.markReady();
  }, []);

  return (
    <>
    {idleEnabled && <div role="status" style={{ position: "fixed", bottom: 0, right: 0, zIndex: 10000, fontSize: 11, padding: "3px 8px", background: "#242424", color: "#ddd" }}>
      通用编辑器保存状态尚未完整接入：本次会话保守禁用空闲退出，关闭页面后保护可能保留。
    </div>}
    <StudioApp
      useTimelineEditingAdapter={useKouboTimelineEditingAdapter}
    />
    </>
  );
}
