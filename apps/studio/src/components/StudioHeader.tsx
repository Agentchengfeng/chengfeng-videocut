import { RotateCcw, RotateCw, Film } from "../icons/SystemIcons";
import { getHistoryShortcutLabel } from "../utils/studioHelpers";
import { useStudioShellContext } from "../contexts/StudioContext";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { Tooltip } from "./ui";

// fallow-ignore-next-line complexity
export function StudioHeader() {
  const { projectId, editHistory, handleUndo, handleRedo } =
    useStudioShellContext();

  return (
    <div className="cf-studio-header flex items-center justify-between h-14 px-4 bg-neutral-900 border-b border-neutral-800 flex-shrink-0">
      <div className="flex min-w-0 items-center gap-3">
        <div className="cf-brand-lockup">
          <span className="cf-brand-mark" aria-hidden="true" />
          <span className="cf-brand-name">chengfeng-videocut</span>
        </div>
        <span className="cf-header-divider" aria-hidden="true" />
        <span className="cf-project-name truncate text-[12px] font-medium text-neutral-300">
          {projectId}
        </span>
      </div>
      <div className="cf-workspace-label" aria-label="剪辑工作区">
        <Film size={14} aria-hidden="true" />
        <span>剪辑工作区</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Tooltip
          label={
            editHistory.undoLabel
              ? `撤销 ${editHistory.undoLabel} (${getHistoryShortcutLabel("undo")})`
              : `撤销 (${getHistoryShortcutLabel("undo")})`
          }
          side="bottom"
        >
          <button
            type="button"
            onClick={() => {
              trackStudioEvent("toolbar_action", { action: "undo" });
              void handleUndo();
            }}
            disabled={!editHistory.canUndo}
            className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors active:scale-[0.98] ${
              editHistory.canUndo
                ? "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
                : "text-neutral-700 cursor-default"
            }`}
            aria-label="撤销"
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
        <Tooltip
          label={
            editHistory.redoLabel
              ? `重做 ${editHistory.redoLabel} (${getHistoryShortcutLabel("redo")})`
              : `重做 (${getHistoryShortcutLabel("redo")})`
          }
          side="bottom"
        >
          <button
            type="button"
            onClick={() => {
              trackStudioEvent("toolbar_action", { action: "redo" });
              void handleRedo();
            }}
            disabled={!editHistory.canRedo}
            className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors active:scale-[0.98] ${
              editHistory.canRedo
                ? "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
                : "text-neutral-700 cursor-default"
            }`}
            aria-label="重做"
          >
            <RotateCw size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
