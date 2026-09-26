// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProtection, startRuntimeActivity } from "./activity";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(sessionId = "test-tab") {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ enabled: true }), { status: 200 }));
  const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  const protection = new RuntimeProtection();
  cleanups.push(startRuntimeActivity({ protection, fetchImpl, sessionId }));
  return { protection, fetchImpl, beacon, updates: () => fetchImpl.mock.calls.flatMap(call => {
    const init = (call as unknown as [string, RequestInit])[1];
    return init?.method === "POST" ? [JSON.parse(String(init.body))] : [];
  }) };
}
async function flush() { await vi.advanceTimersByTimeAsync(0); }

describe("runtime activity lease", () => {
  it("unknown coverage blocks shutdown but never pretends clean drafts are unsaved", async () => {
    const client = setup(); await flush();
    client.protection.guard(Symbol()); await flush();
    expect(client.updates().at(-1).dirty).toBe(true);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  });
  it("disabled runtimes receive no activity posts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ enabled: false })));
    cleanups.push(startRuntimeActivity({ fetchImpl })); await flush();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("keeps visible reading active; hidden clean tabs inactive without counting probes", async () => {
    const client = setup(); await flush();
    expect(client.updates().at(-1)).toMatchObject({ active: true, dirty: false, playing: false });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange")); await flush();
    expect(client.updates().at(-1)).toMatchObject({ active: false });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(client.updates().at(-1)).toMatchObject({ active: false });
  });
  it("tracks playback when hidden and retains unsaved drafts on unmount", async () => {
    const client = setup(); await flush();
    const key = Symbol();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    client.protection.set(key, true, true); await flush();
    expect(client.updates().at(-1)).toMatchObject({ active: false, dirty: true, playing: true });
    client.protection.detach(key); await flush();
    expect(client.updates().at(-1)).toMatchObject({ dirty: true, playing: false });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    client.protection.set(key, false); await flush();
    expect(client.updates().at(-1).dirty).toBe(false);
  });
  it("serializes clean/dirty reports and retries after a disconnect without clearing drafts", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const bodies: Array<{ dirty: boolean; sequence: number }> = [];
    let fail = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ enabled: true }));
      bodies.push(JSON.parse(String(init.body)));
      if (fail) throw new Error("offline");
      if (bodies.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      return new Response("{}");
    });
    const protection = new RuntimeProtection();
    cleanups.push(startRuntimeActivity({ fetchImpl, protection })); await flush();
    protection.set(Symbol(), true); await flush();
    expect(bodies).toHaveLength(1);
    finish?.(); await flush();
    expect(bodies.map(body => body.dirty)).toEqual([false, true]);
    fail = true; await vi.advanceTimersByTimeAsync(25_000);
    expect(protection.read().dirty).toBe(true);
    fail = false; await vi.advanceTimersByTimeAsync(25_000);
    expect(bodies.at(-1)?.dirty).toBe(true);
    expect(bodies.at(-1)!.sequence).toBeGreaterThan(bodies[0].sequence);
  });
  it("releases only clean non-BFCache pages and uses increasing sequence", async () => {
    const client = setup(); await flush();
    const hidden = new Event("pagehide");
    Object.defineProperty(hidden, "persisted", { value: true });
    window.dispatchEvent(hidden);
    expect(JSON.parse(String(client.beacon.mock.calls.at(-1)?.[1]))).toMatchObject({ active: false, dirty: false });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); await flush();
    const sequence = client.updates().at(-1).sequence;
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(JSON.parse(String(client.beacon.mock.calls.at(-1)?.[1]))).toEqual({ sessionId: "test-tab", sequence: sequence + 1, release: true });
  });
  it("does not release dirty state on pagehide", async () => {
    const client = setup(); await flush();
    client.protection.set(Symbol(), true); await flush();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(JSON.parse(String(client.beacon.mock.calls.at(-1)?.[1]))).toMatchObject({ active: false, dirty: true });
  });
  it("independent documents never reuse a lease", async () => {
    const a = setup("tab-a"); const b = setup("tab-b"); await flush();
    expect(a.updates().at(-1).sessionId).toBe("tab-a");
    expect(b.updates().at(-1).sessionId).toBe("tab-b");
  });
  it("stops probing legacy runtimes after one 404, and removes listeners/timers", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const stop = startRuntimeActivity({ fetchImpl }); cleanups.push(stop); await flush();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
