import { runtimeProtection, type RuntimeProtection } from "./activity";

/**
 * Keep an open page in step with the Runtime it talks to.
 *
 * A Runtime restart (a new build, or the same build started again) leaves an
 * open page on old code or with notifications it never received, and the only
 * fix used to be a manual hard refresh. The page now notices — the service's
 * pid or Studio build changed — and reloads itself, but only when nothing is
 * unsaved, nothing is being dragged or played, and the person has not touched
 * the page for a few seconds. Until then a short notice says why it is waiting.
 */
export function startAutoRefresh({
  protection = runtimeProtection,
  fetchImpl = window.fetch.bind(window),
  reload = () => window.location.reload(),
  pollMs = 10_000,
  quietMs = 3_000,
}: {
  protection?: RuntimeProtection;
  fetchImpl?: typeof fetch;
  reload?: () => void;
  pollMs?: number;
  quietMs?: number;
} = {}) {
  let identity: { pid: unknown; build: unknown } | null = null;
  let pending: "update" | "restart" | null = null;
  let lastInput = Date.now();
  let banner: HTMLDivElement | null = null;
  let stopped = false;
  const onInput = () => { lastInput = Date.now(); };
  window.addEventListener("pointerdown", onInput, true);
  window.addEventListener("keydown", onInput, true);

  const show = (text: string) => {
    if (!banner) {
      banner = document.createElement("div");
      banner.setAttribute("role", "status");
      banner.dataset.studioAutoRefresh = "true";
      Object.assign(banner.style, {
        position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)", zIndex: "9999",
        padding: "6px 12px", borderRadius: "6px", background: "rgba(24,24,27,.92)", color: "#e4e4e7",
        font: "400 12px/1.4 -apple-system, 'PingFang SC', sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.35)",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.append(banner);
    }
    banner.textContent = text;
  };

  const idle = () => !protection.hasUnsaved() && !protection.read().playing && Date.now() - lastInput >= quietMs;
  const tryReload = () => {
    if (stopped || !pending) return;
    if (idle()) { reload(); return; }
    show(pending === "update" ? "工作台已更新，保存完手上的修改后会自动刷新" : "工作台已重启，空闲后会自动刷新以同步最新内容");
    setTimeout(tryReload, 1_000);
  };

  const check = async () => {
    try {
      const response = await fetchImpl("/api/health", { cache: "no-store" });
      if (!response.ok) return;
      const health = await response.json() as { pid?: unknown; studioBuildId?: unknown };
      const next = { pid: health.pid, build: health.studioBuildId };
      if (!identity) { identity = next; return; }
      if (next.build !== identity.build) pending = "update";
      else if (next.pid !== identity.pid && pending !== "update") pending = "restart";
      if (pending) tryReload();
    } catch {
      // Service unreachable (restarting): the next successful check decides.
    }
  };

  void check();
  const timer = setInterval(() => { void check(); }, pollMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("pointerdown", onInput, true);
    window.removeEventListener("keydown", onInput, true);
    banner?.remove();
  };
}
