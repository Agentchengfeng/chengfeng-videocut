import {
  memo,
  useState,
  useCallback,
  useImperativeHandle,
  useRef,
  forwardRef,
  type ReactNode,
} from "react";
import { CompositionsTab } from "./CompositionsTab";
import { AssetsTab } from "./AssetsTab";
import { trackStudioEvent } from "../../utils/studioTelemetry";
import { BlocksTab, type BlockPreviewInfo } from "./BlocksTab";
import { FileTree } from "../editor/FileTree";
import { STUDIO_BLOCKS_PANEL_ENABLED } from "../editor/manualEditingAvailability";
import { Tooltip } from "../ui";

export type SidebarTab = "compositions" | "assets" | "code" | "blocks";

export interface LeftSidebarHandle {
  selectTab: (tab: SidebarTab) => void;
  getTab: () => SidebarTab;
}

const STORAGE_KEY = "cf-studio-sidebar-tab-v1";

function getPersistedTab(): SidebarTab {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "assets") return "assets";
  if (stored === "code") return "code";
  if (stored === "blocks") return "blocks";
  return "compositions";
}

interface LeftSidebarProps {
  width?: number;
  projectId: string;
  compositions: string[];
  assets: string[];
  activeComposition: string | null;
  onSelectComposition: (comp: string) => void;
  onImportFiles?: (files: FileList, dir?: string) => void;
  fileTree?: string[];
  editingFile?: { path: string; content: string | null } | null;
  onSelectFile?: (path: string) => void;
  onCreateFile?: (path: string) => void;
  onCreateFolder?: (path: string) => void;
  onDeleteFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onDuplicateFile?: (path: string) => void;
  onMoveFile?: (oldPath: string, newPath: string) => void;
  codeChildren?: ReactNode;
  onRenderComposition?: (comp: string) => void;
  isRendering?: boolean;
  onLint?: () => void;
  linting?: boolean;
  lintFindingCount?: number;
  lintFindingsByFile?: Map<string, { count: number; messages: string[] }>;
  onToggleCollapse?: () => void;
  onAddBlock?: (blockName: string) => void;
  onPreviewBlock?: (preview: BlockPreviewInfo | null) => void;
  takeoverContent?: ReactNode;
}

