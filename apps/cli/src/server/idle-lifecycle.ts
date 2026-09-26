import { isLoopbackAddress, trustedLoopbackOrigin } from "./jobs-api";

type Lease = { sessionId: string; active: boolean; playing: boolean; dirty: boolean; expiresAt: number };
/** Owns admission and the last idle check together: a request crossing the
 * asynchronous owner probe invalidates it before shutdown can be committed. */
export class IdleLifecycle {
  private leases = new Map<string, Lease>();
  private sequences = new Map<string, { value: number; expiresAt: number }>();
  private requests = 0;
  private admissionEpoch = 0;
  private idleSince: number;
  private checking = false;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private waiters: Array<() => void> = [];
  private blockers: string[] = [];
  constructor(readonly timeoutSeconds: number, private readonly busy: () => Promise<string[]>,
    private readonly onIdle: () => Promise<void>, private readonly now = Date.now) {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("idle timeout must be non-negative");
    this.idleSince = now();
  }
  start() {
    if (this.timeoutSeconds && !this.timer) {
      this.timer = setInterval(() => { void this.check(); }, Math.min(1000, Math.max(10, this.timeoutSeconds * 250)));
      this.timer.unref();
    }
  }
  stopAdmission() { this.stopping = true; if (this.timer) clearInterval(this.timer); }
  async drain() { if (this.requests) await new Promise<void>(resolve => this.waiters.push(resolve)); }
  admit(activity: boolean): (() => void) | null {
    if (this.stopping) return null;
    this.admissionEpoch++;
    this.requests++;
    if (activity) this.idleSince = this.now();
    let done = false;
    return () => {
      if (done) return; done = true;
      this.requests--;
      if (activity) this.idleSince = this.now();
      if (!this.requests) this.waiters.splice(0).forEach(resolve => resolve());
    };
  }
  private expire() {
    for (const [id, lease] of this.leases) if (!lease.dirty && !lease.playing && lease.expiresAt <= this.now()) this.leases.delete(id);
    for (const [id, record] of this.sequences) if (!this.leases.has(id) && record.expiresAt <= this.now()) this.sequences.delete(id);
  }
  status() {
    this.expire();
    return { schemaVersion: 1, enabled: this.timeoutSeconds > 0, timeoutSeconds: this.timeoutSeconds,
      stopping: this.stopping, idleSince: this.idleSince, blockers: this.blockers,
      inFlightRequests: this.requests, sessions: [...this.leases.values()].map(lease => ({ ...lease,
        staleDirty: lease.dirty && lease.expiresAt <= this.now(),
        stalePlaying: lease.playing && lease.expiresAt <= this.now() })) };
  }
  async check() {
    if (!this.timeoutSeconds || this.stopping || this.checking) return;
    this.expire();
    const clients = [...this.leases.values()].some(lease => lease.active || lease.playing || lease.dirty);
    if (this.requests || clients) { if (clients) this.idleSince = this.now(); this.blockers = [this.requests ? "requests" : "clients"]; return; }
    // Probe every tick so time spent doing detached work never counts as idle.
    this.checking = true;
    const epoch = this.admissionEpoch;
    try {
      try { this.blockers = await this.busy(); } catch { this.blockers = ["busy_unknown"]; }
      if (this.blockers.length) { this.idleSince = this.now(); return; }
      // An admitted handler may have created work while the probe awaited I/O.
      // Retry next tick; never transiently reject a healthy runtime's requests.
      if (this.requests || epoch !== this.admissionEpoch || this.stopping) return;
      if (this.now() - this.idleSince < this.timeoutSeconds * 1000) return;
      this.stopAdmission();
      await this.onIdle();
    } finally { this.checking = false; }
  }
  async activity(request: Request, port: number, client?: string): Promise<Response> {
    const origin = trustedLoopbackOrigin(request.headers.get("host"), port);
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    if (!client || !isLoopbackAddress(client) || !origin || new URL(request.url).origin !== origin ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin)) return json({ error: { code: "origin_forbidden" } }, 403);
    if (request.method === "GET") return json(this.status());
    if (!["POST", "DELETE"].includes(request.method)) return json({ error: { code: "method_not_allowed" } }, 405);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: { code: "invalid_activity" } }, 400);
    let bytes = 0, timedOut = false;
    const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 5000);
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > 4096) { await reader.cancel(); return json({ error: { code: "request_too_large" } }, 413); }
        chunks.push(part.value);
      }
      if (timedOut) return json({ error: { code: "request_timeout" } }, 408);
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.sessionId)) throw new Error("invalid");
      this.expire();
      if (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || value.sequence < 0)) throw new Error("invalid");
      const previous = this.sequences.get(value.sessionId);
      if (previous && (value.sequence === undefined || value.sequence <= previous.value)) return json(this.status());
      const releasing = request.method === "DELETE" || value.release === true;
      if (!releasing && [value.active, value.playing, value.dirty].some(flag => typeof flag !== "boolean")) throw new Error("invalid");
      if (!releasing && !this.leases.has(value.sessionId) && this.leases.size >= 128) return json({ error: { code: "session_limit" } }, 429);
      if (value.sequence !== undefined) {
        if (!previous && this.sequences.size >= 512) return json({ error: { code: "session_limit" } }, 429);
        this.sequences.set(value.sessionId, { value: value.sequence, expiresAt: this.now() + 90_000 });
      }
      if (releasing) this.leases.delete(value.sessionId);
      else {
        this.leases.set(value.sessionId, { sessionId: value.sessionId, active: value.active, playing: value.playing, dirty: value.dirty, expiresAt: this.now() + 90_000 });
        if (value.active || value.playing || value.dirty) this.idleSince = this.now();
      }
      return json(this.status());
    } catch { return json({ error: { code: "invalid_activity" } }, 400); }
    finally { clearTimeout(timer); reader.releaseLock(); }
  }
}
