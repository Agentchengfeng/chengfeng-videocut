import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntimeProtection } from "../runtime/useRuntimeProtection";
import { CANVAS_ASPECT_PRESETS, parseCanvasAspect } from "@video-workbench/core";

interface Snapshot { projectRevision: string; config: { aspectRatio: string | null } }
function snapshot(value: unknown): Snapshot {
  const v = value as Snapshot;
  if (!v || !/^[a-f0-9]{64}$/.test(v.projectRevision) || !v.config ||
      !(v.config.aspectRatio === null || typeof v.config.aspectRatio === "string")) throw new Error("画布回读格式不正确");
  return v;
}

/** A user draft is never replayed after a conflict; reload, inspect, then apply. */
export function CanvasSettings({ projectId, onSaved, presentation = "popover", active = true }: {
  projectId: string;
  onSaved: () => void;
  presentation?: "popover" | "panel";
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Snapshot | null>(null);
  const [ratio, setRatio] = useState("16:9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  const initialized = useRef(false);
  useRuntimeProtection(hasDraft, false, `canvas:${projectId}`);
  useEffect(() => { epoch.current++; pending.current = false; initialized.current = false; setOpen(false); setCurrent(null); setError(null); setSaved(null); setBusy(false); setHasDraft(false);
    return () => { epoch.current++; }; }, [projectId]);
  const url = `/api/v1/projects/${encodeURIComponent(projectId)}/project-config`;
  const request = useCallback(async (method: "GET" | "PATCH", body?: unknown) => {
    const response = await fetch(url, { method, cache: "no-store", ...(body ? {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.code === "revision_conflict"
      ? "项目已被其他操作更新。请重新读取后确认，不会自动覆盖。"
      : data?.error?.code === "project_busy" ? "项目任务正在运行，请完成后再改画布。"
      : data?.error?.message || `画布请求失败（${response.status}）`);
    return snapshot(data);
  }, [url]);
  const load = useCallback(async () => {
    if (pending.current) return;
    initialized.current = true; pending.current = true; const token = epoch.current;
    setOpen(true); setBusy(true); setError(null); setSaved(null); setCurrent(null);
    try { const value = await request("GET"); if (token === epoch.current) { setCurrent(value); setRatio(value.config.aspectRatio ?? "16:9"); setHasDraft(false); } }
    catch (e) { if (token === epoch.current) setError(String((e as Error).message)); }
    finally { if (token === epoch.current) { pending.current = false; setBusy(false); } }
  }, [request]);
  useEffect(() => {
    // A hidden sidebar keeps its draft and reviewed revision. Reopening it is
    // not a reload, including after a conflict that needs explicit review.
    if (presentation === "panel" && active && !initialized.current) void load();
  }, [presentation, active, load]);
  async function apply() {
    if (!current || pending.current) return;
    setHasDraft(true);
    if (!parseCanvasAspect(ratio)) { setError("请输入受支持的正整数比例，如 4:5；画布长边不能超过 8192。"); return; }
    pending.current = true; const token = epoch.current;
    setBusy(true); setError(null); setSaved(null);
    try {
      const result = await request("PATCH", { confirmed: true, expectedRevision: current.projectRevision, config: { aspectRatio: ratio.trim() } });
      if (token !== epoch.current) return;
      setCurrent(result); setRatio(result.config.aspectRatio ?? ratio); setHasDraft(false); setSaved(`已保存 ${result.config.aspectRatio ?? ratio}`); onSaved();
    } catch (e) { if (token === epoch.current) { setError(String((e as Error).message)); setCurrent(null); } }
    finally { if (token === epoch.current) { pending.current = false; setBusy(false); } }
  }
  return <div className={`cf-canvas-settings${presentation === "panel" ? " cf-canvas-settings--inline" : ""}`} hidden={presentation === "panel" && !active}>
    {presentation === "popover" && <button type="button" onClick={() => open ? setOpen(false) : void load()} aria-expanded={open}>画布比例</button>}
    {(presentation === "panel" || open) && <div className="cf-canvas-settings__panel" role="group" aria-label="项目画布设置">
      <label>预设 <select aria-label="画布预设" disabled={busy} value={CANVAS_ASPECT_PRESETS.some(value => value === ratio) ? ratio : "custom"}
        onChange={e => { setHasDraft(true); setSaved(null); setRatio(e.target.value === "custom" ? "4:5" : e.target.value); }}>
        {CANVAS_ASPECT_PRESETS.map(value => <option key={value} value={value}>{value}</option>)}
        <option value="custom">自定义</option>
      </select></label>
      <label>宽:高 <input aria-label="自定义画布比例" value={ratio} disabled={busy} onChange={e => { setHasDraft(true); setSaved(null); setRatio(e.target.value); }} /></label>
      <span>比例决定构图；清晰度在导出时选择。原片等比适配，动画需匹配构图。</span>
      {error && <span role="alert">{error}</span>}
      {saved && <span role="status">{saved}</span>}
      <div className="cf-canvas-settings__actions"><button type="button" disabled={busy || !current} onClick={() => void apply()}>{busy ? "处理中…" : "应用画布"}</button>
        <button type="button" disabled={busy} onClick={() => void load()}>重新读取</button></div>
    </div>}
  </div>;
}