export const LeftSidebar = memo(
  forwardRef<LeftSidebarHandle, LeftSidebarProps>(function LeftSidebar(
    {
      width = 240,
      projectId,
      compositions,
      assets,
      activeComposition,
      onSelectComposition,
      onImportFiles,
      fileTree: fileProp,
      editingFile,
      onSelectFile,
      onCreateFile,
      onCreateFolder,
      onDeleteFile,
      onRenameFile,
      onDuplicateFile,
      onMoveFile,
      codeChildren,
      onRenderComposition,
      isRendering,
      onLint,
      linting,
      lintFindingCount,
      lintFindingsByFile,
      onToggleCollapse,
      onAddBlock,
      onPreviewBlock,
      takeoverContent,
    },
    ref,
  ) {
    const [tab, setTab] = useState<SidebarTab>(getPersistedTab);
    const tabRef = useRef(tab);
    tabRef.current = tab;

    const selectTab = useCallback((t: SidebarTab) => {
      setTab(t);
      localStorage.setItem(STORAGE_KEY, t);
      trackStudioEvent("tab_switch", { panel: "left_sidebar", tab: t });
    }, []);

    const getTab = useCallback(() => tabRef.current, []);

    useImperativeHandle(ref, () => ({ selectTab, getTab }), [
      selectTab,
      getTab,
    ]);

    return (
      <div
        className="cf-left-sidebar flex flex-col h-full bg-neutral-950 border-r border-neutral-800/50"
        style={{ width }}
      >
        {takeoverContent ? (
          <div className="flex min-h-0 flex-1">{takeoverContent}</div>
        ) : (
          <>
            <div className="cf-sidebar-head border-b border-neutral-800/50 px-3 py-3 flex-shrink-0">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="cf-panel-kicker">动画资产</span>
                {onToggleCollapse && (
                  <button
                    type="button"
                    onClick={onToggleCollapse}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-transparent text-neutral-500 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-neutral-300"
                    title="收起动画段面板"
                    aria-label="收起动画段面板"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m14 7-5 5 5 5" />
                      <path d="M19 4v16" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="cf-sidebar-tabs grid min-w-0 flex-1 gap-1 rounded-md bg-neutral-900 p-1"
                  style={{
                    gridTemplateColumns: STUDIO_BLOCKS_PANEL_ENABLED
                      ? "1fr 1fr 1fr 1fr"
                      : "1fr 1fr 1fr",
                  }}
                >
                  <Tooltip label="动画段与子动画" side="bottom">
                    <button
                      type="button"
                      onClick={() => selectTab("compositions")}
                      className={`cf-sidebar-tab truncate rounded-md px-1.5 py-2 text-[11px] font-semibold transition-colors ${
                        tab === "compositions" ? "is-active" : ""
                      }`}
                    >
                      动画段
                    </button>
                  </Tooltip>
                  <Tooltip label="视频、图片、音频与字体" side="bottom">
                    <button
                      type="button"
                      onClick={() => selectTab("assets")}
                      className={`cf-sidebar-tab truncate rounded-md px-1.5 py-2 text-[11px] font-semibold transition-colors ${tab === "assets" ? "is-active" : ""}`}
                    >
                      素材
                    </button>
                  </Tooltip>
                  {STUDIO_BLOCKS_PANEL_ENABLED && (
                    <Tooltip label="动画模板与组件" side="bottom">
                      <button
                        type="button"
                        onClick={() => selectTab("blocks")}
                        className={`cf-sidebar-tab truncate rounded-md px-1.5 py-2 text-[11px] font-semibold transition-colors ${tab === "blocks" ? "is-active" : ""}`}
                      >
                        模板
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip label="源码与文件" side="bottom">
                    <button
                      type="button"
                      onClick={() => selectTab("code")}
                      className={`cf-sidebar-tab truncate rounded-md px-1.5 py-2 text-[11px] font-semibold transition-colors ${tab === "code" ? "is-active" : ""}`}
                    >
                      源码
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Tab content */}
            {tab === "compositions" && (
              <CompositionsTab
                projectId={projectId}
                compositions={compositions}
                activeComposition={activeComposition}
                onSelect={onSelectComposition}
                onRenderComposition={onRenderComposition}
                isRendering={isRendering}
                lintFindingsByFile={lintFindingsByFile}
              />
            )}
            {tab === "assets" && (
              <AssetsTab
                projectId={projectId}
                assets={assets}
                onImport={onImportFiles}
                onDelete={onDeleteFile}
                onRename={onRenameFile}
              />
            )}
            {tab === "code" && (
              <div className="flex flex-1 min-h-0">
                {(fileProp?.length ?? 0) > 0 && (
                  <div className="w-[160px] flex-shrink-0 border-r border-neutral-800 overflow-y-auto">
                    <FileTree
                      files={fileProp ?? []}
                      activeFile={editingFile?.path ?? null}
                      onSelectFile={onSelectFile ?? (() => {})}
                      onCreateFile={onCreateFile}
                      onCreateFolder={onCreateFolder}
                      onDeleteFile={onDeleteFile}
                      onRenameFile={onRenameFile}
                      onDuplicateFile={onDuplicateFile}
                      onMoveFile={onMoveFile}
                      onImportFiles={onImportFiles}
                      lintFindingsByFile={lintFindingsByFile}
                    />
                  </div>
                )}
                <div className="flex-1 overflow-hidden min-w-0">
                  {codeChildren ?? (
                    <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
                      选择文件后编辑
                    </div>
                  )}
                </div>
              </div>
            )}

            {STUDIO_BLOCKS_PANEL_ENABLED && tab === "blocks" && (
              <BlocksTab
                onAddBlock={onAddBlock}
                onPreviewBlock={onPreviewBlock}
              />
            )}

            {/* Lint button pinned at the bottom */}
            {onLint && (
              <div className="border-t border-neutral-800 p-2 flex-shrink-0">
                <button
                  onClick={onLint}
                  disabled={linting}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium text-neutral-500 hover:text-amber-300 hover:bg-neutral-800 transition-colors disabled:opacity-40"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                  </svg>
                  {linting ? "检查中…" : "规范检查"}
                  {!linting &&
                    lintFindingCount != null &&
                    lintFindingCount > 0 && (
                      <span className="ml-1 min-w-[16px] rounded-full bg-amber-500/20 px-1 text-[9px] font-bold text-amber-400">
                        {lintFindingCount}
                      </span>
                    )}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }),
);
