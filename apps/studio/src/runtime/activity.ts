/** One lease per document, never localStorage (two tabs must not share a lease). */
export class RuntimeProtection {
  private flags = new Map<symbol, { dirty: boolean; playing: boolean }>();
  private guards = new Set<symbol>();
  private listeners = new Set<() => void>();
  read() {
    return {
      dirty: this.hasUnsaved() || this.guards.size > 0,
      playing: [...this.flags.values()].some(value => value.playing),
    };
  }
  hasUnsaved() { return [...this.flags.values()].some(value => value.dirty); }
  /** Unknown editor coverage is a safety blocker, not an assertion of unsaved work. */
  guard(key: symbol) {
    this.guards.add(key);
    this.listeners.forEach(listener => listener());
  }
  set(key: symbol, dirty: boolean, playing = false) {
    const old = this.flags.get(key);
    if (old?.dirty === dirty && old?.playing === playing) return;
    if (!dirty && !playing) this.flags.delete(key);
    else this.flags.set(key, { dirty, playing });
    this.listeners.forEach(listener => listener());
  }
  /** Unmount is not evidence that an unsaved draft reached disk. */
  detach(key: symbol) { this.set(key, this.flags.get(key)?.dirty ?? false, false); }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const runtimeProtection = new RuntimeProtection();
let activityEnabled = false;
const capabilityListeners = new Set<() => void>();
export const runtimeActivityCapability = {
  getSnapshot: () => activityEnabled,
  subscribe: (listener: () => void) => {
    capabilityListeners.add(listener);
    return () => { capabilityListeners.delete(listener); };
  },
};

export function startRuntimeActivity({
  protection = runtimeProtection,
  fetchImpl = window.fetch.bind(window),
  sessionId = crypto.randomUUID(),
}: {
  protection?: RuntimeProtection;
  fetchImpl?: typeof fetch;
  sessionId?: string;
} = {}) {
  const endpoint = "/api/runtime/activity";
  let supported: boolean | null = null;
  let stopped = false;
  let suspended = false;
  let pending = false;
  let inFlight = false;
  let sequence = 0;
  const payload = () => ({ sessionId, sequence: ++sequence,
    active: !suspended && document.visibilityState === "visible", ...protection.read() });
  // Serialize writes so an older clean acknowledgement cannot clear a newer draft.
  const send = async () => {
    pending = true;
    if (stopped || supported !== true || inFlight || suspended) return;
    inFlight = true;
    try {
      while (pending && !stopped && !suspended) {
        pending = false;
        const response = await fetchImpl(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()), keepalive: true });
        if (response.status === 404) { supported = false; break; }
        if (!response.ok) break;
      }
    } catch { /* Offline: preserve all local draft protection; next heartbeat retries. */ }
    finally { inFlight = false; }
  };
  const tick = async () => {
    if (stopped || suspended || supported === false) return;
    if (supported === null) {
      try {
        const response = await fetchImpl(endpoint, { headers: { Accept: "application/json" } });
        if (stopped) return;
        if (response.status === 404) { supported = false; return; }
        if (!response.ok) return;
        const status = await response.json();
        // A static dev-server fallback is not the runtime capability.
        if (typeof status.enabled !== "boolean") { supported = false; return; }
        activityEnabled = status.enabled;
        capabilityListeners.forEach(listener => listener());
        if (!status.enabled) { supported = false; return; }
        supported = true;
      } catch { return; }
    }
    await send();
  };
  const changed = () => { void send(); };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (supported !== true || !protection.hasUnsaved()) return;
    event.preventDefault(); event.returnValue = "";
  };
  const pageHide = (event: PageTransitionEvent) => {
    suspended = true;
    if (supported !== true) return;
    // A BFCache page can return with the exact same drafts: never release it.
    const flags = protection.read();
    const body = flags.dirty || event.persisted
      ? { ...payload(), active: false }
      : { sessionId, sequence: ++sequence, release: true };
    navigator.sendBeacon?.(endpoint, JSON.stringify(body));
  };
  const pageShow = () => { suspended = false; void tick(); };
  const unsubscribe = protection.subscribe(changed);
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  const timer = window.setInterval(() => { void tick(); }, 25_000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer); unsubscribe();
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
  };
}
