import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CUT_PLAYER_FRAME_RATE,
} from "./playbackShortcuts";
import type { EdlVideoTransport } from "./useAssembledVideoTransport";
import type { PreviewArtifactProfile } from "./previewArtifact";
import { useCutPlaybackShortcuts } from "./useCutPlaybackShortcuts";
import { SubtitleOverlay, type ActiveSubtitle } from "../subtitle/SubtitleOverlay";
import { VisualOverlay, type ActiveVisual } from "../visual/VisualOverlay";

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe - minutes * 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;
const VOLUME_KEY_STEP = 0.05;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function roundVolume(value: number): number {
  return Math.round(clampVolume(value) * 100) / 100;
}

export function CutPlayer({
  sourceUrl,
  transport,
  onTimelineTimeCommit,
  artifactPhase = "current",
  artifactProfile = "sharp-canonical-v1",
  onArtifactRetry,
  subtitle = null,
  visualLayers = [],
  activeVisualLayerId = null,
}: {
  sourceUrl: string | null;
  transport: EdlVideoTransport;
  onTimelineTimeCommit: (time: number) => void;
  artifactPhase?: "generating" | "current" | "failed" | "stale";
  artifactProfile?: PreviewArtifactProfile | null;
  onArtifactRetry?: () => void;
  /** Already resolved: which line, in which style. Null draws nothing. */
  subtitle?: ActiveSubtitle | null;
  visualLayers?: readonly ActiveVisual[];
  activeVisualLayerId?: string | null;
}) {
  const activity = transport.error
    ? transport.error
    : transport.isSeeking
      ? "定位中"
      : transport.isWaiting
        ? "缓冲中"
        : null;
  const playerRef = useRef<HTMLElement | null>(null);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const toolsMenuRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [timeDisplayMode, setTimeDisplayMode] = useState<"time" | "frames">("time");
  const [jumpFrame, setJumpFrame] = useState("");

  const controlsDisabled = !sourceUrl || artifactPhase !== "current";
  const currentFrame = Math.round(transport.timelineTime * CUT_PLAYER_FRAME_RATE);
  const totalFrames = Math.round(transport.duration * CUT_PLAYER_FRAME_RATE);
  const volumePercent = Math.round(transport.volume * 100);
  const volumeStyle = {
    "--cf-cut-volume": `${volumePercent}%`,
  } as CSSProperties;
  const artifactRetryVisible = artifactPhase === "failed" && Boolean(onArtifactRetry);

  const setVolumeFromClientX = useCallback((input: HTMLInputElement, clientX: number) => {
    if (controlsDisabled) return;
    const rect = input.getBoundingClientRect();
    if (!rect.width) return;
    transport.setVolume(roundVolume((clientX - rect.left) / rect.width));
  }, [controlsDisabled, transport]);

  const handleVolumeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (controlsDisabled) return;
    let nextVolume: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nextVolume = transport.volume - VOLUME_KEY_STEP;
        break;
      case "ArrowRight":
      case "ArrowUp":
        nextVolume = transport.volume + VOLUME_KEY_STEP;
        break;
      case "PageDown":
        nextVolume = transport.volume - VOLUME_KEY_STEP * 2;
        break;
      case "PageUp":
        nextVolume = transport.volume + VOLUME_KEY_STEP * 2;
        break;
      case "Home":
        nextVolume = 0;
        break;
      case "End":
        nextVolume = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    transport.setVolume(roundVolume(nextVolume));
  }, [controlsDisabled, transport]);

  const handleVolumePointerDown = useCallback((event: ReactPointerEvent<HTMLInputElement>) => {
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setVolumeFromClientX(event.currentTarget, event.clientX);
  }, [setVolumeFromClientX]);

  const handleVolumePointerMove = useCallback((event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.buttons !== 1) return;
    setVolumeFromClientX(event.currentTarget, event.clientX);
  }, [setVolumeFromClientX]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    void playerRef.current?.requestFullscreen?.();
  }, []);

  useCutPlaybackShortcuts({
    transport,
    onTimelineTimeCommit,
    onToggleFullscreen: toggleFullscreen,
    enabled: !controlsDisabled,
  });

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === playerRef.current);
    };
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    if (!speedMenuOpen && !toolsMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (speedMenuOpen && !speedMenuRef.current?.contains(target)) setSpeedMenuOpen(false);
      if (toolsMenuOpen && !toolsMenuRef.current?.contains(target)) setToolsMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSpeedMenuOpen(false);
      setToolsMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [speedMenuOpen, toolsMenuOpen]);

  const seekToFrame = () => {
    if (controlsDisabled) return;
    const parsed = Number(jumpFrame);
    if (!Number.isFinite(parsed)) return;
    const frame = Math.min(totalFrames, Math.max(0, Math.round(parsed)));
    const target = frame / CUT_PLAYER_FRAME_RATE;
    void transport.seek(target, { keepPlaying: transport.isPlaying });
    onTimelineTimeCommit(target);
    setJumpFrame(String(frame));
  };

  return (
    <section
      ref={playerRef}
      className="cf-cut-player"
      aria-label="剪口播播放器"
      data-studio-fullscreen-target=""
    >
      <div className="cf-cut-player-stage">
        {sourceUrl ? (
          <video
            ref={transport.videoRef}
            // No `src` here on purpose. The transport owns it: an assembled stream
            // is attached as an object URL, and writing `src` from JSX would let
            // every re-render replace it with the raw file — which is both the wrong
            // media and a player that jumps.
            preload="auto"
            playsInline
            muted={transport.muted}
            data-koubo-media-owner="video"
            onClick={() => {
              if (!controlsDisabled) void transport.togglePlay();
            }}
          />
        ) : (
          <div className="cf-cut-player-empty">当前 EDL 没有可播放的单一媒体源</div>
        )}
        {sourceUrl && (
          <VisualOverlay
            layers={visualLayers}
            activeLayerId={activeVisualLayerId}
            timelineTime={transport.timelineTime}
          />
        )}
        {/* After the visual: a caption is read over whatever is on screen,
            including a module that covers the footage. */}
        {sourceUrl && <SubtitleOverlay subtitle={subtitle} />}
        {activity && (
          <span className={`cf-cut-player-state ${transport.error ? "is-error" : ""}`}>
            {activity}
          </span>
        )}
        {artifactPhase !== "current" && (
          <span
            className={`cf-cut-player-state ${artifactPhase === "failed" ? "is-error" : ""} ${artifactRetryVisible ? "has-action" : ""}`}
            role={artifactPhase === "failed" ? "alert" : "status"}
          >
            {artifactPhase === "generating" ? "正在生成最新高清预览 · 当前画面为上次结果" :
              artifactPhase === "failed" ? "当前剪辑预览生成失败；旧预览不会冒充最新结果" :
              "剪辑已变化，连续预览已过期"}
            {artifactRetryVisible ? (
              <button type="button" className="cf-cut-preview-retry" onClick={onArtifactRetry}>
                重试
              </button>
            ) : null}
          </span>
        )}
        {artifactPhase === "current" && artifactProfile === "fast-proxy-v1" && (
          <span className="cf-cut-player-state" role="status">低资源预览（960p）</span>
        )}
      </div>

      <div className="cf-cut-player-controls" data-player-transport="hyperframes-compatible">
        <button
          type="button"
          className="cf-cut-play-button"
          disabled={controlsDisabled}
          aria-label={transport.isPlaying ? "暂停" : "播放"}
          title={transport.isPlaying ? "暂停（空格）" : "播放（空格）"}
          onClick={() => {
            if (transport.isPlaying) {
              transport.pause();
              onTimelineTimeCommit(transport.timelineTime);
            } else {
              void transport.play();
            }
          }}
        >
          {transport.isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.5 3.25h2.25v9.5H4.5zM9.25 3.25h2.25v9.5H9.25z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5 3.25v9.5L12.5 8z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="cf-cut-time-readout"
          aria-label={timeDisplayMode === "time" ? "切换为帧显示" : "切换为时间显示"}
          title={timeDisplayMode === "time" ? "显示帧号" : "显示时间码"}
          onClick={() => setTimeDisplayMode((mode) => mode === "time" ? "frames" : "time")}
        >
          {timeDisplayMode === "time" ? (
            <>
              <span>{formatTime(transport.timelineTime)}</span>
              <span className="is-separator">/</span>
              <span className="is-duration">{formatTime(transport.duration)}</span>
            </>
          ) : (
            <>
              <span>{currentFrame}</span>
              <span className="is-separator">/</span>
              <span className="is-duration">{totalFrames} 帧</span>
            </>
          )}
        </button>

        <button
          type="button"
          className={`cf-cut-player-icon-button ${transport.muted ? "is-active" : ""}`}
          disabled={controlsDisabled}
          aria-label={transport.muted ? "取消静音" : "静音"}
          aria-pressed={transport.muted}
          title={transport.muted ? "取消静音" : "静音"}
          onClick={transport.toggleMuted}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4V5Z" />
            {transport.muted ? (
              <>
                <path d="m19 9-6 6" />
                <path d="m13 9 6 6" />
              </>
            ) : (
              <>
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M18.5 5.5a9 9 0 0 1 0 13" />
              </>
            )}
          </svg>
        </button>

        <div className="cf-cut-volume-control" style={volumeStyle}>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={transport.volume}
            disabled={controlsDisabled}
            aria-label="音量"
            aria-valuenow={volumePercent}
            aria-valuetext={`${volumePercent}%`}
            title={`音量 ${volumePercent}%`}
            onKeyDown={handleVolumeKeyDown}
            onPointerDown={handleVolumePointerDown}
            onPointerMove={handleVolumePointerMove}
            onChange={(event) => transport.setVolume(Number(event.currentTarget.value))}
          />
        </div>

        <div ref={speedMenuRef} className="cf-cut-speed-control">
          <button
            type="button"
            className="cf-cut-speed-button"
            disabled={controlsDisabled}
            aria-label="播放速度"
            aria-expanded={speedMenuOpen}
            aria-haspopup="menu"
            title="播放速度"
            onClick={() => setSpeedMenuOpen((open) => !open)}
          >
            {transport.playbackRate === 1 ? "1x" : `${transport.playbackRate}x`}
          </button>
          {speedMenuOpen && (
            <div className="cf-cut-speed-menu" role="menu" aria-label="选择播放速度">
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  role="menuitemradio"
                  aria-checked={transport.playbackRate === rate}
                  onClick={() => {
                    transport.setPlaybackRate(rate);
                    setSpeedMenuOpen(false);
                  }}
                >
                  {rate}x
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`cf-cut-player-icon-button ${transport.loopEnabled ? "is-active" : ""}`}
          disabled={controlsDisabled}
          aria-label={transport.loopEnabled ? "关闭循环播放" : "开启循环播放"}
          aria-pressed={transport.loopEnabled}
          title={transport.loopEnabled ? "关闭循环播放" : "循环播放"}
          onClick={transport.toggleLoop}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M17 2l4 4-4 4" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <path d="M7 22l-4-4 4-4" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        </button>

        <button
          type="button"
          className={`cf-cut-player-icon-button cf-cut-fullscreen-button ${isFullscreen ? "is-active" : ""}`}
          aria-label={isFullscreen ? "退出全屏" : "全屏"}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "退出全屏" : "全屏"}
          onClick={toggleFullscreen}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
            aria-hidden="true"
          >
            {isFullscreen ? (
              <path d="M6.25 2.75v3.5h-3.5M9.75 2.75v3.5h3.5M6.25 13.25v-3.5h-3.5M9.75 13.25v-3.5h3.5" />
            ) : (
              <path d="M5.75 2.75h-3v3M10.25 2.75h3v3M5.75 13.25h-3v-3M10.25 13.25h3v-3" />
            )}
          </svg>
        </button>

        <div ref={toolsMenuRef} className="cf-cut-tools-control">
          <button
            type="button"
            className={`cf-cut-player-icon-button cf-cut-tools-button ${toolsMenuOpen ? "is-active" : ""}`}
            aria-label="快捷键与工具"
            aria-expanded={toolsMenuOpen}
            aria-haspopup="dialog"
            title="快捷键与工具"
            onClick={() => {
              setJumpFrame(String(currentFrame));
              setToolsMenuOpen((open) => !open);
              setSpeedMenuOpen(false);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 9h1M11 9h1M15 9h2M7 13h2M12 13h1M16 13h1M8 16h8" />
            </svg>
            <span>快捷键</span>
          </button>

          {toolsMenuOpen && (
            <div
              className="cf-cut-tools-panel"
              role="dialog"
              aria-label="播放快捷键与工具"
            >
              <div className="cf-cut-tools-heading">
                <strong>播放工具</strong>
                <span>{CUT_PLAYER_FRAME_RATE} fps</span>
              </div>
              <form
                className="cf-cut-jump-frame"
                onSubmit={(event) => {
                  event.preventDefault();
                  seekToFrame();
                }}
              >
                <label htmlFor="cf-cut-jump-frame-input">跳到帧</label>
                <input
                  id="cf-cut-jump-frame-input"
                  type="number"
                  min={0}
                  max={totalFrames}
                  step={1}
                  value={jumpFrame}
                  onChange={(event) => setJumpFrame(event.currentTarget.value)}
                />
                <button type="submit">定位</button>
              </form>
              <div className="cf-cut-shortcut-list" aria-label="已接通的播放快捷键">
                <span><kbd>Space</kbd><em>播放 / 暂停</em></span>
                <span><kbd>← / →</kbd><em>前后 1 帧</em></span>
                <span><kbd>Shift</kbd><kbd>← / →</kbd><em>前后 10 帧</em></span>
                <span><kbd>K</kbd><em>暂停</em></span>
                <span><kbd>M</kbd><em>静音</em></span>
                <span><kbd>Shift + L</kbd><em>循环</em></span>
                <span><kbd>F</kbd><em>全屏</em></span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
