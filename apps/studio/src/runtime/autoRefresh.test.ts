// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProtection } from "./activity";
import { startAutoRefresh } from "./autoRefresh";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

function service(sequence: Array<{ pid: number; studioBuildId: string }>) {
  let i = 0;
  return vi.fn(async () => new Response(JSON.stringify(sequence[Math.min(i++, sequence.length - 1)])));
}

describe("auto refresh", () => {
  it("reloads after a restart once the page is idle", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const stop = startAutoRefresh({ fetchImpl: service([{ pid: 1, studioBuildId: "a" }, { pid: 2, studioBuildId: "a" }]) as any,
      reload, pollMs: 100, quietMs: 0, protection: new RuntimeProtection() });
    await vi.advanceTimersByTimeAsync(250);
    expect(reload).toHaveBeenCalled();
    stop();
  });

  it("waits while something is unsaved and says why", async () => {
    vi.useFakeTimers();
    const reload = vi.fn(), protection = new RuntimeProtection(), key = Symbol("draft");
    protection.set(key, true);
    const stop = startAutoRefresh({ fetchImpl: service([{ pid: 1, studioBuildId: "a" }, { pid: 1, studioBuildId: "b" }]) as any,
      reload, pollMs: 100, quietMs: 0, protection });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(reload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("工作台已更新");
    protection.set(key, false);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(reload).toHaveBeenCalled();
    stop();
  });

  it("ignores polls when neither pid nor build changed", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const stop = startAutoRefresh({ fetchImpl: service([{ pid: 1, studioBuildId: "a" }]) as any, reload, pollMs: 100, quietMs: 0,
      protection: new RuntimeProtection() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();
    stop();
  });
});
