// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const productStudioSpy = vi.hoisted(() => vi.fn());
const standaloneCutAppSpy = vi.hoisted(() => vi.fn());

vi.mock("./ProductStudio", () => ({
  ProductStudio: () => {
    productStudioSpy();
    return <main data-studio-surface="product" />;
  },
}));

vi.mock("./cut/StandaloneCutApp", () => ({
  StandaloneCutApp: () => {
    standaloneCutAppSpy();
    return <main data-studio-surface="koubo" />;
  },
}));

import { readStudioEntrypointRoute, StudioEntrypoint } from "./StudioEntrypoint";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderEntrypoint(fetchImpl: typeof fetch) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<StudioEntrypoint fetchImpl={fetchImpl} />));
  return {
    host,
    unmount: () => act(() => root.unmount()),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  productStudioSpy.mockClear();
  standaloneCutAppSpy.mockClear();
});

describe("StudioEntrypoint", () => {
  it("routes an explicit Koubo view immediately without classification", () => {
    window.history.replaceState(null, "", "/?view=koubo#project/cut-demo?t=12");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const view = renderEntrypoint(fetchImpl);

    expect(view.host.querySelector('[data-studio-surface="koubo"]')).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps an explicit non-Koubo view on the generic Studio surface", () => {
    window.history.replaceState(null, "", "/?view=hyperframes#project/generic-demo");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const view = renderEntrypoint(fetchImpl);

    expect(view.host.querySelector('[data-studio-surface="product"]')).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    view.unmount();
  });

  it("normalizes a legacy bare Koubo project link only after an exact positive response", async () => {
    window.history.replaceState(null, "", "/?source=legacy#project/cut-demo?t=12&tab=renders");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      schemaVersion: 1,
      projectId: "cut-demo",
      surface: "koubo",
    })) as unknown as typeof fetch;
    const view = renderEntrypoint(fetchImpl);

    expect(view.host.querySelector('[data-studio-surface="product"]')).toBeNull();
    expect(view.host.querySelector('[data-studio-surface-resolution="pending"]')).not.toBeNull();

    await flushPromises();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/projects/cut-demo/surface",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(view.host.querySelector('[data-studio-surface="koubo"]')).not.toBeNull();
    const url = new URL(window.location.href);
    expect(url.searchParams.get("view")).toBe("koubo");
    expect(url.searchParams.get("source")).toBe("legacy");
    expect(url.hash).toBe("#project/cut-demo?t=12&tab=renders");
    view.unmount();
  });

  it("fails closed to generic Studio for unknown or malformed classifier responses", async () => {
    window.history.replaceState(null, "", "/#project/generic-demo");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      schemaVersion: 1,
      projectId: "other-project",
      surface: "koubo",
    })) as unknown as typeof fetch;
    const view = renderEntrypoint(fetchImpl);

    await flushPromises();

    expect(view.host.querySelector('[data-studio-surface="product"]')).not.toBeNull();
    expect(new URL(window.location.href).searchParams.has("view")).toBe(false);
    view.unmount();
  });

  it("ignores a late legacy-project response after the hash changes", async () => {
    window.history.replaceState(null, "", "/#project/first-project");
    const firstRequests: Array<Deferred<Response>> = [];
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/first-project/surface")) {
        const request = deferred<Response>();
        firstRequests.push(request);
        return request.promise;
      }
      return Promise.resolve(jsonResponse({ error: "not a Koubo project" }, 404));
    });
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const view = renderEntrypoint(fetchImpl);

    await flushPromises();
    expect(firstRequests.length).toBeGreaterThan(0);
    window.history.pushState(null, "", "/#project/second-project");
    act(() => window.dispatchEvent(new Event("hashchange")));
    await flushPromises();
    expect(fetchSpy.mock.calls.some((call) =>
      String(call[0]).includes("/second-project/surface"),
    )).toBe(true);

    await act(async () => {
      for (const request of firstRequests) {
        request.resolve(jsonResponse({
          schemaVersion: 1,
          projectId: "first-project",
          surface: "koubo",
        }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.host.querySelector('[data-studio-surface="product"]')).not.toBeNull();
    expect(new URL(window.location.href).hash).toBe("#project/second-project");
    expect(new URL(window.location.href).searchParams.has("view")).toBe(false);
    view.unmount();
  });
});

describe("readStudioEntrypointRoute", () => {
  it("does not classify a location that is not a project route", () => {
    const route = readStudioEntrypointRoute(new URL("http://localhost/#welcome"));
    expect(route).toMatchObject({ projectId: null, surface: "product" });
  });
});
