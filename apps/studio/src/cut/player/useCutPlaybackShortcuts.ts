import { useEffect, useRef } from "react";
import type { EdlVideoTransport } from "./useEdlVideoTransport";
import {
  isCutPlaybackShortcutTarget,
  resolveCutPlaybackShortcut,
  seekTargetForFrameDelta,
} from "./playbackShortcuts";

export function useCutPlaybackShortcuts(input: {
  transport: EdlVideoTransport;
  onTimelineTimeCommit: (time: number) => void;
  onToggleFullscreen: () => void;
  enabled?: boolean;
}) {
  const latestRef = useRef(input);
  latestRef.current = input;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCutPlaybackShortcutTarget(event.target)) return;
      const action = resolveCutPlaybackShortcut(event);
      if (!action) return;

      const { transport, onTimelineTimeCommit, onToggleFullscreen, enabled = true } = latestRef.current;
      if (!enabled) return;
      event.preventDefault();

      switch (action.type) {
        case "toggle-play":
          void transport.togglePlay();
          onTimelineTimeCommit(transport.timelineTime);
          break;
        case "pause":
          transport.pause();
          onTimelineTimeCommit(transport.timelineTime);
          break;
        case "seek-frames": {
          const target = seekTargetForFrameDelta(
            transport.timelineTime,
            action.frames,
            transport.duration,
          );
          void transport.seek(target, { keepPlaying: transport.isPlaying });
          onTimelineTimeCommit(target);
          break;
        }
        case "toggle-muted":
          transport.toggleMuted();
          break;
        case "toggle-loop":
          transport.toggleLoop();
          break;
        case "toggle-fullscreen":
          onToggleFullscreen();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
