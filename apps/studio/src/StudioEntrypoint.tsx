import { useEffect, useMemo, useState } from "react";
import { StandaloneCutApp } from "./cut/StandaloneCutApp";
import { ProductStudio } from "./ProductStudio";
import { buildProjectApiPath, parseProjectHashRoute } from "./utils/projectRouting";

type StudioSurface = "koubo" | "product" | "resolving";

interface StudioEntrypointRoute {
  locationKey: string;
  projectId: string | null;
  surface: StudioSurface;
}

interface KouboSurfaceResponse {
  projectId: string;
  schemaVersion: number;
  surface: "koubo";
}

export interface StudioEntrypointProps {
  /** Injectable for route tests. Production uses the browser fetch implementation. */
  fetchImpl?: typeof fetch;
}

function currentUrl(): URL {
  return new URL(window.location.href);
}

function locationKey(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Route only on an explicit surface when one is present. Legacy project links
 * deliberately remain unresolved until the Product Runtime identifies them.
 */
export function readStudioEntrypointRoute(url = currentUrl()): StudioEntrypointRoute {
  const key = locationKey(url);
  if (url.searchParams.has("view")) {
    return {
      locationKey: key,
      projectId: parseProjectHashRoute(url.hash)?.projectId ?? null,
      surface: url.searchParams.get("view") === "koubo" ? "koubo" : "product",
    };
  }

  const project = parseProjectHashRoute(url.hash);
  if (!project) {
    return { locationKey: key, projectId: null, surface: "product" };
  }
  return { locationKey: key, projectId: project.projectId, surface: "resolving" };
}

function isKouboSurfaceResponse(
  value: unknown,
  projectId: string,
): value is KouboSurfaceResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<KouboSurfaceResponse>;
  return response.schemaVersion === 1 &&
    response.projectId === projectId &&
    response.surface === "koubo";
}

async function isKouboProject(
  projectId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetchImpl(buildProjectApiPath(projectId, "surface"), {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) return false;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return isKouboSurfaceResponse(body, projectId);
}

function normalizeKouboUrl(): void {
  const url = currentUrl();
  url.searchParams.set("view", "koubo");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/**
 * Keeps legacy `#project/<id>` links backwards-compatible without treating
 * every HyperFrames project as a VideoCut project. The Runtime owns the
 * positive classification; unknown, malformed, and failed checks stay on the
 * generic Studio surface.
 */
export function StudioEntrypoint({ fetchImpl }: StudioEntrypointProps) {
  const [route, setRoute] = useState<StudioEntrypointRoute>(() => readStudioEntrypointRoute());
  const resolvedFetch = useMemo(
    () => fetchImpl ?? window.fetch.bind(window),
    [fetchImpl],
  );

  useEffect(() => {
    const updateRoute = () => setRoute(readStudioEntrypointRoute());
    window.addEventListener("hashchange", updateRoute);
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  useEffect(() => {
    if (route.surface !== "resolving" || !route.projectId) return;

    const controller = new AbortController();
    let cancelled = false;
    const requestedLocation = route.locationKey;

    void isKouboProject(route.projectId, resolvedFetch, controller.signal)
      .then((isKoubo) => {
        if (cancelled || locationKey(currentUrl()) !== requestedLocation) return;
        if (isKoubo) {
          normalizeKouboUrl();
          setRoute(readStudioEntrypointRoute());
          return;
        }
        setRoute((current) => current.locationKey === requestedLocation
          ? { ...current, surface: "product" }
          : current);
      })
      .catch(() => {
        if (cancelled || locationKey(currentUrl()) !== requestedLocation) return;
        setRoute((current) => current.locationKey === requestedLocation
          ? { ...current, surface: "product" }
          : current);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [route, resolvedFetch]);

  if (route.surface === "koubo") return <StandaloneCutApp />;
  if (route.surface === "product") return <ProductStudio />;

  return <main aria-busy="true" data-studio-surface-resolution="pending" />;
}
