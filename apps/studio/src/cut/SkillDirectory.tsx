import { useEffect, useRef, useState } from "react";
import type { SKILL_DIRECTORY } from "@video-workbench/contracts";
import "./skill-directory.css";

type Directory = typeof SKILL_DIRECTORY;
const discoverPrompt = "请只读查询当前 Codex 官方 Plugin/Marketplace 清单，推荐可用于剪辑工作台的 Skills。分开说明已安装、已启用、本任务已加载和兼容性；核对实际 Plugin、来源、版本、Runtime 要求与权限。先给我计划，不安装、不升级、不修改项目，等我确认。";
const adaptPrompt = "我想把一个外部仓库或工具接入剪辑工作台，请先问我要来源，然后只读评估许可、固定版本、依赖、权限与输入输出。判断应包装为 Skill、受控工具、Runtime 命令还是 Studio 功能，给出最小验证方案。未经确认不执行外部代码、不安装、不发布、不修改项目。";

export function SkillDirectory({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    const abort = new AbortController();
    void fetch("/api/v1/skills", { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error("目录暂时不可用，请关闭后重试；未执行安装。");
      const value = await response.json();
      if (!value || value.schemaVersion !== 2 || value.sourceKind !== "independent-local-candidates"
        || typeof value.pluginId !== "string" || value.publicReleaseReady !== false
        || value.installUnit !== "independent-skill" || !/^[a-f0-9]{64}$/.test(value.catalogSha256)
        || !Array.isArray(value.skills) || value.skills.length > 100
        || !value.skills.every((s: { name?: unknown; description?: unknown; version?: unknown; minimumRuntimeVersion?: unknown } | null) => s
          && typeof s.name === "string" && /^[a-z0-9-]+$/.test(s.name) && typeof s.description === "string"
          && typeof s.version === "string" && typeof s.minimumRuntimeVersion === "string")) {
        throw new Error("目录格式不兼容，不能判断能力是否可用。");
      }
      if (!abort.signal.aborted) setData(value);
    }).catch(reason => { if (!abort.signal.aborted) setError(String(reason.message ?? reason)); });
    return () => abort.abort();
  }, []);
  const draft = (text: string) => { setPrompt(text); setCopied(false); };
  const entries = data?.skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase().trim())) ?? [];
  return <dialog ref={dialog} className="cf-skills" aria-labelledby="cf-skills-title" onCancel={onClose}>
    <header><div><h2 id="cf-skills-title">Skills 能力</h2><p>了解已有能力，交给 Agent 检查后使用。</p></div><button onClick={onClose} aria-label="关闭 Skills 能力">关闭</button></header>
    <p className="cf-skills-notice">这是随工作台提供的源码目录，不是你已安装的清单。安装、启用、当前任务加载和兼容状态均待 Codex 核实。</p>
    <div className="cf-skills-actions"><button onClick={() => draft(discoverPrompt)}>让 Agent 发现更多</button><button onClick={() => draft(adaptPrompt)}>评估外部工具</button></div>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">正在读取内置目录…</p>}
    {data && <>
      <p className="cf-skills-meta">本地候选 · 尚未公开发行 · 安装单位：独立 Skill<br />清单摘要 {data.catalogSha256.slice(0, 12)}（不代表当前安装版本）</p>
      <label>搜索内置 Skills<input value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：字幕、剪口播、画面" /></label>
      <p className="cf-skills-meta">小黑动画独立维护；排查、更新和 Bug 反馈统一归维护与排障。旧兼容名称不列入默认目录。</p>
      <div className="cf-skills-list">{entries.map(skill => <article key={skill.name}>
        <h3>{skill.name}</h3><p>{skill.description}</p><small>候选版本 {skill.version} · 工程操作核对 Runtime {skill.minimumRuntimeVersion}+ 及实际能力</small>
        <small>已安装 / 已启用 / 本任务已加载 / 兼容：待核实</small>
        <button onClick={() => draft(`请先检查本任务是否已加载 ${skill.name}，需要工程操作时核对实际 Runtime 能力。此目录是 ${data.pluginId} 的本地候选清单，摘要 ${data.catalogSha256}，不代表我已安装，也不是公开下载凭据。如果可用，请说明用途并问我具体需求；若缺包或不兼容，先核实实际来源和安装计划，等我确认。不要猜下载地址、直接剪辑、安装、升级或修改项目。`)}>生成使用提示词</button>
      </article>)}</div>
      {!entries.length && <p role="status">没有匹配的内置 Skill，可让 Agent 查询官方来源。</p>}
    </>}
    {prompt && <section className="cf-skills-prompt"><label>交给 Agent 的提示词<textarea readOnly value={prompt} rows={5} onFocus={e => e.target.select()} /></label><button onClick={async () => {
      try { await navigator.clipboard.writeText(prompt); setCopied(true); } catch { setCopied(false); }
    }}>{copied ? "已复制" : "复制提示词"}</button><small>也可直接选中文字复制。这里不会执行任务或安装。</small></section>}
  </dialog>;
}
