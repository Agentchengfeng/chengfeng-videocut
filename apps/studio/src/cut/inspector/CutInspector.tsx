import { useId } from "react";
import type { ProjectEditListState } from "../../components/useProjectEditList";
import type { EdlVideoTransport } from "../player/useEdlVideoTransport";

export type CutInspectorEditList = Pick<
  ProjectEditListState,
  "document" | "loading" | "ready"
>;

export type CutInspectorTransport = Pick<
  EdlVideoTransport,
  | "muted"
  | "volume"
  | "playbackRate"
  | "toggleMuted"
  | "setVolume"
  | "setPlaybackRate"
>;

export interface CutInspectorProps {
  editList: CutInspectorEditList;
  transport: CutInspectorTransport;
}

function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function editModeLabel(mode: "cuts-derived" | "manual"): string {
  return mode === "manual" ? "手动精剪" : "文稿剪辑";
}

export function CutInspector({ editList, transport }: CutInspectorProps) {
  const titleId = useId();
  const previewHelpId = useId();
  const volumeId = useId();
  const playbackRateId = useId();
  const document = editList.document;
  const unavailable = editList.loading || !editList.ready || !document;
  const shortenedDuration = document
    ? Math.max(0, document.sourceDuration - document.duration)
    : 0;

  return (
    <aside
      className="cf-cut-inspector"
      aria-labelledby={titleId}
      aria-busy={editList.loading}
      data-koubo-inspector="true"
    >
      <header className="cf-cut-inspector__header">
        <h2 id={titleId}>参数</h2>
      </header>

      <div className="cf-cut-inspector__body">
        <fieldset
          className="cf-cut-inspector__section cf-cut-inspector__preview"
          disabled={unavailable}
          aria-describedby={previewHelpId}
        >
          <legend>预览设置</legend>
          <p id={previewHelpId} className="cf-cut-inspector__help">
            仅影响当前预览，不写入项目或成片。
          </p>

          <div className="cf-cut-inspector__control">
            <span>声音</span>
            <button
              type="button"
              className="cf-cut-inspector__mute"
              aria-label={transport.muted ? "取消预览静音" : "预览静音"}
              aria-pressed={transport.muted}
              disabled={unavailable}
              onClick={transport.toggleMuted}
            >
              {transport.muted ? "已静音" : "开启"}
            </button>
          </div>

          <div className="cf-cut-inspector__control">
            <label htmlFor={volumeId}>预览音量</label>
            <div className="cf-cut-inspector__range">
              <input
                id={volumeId}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={transport.volume}
                aria-label="预览音量"
                aria-valuetext={`${Math.round(transport.volume * 100)}%`}
                disabled={unavailable}
                onChange={(event) => transport.setVolume(Number(event.currentTarget.value))}
              />
              <output htmlFor={volumeId}>{Math.round(transport.volume * 100)}%</output>
            </div>
          </div>

          <div className="cf-cut-inspector__control">
            <label htmlFor={playbackRateId}>预览倍速</label>
            <select
              id={playbackRateId}
              value={transport.playbackRate}
              aria-label="预览倍速"
              disabled={unavailable}
              onChange={(event) => {
                transport.setPlaybackRate(Number(event.currentTarget.value));
              }}
            >
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
            </select>
          </div>
        </fieldset>

        <section className="cf-cut-inspector__section" aria-labelledby={`${titleId}-edit-list`}>
          <h3 id={`${titleId}-edit-list`}>剪辑信息</h3>
          {unavailable ? (
            <p className="cf-cut-inspector__status" role="status" aria-live="polite">
              {editList.loading ? "正在读取剪辑信息…" : "剪辑信息尚未就绪"}
            </p>
          ) : (
            <dl className="cf-cut-inspector__facts">
              <div>
                <dt>剪辑模式</dt>
                <dd>{editModeLabel(document.mode)}</dd>
              </div>
              <div>
                <dt>原素材时长</dt>
                <dd>{formatDuration(document.sourceDuration)}</dd>
              </div>
              <div>
                <dt>成片时长</dt>
                <dd>{formatDuration(document.duration)}</dd>
              </div>
              <div>
                <dt>缩短时长</dt>
                <dd>{formatDuration(shortenedDuration)}</dd>
              </div>
              <div>
                <dt>片段数</dt>
                <dd>{document.segments.length}</dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
}
