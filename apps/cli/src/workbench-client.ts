import { request } from "node:http";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./output";
import { moduleOrigin } from "./module-command";

export class WorkbenchError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
export function workbenchFail(code: string, message: string, details: Record<string, unknown> = {}): never { throw new WorkbenchError(code, message, details); }
export const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
export function sanitized(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[bounded]";
  if (typeof value === "string") return value.slice(0, 4096).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
  if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitized(v, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, /secret|password|authorization|credential|api.?key|private.?key|access.?token|refresh.?token/i.test(k) ? "[redacted]" : sanitized(v, depth + 1)]));
  return value;
}
export interface WorkbenchSource { product: string; productVersion: string; pid: number; studioBuildId: string; runtimeMode?: string }
export interface WorkbenchResponse { status: number; data: Record<string, any> }

// Fixed routes are supplied by workbench-command, not callers. Native HTTP deliberately bypasses proxy env.
export class WorkbenchClient {
  readonly origin: string;
  source?: WorkbenchSource;
  constructor(origin: string) { this.origin = moduleOrigin(origin); }
  async request(path: string, method = "GET", body?: unknown): Promise<WorkbenchResponse> {
    if (!path.startsWith("/api/") || path.startsWith("//")) workbenchFail("invalid_argument", "Invalid internal route");
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (raw && raw.length > 12 * 1024 * 1024) workbenchFail("invalid_argument", "Request exceeds 12 MiB transfer bound");
    return new Promise((resolveResponse, reject) => {
      const req = request(this.origin + path, { method, headers: { "Cache-Control": "no-store", ...(raw ? { "Content-Type": "application/json", "Content-Length": raw.length } : {}) } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) req.destroy(new WorkbenchError("workbench_response_invalid", "Response exceeds 8 MiB bound"));
          else chunks.push(chunk);
        });
        res.on("error", () => reject(new WorkbenchError("workbench_transport_error", "Response interrupted")));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) return reject(new WorkbenchError("workbench_redirect_rejected", "Redirect rejected", { httpStatus: status }));
          let data: unknown;
          try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(new WorkbenchError("workbench_response_invalid", "Response is not JSON", { httpStatus: status })); }
          if (!object(data)) return reject(new WorkbenchError("workbench_response_invalid", "Response must be an object", { httpStatus: status }));
          if (status < 200 || status >= 300 || object(data.error)) {
            const error = object(data.error) ? data.error : {};
            const code = typeof error.code === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code) ? error.code : "workbench_http_error";
            return reject(new WorkbenchError(code, "Workbench service rejected the request", { httpStatus: status, serviceError: sanitized(error) }));
          }
          resolveResponse({ status, data });
        });
      });
      const timer = setTimeout(() => req.destroy(new WorkbenchError("workbench_timeout", "Workbench request timed out")), 20000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", e => reject(e instanceof WorkbenchError ? e : new WorkbenchError("workbench_transport_error", "Workbench transport failed")));
      req.end(raw);
    });
  }
  async health(capability = ""): Promise<Record<string, any>> {
    const { data: h } = await this.request("/api/health");
    if (h.ok !== true || h.product !== PRODUCT_NAME || h.productVersion !== PRODUCT_VERSION || !Number.isSafeInteger(h.pid) || h.pid <= 0 || typeof h.studioBuildId !== "string" || !h.studioBuildId.trim()) workbenchFail("workbench_source_mismatch", "Incompatible product/version/PID/build");
    const source: WorkbenchSource = { product: h.product, productVersion: h.productVersion, pid: h.pid, studioBuildId: h.studioBuildId, ...(typeof h.runtimeMode === "string" ? { runtimeMode: h.runtimeMode } : {}) };
    if (this.source && JSON.stringify(source) !== JSON.stringify(this.source)) workbenchFail("workbench_source_changed", "Workbench identity changed; reconnect and review before continuing");
    if (capability && capability.split(".").reduce<any>((v, k) => v?.[k], h) !== 1) workbenchFail("workbench_capability_missing", `Required service capability ${capability}=1 is unavailable`, { capability });
    this.source = source;
    return h;
  }
}
