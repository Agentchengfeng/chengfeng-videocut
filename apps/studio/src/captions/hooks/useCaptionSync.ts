import { useCallback, useEffect, useMemo } from "react";
import { runtimeProtection } from "../../runtime/activity";
import { useCaptionStore } from "../store";
import { applyCaptionOverrides, buildCaptionOverrides, parseCaptionOverrides } from "../overrides";
import { studioFileContentVersion } from "../../utils/studioFileVersion";
export { applyCaptionOverrides, buildCaptionOverrides, type CaptionOverrideEntry } from "../overrides";

export interface CaptionSyncIO {
  readProjectFile(path: string): Promise<string>;
  readOptionalProjectFile(path: string): Promise<string>;
  writeProjectFile(path: string, content: string, expectedContent?: string): Promise<void>;
  observeProjectFileVersion(path: string, version: string | null): void;
  showToast(message: string, tone?: "error" | "info"): void;
}
const PATH = "caption-overrides.json";
type Model = NonNullable<ReturnType<typeof useCaptionStore.getState>["model"]>;

/** IO closures and pending drafts are bound to one project, never a live ID ref. */
export function useCaptionSync(projectId: string | null, io: CaptionSyncIO) {
  const session = useMemo(() => ({
    projectId, io, source: null as string | null, sourceContent: null as string | null, sourceVersion: null as string | null,
    baseline: undefined as string | undefined, loaded: false, loading: 0, blocked: false,
    pending: null as { model: Model; source: string; content: string } | null,
    running: null as Promise<void> | null, timer: null as ReturnType<typeof setTimeout> | null,
    applying: false, disposed: false, unsupportedDirty: false, protectionKey: Symbol("caption-draft"),
  }), [projectId, io.readProjectFile, io.readOptionalProjectFile, io.writeProjectFile, io.observeProjectFileVersion, io.showToast]);
  const report = useCallback((reason: unknown) => {
    if (session.pending || session.running || session.unsupportedDirty) runtimeProtection.set(session.protectionKey, true);
    session.io.showToast(`字幕未保存（${session.projectId ?? "未选择项目"}/${session.source ?? "字幕"}）：${reason instanceof Error ? reason.message : String(reason)}`, "error");
  }, [session]);
  const flush = useCallback((): Promise<void> => {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    if (session.running) return session.running;
    if (!session.pending || !session.loaded || session.blocked) return Promise.resolve();
    session.running = (async () => {
      while (session.pending && !session.blocked) {
        const draft = session.pending;
        try {
          if (draft.source !== session.source || session.sourceContent === null) throw new Error("字幕源已切换，请重新打开字幕");
          const source = await session.io.readProjectFile(draft.source);
          if (source !== session.sourceContent) throw new Error("源文档已被修改，请保留当前草稿并重新核对");
          if (session.baseline === undefined) session.io.observeProjectFileVersion(PATH, null);
          await session.io.writeProjectFile(PATH, draft.content, session.baseline);
          session.baseline = draft.content;
          if (session.pending === draft) session.pending = null;
        } catch (error) { session.blocked = true; report(error); }
      }
    })().finally(() => {
      session.running = null;
      runtimeProtection.set(session.protectionKey, Boolean(session.pending || session.unsupportedDirty));
    });
    return session.running;
  }, [session, report]);
  const queue = useCallback((model: Model, source: string) => {
    runtimeProtection.set(session.protectionKey, true);
    try {
      if (session.source && session.source !== source) throw new Error("源文档已切换，未将旧草稿写入新字幕");
      session.pending = { model, source, content: JSON.stringify(buildCaptionOverrides(model).map(entry => ({ ...entry, sourcePath: source, sourceVersion: session.sourceVersion })), null, 2) };
      if (session.blocked) return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => { void flush(); }, 800);
    } catch (error) { session.blocked = true; report(error); }
  }, [session, flush, report]);
  useEffect(() => {
    session.disposed = false;
    let previous = useCaptionStore.getState();
    const unsubscribe = useCaptionStore.subscribe(state => {
      const old = previous; previous = state;
      if (session.applying) return;
      // Detection replaces the whole parsed model before updating its source
      // path. Never mistake that intermediate state for a user edit of the old source.
      const sameParsedSource = state.model?.groups === old.model?.groups && state.model?.groupOrder === old.model?.groupOrder;
      const sharesSegments = state.model && old.model && [...state.model.segments].some(([id, segment]) => old.model!.segments.get(id) === segment);
      if (state.isEditMode && state.model && old.model && state.model !== old.model && !sameParsedSource && sharesSegments) {
        session.unsupportedDirty = true;
        report("组级样式/动画/分组合并尚不支持保存；此次组修改未保存");
      }
      if (state.isEditMode && state.model && state.sourceFilePath && state.model !== old.model && sameParsedSource) queue(state.model, state.sourceFilePath);
      if (state.model !== old.model && !sameParsedSource) void flush();
      if (old.isEditMode && (!state.isEditMode || state.sourceFilePath !== old.sourceFilePath)) void flush();
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!session.pending && !session.running && !session.unsupportedDirty) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      session.disposed = true; session.loading++;
      unsubscribe(); window.removeEventListener("beforeunload", beforeUnload);
      if (session.pending && (!session.loaded || session.blocked)) report("离开时仍有未保存草稿，请返回原项目核对");
      if (session.unsupportedDirty) report("离开时仍有未保存的组级修改");
      // Only the captured old-project draft is flushed through old-project IO.
      void flush();
    };
  }, [session, queue, flush, report]);
  const save = useCallback(async () => {
    const state = useCaptionStore.getState();
    if (!projectId || !state.model || !state.sourceFilePath || !state.isEditMode) return;
    queue(state.model, state.sourceFilePath); await flush();
  }, [projectId, queue, flush]);
  const loadOverrides = useCallback(async (parsedSourceContent?: string) => {
    const state = useCaptionStore.getState();
    if (!projectId || !state.model || !state.sourceFilePath) return;
    const token = ++session.loading;
    if (session.pending || session.running) {
      await flush();
      if (session.pending || session.blocked) { report("已有未保存编辑，未用磁盘版本覆盖当前草稿"); return; }
    }
    if (session.disposed || token !== session.loading) return;
    const source = state.sourceFilePath;
    session.source = source; session.loaded = false;
    try {
      const [sourceContent, content] = await Promise.all([session.io.readProjectFile(source), session.io.readOptionalProjectFile(PATH)]);
      if (session.disposed || token !== session.loading) return;
      const current = useCaptionStore.getState();
      if (current.sourceFilePath !== source || !current.isEditMode) return;
      if (parsedSourceContent !== undefined && sourceContent !== parsedSourceContent) throw new Error("源文档在解析后已变化，未绑定错误的字幕版本");
      if (current.model !== state.model || session.pending) throw new Error("加载期间已有新编辑，已保留草稿；请核对后重新打开字幕");
      const overrides = content ? parseCaptionOverrides(JSON.parse(content)) : [];
      const sourceVersion = await studioFileContentVersion(sourceContent);
      if (session.disposed || token !== session.loading) return;
      if (useCaptionStore.getState().sourceFilePath !== source || !useCaptionStore.getState().isEditMode) return;
      if (useCaptionStore.getState().model !== state.model) throw new Error("加载期间已有新编辑，已保留草稿");
      for (const entry of overrides) {
        if (entry.sourcePath !== undefined) {
          if (entry.sourcePath !== source || entry.sourceVersion !== sourceVersion) throw new Error("字幕覆盖记录属于另一源文档或版本，未自动套用");
        } else if (entry.text !== undefined || entry.start !== undefined || entry.end !== undefined) throw new Error("旧字幕文字/时间缺少源绑定，须核对后重新交付；未自动套用");
      }
      const segments = applyCaptionOverrides(state.model, overrides);
      session.sourceContent = sourceContent; session.baseline = content || undefined;
      session.sourceVersion = sourceVersion;
      session.loaded = true; session.blocked = false;
      session.unsupportedDirty = false;
      runtimeProtection.set(session.protectionKey, Boolean(session.pending || session.running));
      session.applying = true;
      try { useCaptionStore.getState().setModel({ ...state.model, segments }); }
      finally { session.applying = false; }
    } catch (error) { if (!session.disposed && token === session.loading) { session.blocked = true; report(error); } }
  }, [projectId, session, report, flush]);
  return useMemo(() => ({ save, loadOverrides }), [save, loadOverrides]);
}
