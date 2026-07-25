import { useEffect, useMemo, useState } from "react";
import { studioBootGuard } from "../bootstrap/studioBootGuard";
import { parseProjectHashRoute } from "../utils/projectRouting";
import { CutWorkspace } from "./CutWorkspace";
import "./cut.css";

interface CutRouteSnapshot {
  projectId: string | null;
  initialTime: number;
}

function readRouteSnapshot(): CutRouteSnapshot {
  const route = parseProjectHashRoute(window.location.hash);
  const rawTime = Number(route?.params.get("t"));
  return {
    projectId: route?.projectId ?? null,
    initialTime: Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : 0,
  };
}

function replaceTimelineTime(time: number): void {
  const route = parseProjectHashRoute(window.location.hash);
  if (!route || !Number.isFinite(time)) return;
  const params = new URLSearchParams(route.params);
  params.set("t", Math.max(0, time).toFixed(3).replace(/\.?0+$/, ""));
  const search = params.toString();
  const hash = `#project/${encodeURIComponent(route.projectId)}${search ? `?${search}` : ""}`;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
}

export function StandaloneCutApp() {
  const [route, setRoute] = useState<CutRouteSnapshot>(() => readRouteSnapshot());

  useEffect(() => {
    const update = () => setRoute(readRouteSnapshot());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  useEffect(() => {
    studioBootGuard()?.markReady();
  }, []);

  useEffect(() => {
    document.title = route.projectId
      ? `${route.projectId} · 剪口播`
      : "剪口播 · chengfeng-videocut";
  }, [route.projectId]);

  const projectLabel = useMemo(
    () => route.projectId?.replace(/^\d{4}-\d{2}-\d{2}_/, "") ?? "未选择项目",
    [route.projectId],
  );

  return (
    <main
      className="cf-cut-app"
      data-chengfeng-koubo-editor="true"
      data-koubo-player-contract="1"
      data-single-track-operations="move,trim,split,delete,restore,delete-range,restore-snapshot"
    >
      <header className="cf-cut-header">
        <div className="cf-cut-brand">
          <svg
            className="cf-cut-brand-mark"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect x="1" y="1" width="22" height="22" rx="6" />
            <path className="is-mint" d="M6.5 7.5 10.5 12l-4 4.5" />
            <path className="is-light" d="m17.5 7.5-4 4.5 4 4.5" />
            <path className="is-cut" d="M12 5v14" />
          </svg>
          <strong>chengfeng-videocut</strong>
          <span aria-hidden="true" />
          <p title={route.projectId ?? undefined}>{projectLabel}</p>
        </div>

      </header>

      {route.projectId ? (
        <CutWorkspace
          key={route.projectId}
          projectId={route.projectId}
          initialTimelineTime={route.initialTime}
          onTimelineTimeCommit={replaceTimelineTime}
        />
      ) : (
        <section className="cf-cut-route-error" role="alert">
          <strong>没有找到项目</strong>
          <p>请从剪口播流程进入，或使用包含 `#project/&lt;id&gt;` 的项目链接。</p>
        </section>
      )}
    </main>
  );
}
