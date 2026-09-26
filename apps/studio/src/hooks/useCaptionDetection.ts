import { useEffect, useRef } from "react";
import { useCaptionStore } from "../captions/store";
import { acceptStudioRuntimeMessage } from "../player/lib/runtimeProtocol";
import { useCaptionSync } from "../captions/hooks/useCaptionSync";
import { parseCaptionComposition } from "../captions/parser";
import { resolveCaptionSource } from "./captionSourceResolver";

interface UseCaptionDetectionParams {
  projectId: string | null;
  activeCompPath: string | null;
  compIdToSrc: Map<string, string>;
  captionEditMode: boolean;
  captionHasSelection: boolean;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  captionSync: ReturnType<typeof useCaptionSync>;
  setRightCollapsed: (collapsed: boolean) => void;
  onError?: (message: string) => void;
}

export function useCaptionDetection({
  projectId,
  activeCompPath,
  compIdToSrc,
  captionEditMode,
  captionHasSelection,
  previewIframeRef,
  captionSync,
  setRightCollapsed,
  onError,
}: UseCaptionDetectionParams) {
  const lastFailure = useRef<{ key: string; doc: Document } | null>(null);
  const notifications = useRef({ key: "", reasons: new Set<string>() });
  const verified = useRef<{ project: string; path: string; content: string; doc: Document; scope: Element } | null>(null);
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const notificationKey = JSON.stringify([projectId, activeCompPath]);
    if (notifications.current.key !== notificationKey) notifications.current = { key: notificationKey, reasons: new Set() };
    if (!projectId) return;

    let activating = false;
    let cancelled = false;
    let attemptedDoc: Document | null = null;
    const contextKey = JSON.stringify([projectId, activeCompPath, [...compIdToSrc].sort(([a], [b]) => a.localeCompare(b))]);
    const report = (error: unknown) => {
      if (cancelled) return;
      if (attemptedDoc) lastFailure.current = { key: contextKey, doc: attemptedDoc };
      const message = `字幕识别失败：${error instanceof Error ? error.message : String(error)}`;
      if (!notifications.current.reasons.has(message)) {
        // Notification dedupe is separate from per-document retry admission.
        if (notifications.current.reasons.size >= 16) notifications.current.reasons.clear();
        notifications.current.reasons.add(message);
        onError?.(message);
      }
    };

    const tryActivateCaptions = () => {
      if (cancelled || activating) {
        return;
      }

      const iframe = previewIframeRef.current;
      let doc: Document | null = null;
      let win: Window | null = null;
      try {
        doc = iframe?.contentDocument ?? null;
        win = iframe?.contentWindow ?? null;
      } catch {
        return;
      }
      if (!doc || !win) return;
      if (lastFailure.current?.key === contextKey && lastFailure.current.doc === doc) return;
      attemptedDoc = doc;

      let resolved: ReturnType<typeof resolveCaptionSource>;
      try { resolved = resolveCaptionSource(doc, activeCompPath, compIdToSrc); }
      catch (error) { useCaptionStore.getState().setEditMode(false); report(error); return; }
      if (!resolved) {
        // A loading/non-caption document must not expose the previous source's editor.
        if (useCaptionStore.getState().isEditMode) useCaptionStore.getState().setEditMode(false);
        return;
      }
      const existing = useCaptionStore.getState();
      if (existing.model && existing.sourceFilePath) {
        if (existing.sourceFilePath !== resolved.path) {
          existing.setEditMode(false);
          report("已保留原字幕草稿；请返回原字幕核对后再切换来源，当前画面未开启编辑");
          return;
        }
        const previous = verified.current;
        if (!previous || previous.project !== projectId || previous.path !== resolved.path) {
          existing.setEditMode(false);
          report("原字幕草稿缺少已核验来源，已保留草稿并停止编辑；请核对后重新打开");
          return;
        }
        if (previous.doc === doc && previous.scope === resolved.scope) {
          if (!existing.isEditMode) existing.setEditMode(true);
          notifications.current.reasons.clear();
          return;
        }
        // A new preview document must not inherit editability merely by filename.
        // Preserve the draft while its source bytes and new DOM are checked.
        existing.setEditMode(false);
      }
      const retainedModel = existing.model;
      const binding = verified.current;
      activating = true;
      const { path: srcPath, scope, metadataScope } = resolved;
      fetch(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(srcPath)}`)
        .then((r) => { if (!r.ok) throw new Error(`读取 ${srcPath} 失败（${r.status}）`); return r.json(); })
        .then((data: { content?: string }) => {
          if (cancelled || !doc || !win || useCaptionStore.getState().isEditMode) return;
          if (iframe?.contentDocument !== doc || !scope.isConnected) return;
          if (!data.content) throw new Error("字幕源为空");
          if (retainedModel && data.content !== binding?.content) throw new Error("同名字幕源已更新，已保留旧草稿并停止编辑；请核对版本后重新打开");
          const root = scope;
          const w = parseInt(root?.getAttribute("data-width") ?? "1920", 10);
          const h = parseInt(root?.getAttribute("data-height") ?? "1080", 10);
          const dur = parseFloat(metadataScope.getAttribute("data-duration") ?? "0");
          let rejection = "UNKNOWN";
          const model = parseCaptionComposition(scope, win, data.content, w, h, dur, reason => { rejection = reason; });
          if (!model) throw new Error(`字幕源与画面无法对应（${rejection}），已拒绝编辑`);
          const store = useCaptionStore.getState();
          if (retainedModel) {
            if (store.model !== retainedModel || store.sourceFilePath !== srcPath) return;
            verified.current = { project: projectId, path: srcPath, content: data.content, doc, scope };
            store.setEditMode(true);
            notifications.current.reasons.clear();
            return;
          }
          verified.current = { project: projectId, path: srcPath, content: data.content, doc, scope };
          store.setModel(model);
          store.setSourceFilePath(srcPath);
          store.setEditMode(true);
          notifications.current.reasons.clear();
          captionSync.loadOverrides(data.content);
        })
        .catch(report)
        .finally(() => {
          activating = false;
        });
    };

    const handleMessage = (e: MessageEvent) => {
      const data = e.data;
      if (data?.source === "hf-preview" && (data?.type === "state" || data?.type === "timeline")) {
        if (!acceptStudioRuntimeMessage(data)) return;
        tryActivateCaptions();
      }
    };

    window.addEventListener("message", handleMessage);
    tryActivateCaptions();

    return () => {
      cancelled = true;
      window.removeEventListener("message", handleMessage);
    };
  }, [activeCompPath, projectId, compIdToSrc, captionSync, previewIframeRef, onError]);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (captionEditMode) {
      setRightCollapsed(!captionHasSelection);
    }
  }, [captionHasSelection, captionEditMode, setRightCollapsed]);
}
