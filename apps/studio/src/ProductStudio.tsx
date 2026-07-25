import { useEffect } from "react";
import { StudioApp } from "./App";
import "./styles/studio.css";
import { studioBootGuard } from "./bootstrap/studioBootGuard";
import { useKouboTimelineEditingAdapter } from "./extensions/koubo/useKouboTimelineEditingAdapter";

export function ProductStudio() {
  useEffect(() => {
    studioBootGuard()?.markReady();
  }, []);

  return (
    <StudioApp
      useTimelineEditingAdapter={useKouboTimelineEditingAdapter}
    />
  );
}
