import type { JobKind } from "@video-workbench/contracts";
import { JobManager } from "../jobs/manager";
import { JobStoreError } from "../jobs/store";
import { publicJob } from "../jobs/public";

const MAX_JOB_REQUEST_BYTES = 1 << 20;

function responseError(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function statusFor(code: string): number {
  if (code === "job_not_found") return 404;
  if (code === "project_not_found") return 404;
  if (code === "job_target_conflict" || code === "job_not_cancellable" || code === "job_state_conflict" || code === "job_output_exists") return 409;
  if (code === "job_store_corrupt" || code === "job_registry_busy") return 503;
  if (code === "unsupported_media_type") return 415;
  if (code === "request_too_large") return 413;
  if (code === "unsupported_job_kind" || code === "invalid_argument" || code === "invalid_job_id" || code === "invalid_json") return 400;
  return 500;
}

function asError(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof JobStoreError) return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "internal_error",
      message: typeof value.message === "string" ? value.message : "Request failed",
      ...(value.details && typeof value.details === "object" && !Array.isArray(value.details)
        ? { details: value.details as Record<string, unknown> } : {}),
    };
  }
  return { code: "internal_error", message: "Request failed" };
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  return normalized === "::1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new JobStoreError("unsupported_media_type", "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JOB_REQUEST_BYTES) {
    throw new JobStoreError("request_too_large", "Request body exceeds the 1 MiB limit");
  }
  if (!request.body) throw new JobStoreError("invalid_json", "Request body must be valid JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JOB_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new JobStoreError("request_too_large", "Request body exceeds the 1 MiB limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new JobStoreError("invalid_json", "Request body must be valid UTF-8 JSON");
  }
}

export function createJobsApi(manager: JobManager) {
  return async (request: Request, clientAddress?: string): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/v1/jobs" && !url.pathname.startsWith("/api/v1/jobs/")) return null;
    if (clientAddress && !isLoopbackAddress(clientAddress)) {
      return responseError(403, "local_only", "Durable job API accepts loopback clients only");
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) {
      return responseError(403, "origin_forbidden", "Cross-origin durable job requests are forbidden");
    }
    try {
      if (url.pathname === "/api/v1/jobs") {
        if (request.method === "POST") {
          let body: unknown;
          try { body = await readJsonBody(request); }
          catch (error) {
            const normalized = asError(error);
            return responseError(statusFor(normalized.code), normalized.code, normalized.message, normalized.details);
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return responseError(400, "invalid_argument", "Request body must be an object");
          }
          const record = body as Record<string, unknown>;
          if (typeof record.kind !== "string" || typeof record.target !== "string") {
            return responseError(400, "invalid_argument", "kind and target are required");
          }
          const params = record.params;
          if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) {
            return responseError(400, "invalid_argument", "params must be an object");
          }
          const job = await manager.start({
            kind: record.kind as JobKind,
            target: record.target,
            params: params as Record<string, unknown> | undefined,
          });
          return Response.json(publicJob(job), { status: 202, headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "GET") {
          const rawLimit = url.searchParams.get("limit");
          const limit = rawLimit === null ? 100 : Number(rawLimit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            return responseError(400, "invalid_argument", "limit must be an integer from 1 to 100");
          }
          const jobs = await manager.list({
            projectId: url.searchParams.get("projectId") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            limit,
          });
          return Response.json({ schemaVersion: 1, jobs: jobs.map(publicJob) }, { headers: { "Cache-Control": "no-store" } });
        }
        return responseError(405, "method_not_allowed", "Method not allowed", { allow: "GET, POST" });
      }

      const suffix = url.pathname.slice("/api/v1/jobs/".length);
      const cancel = suffix.endsWith("/cancel");
      const encodedId = cancel ? suffix.slice(0, -"/cancel".length) : suffix;
      let jobId: string;
      try { jobId = decodeURIComponent(encodedId); }
      catch { return responseError(400, "invalid_job_id", "Invalid job id"); }
      if (!jobId || jobId.includes("/")) return responseError(400, "invalid_job_id", "Invalid job id");
      if (cancel) {
        if (request.method !== "POST") return responseError(405, "method_not_allowed", "Method not allowed", { allow: "POST" });
        return Response.json(publicJob(await manager.cancel(jobId)), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method !== "GET") return responseError(405, "method_not_allowed", "Method not allowed", { allow: "GET" });
      const job = await manager.read(jobId);
      return job
        ? Response.json(publicJob(job), { headers: { "Cache-Control": "no-store" } })
        : responseError(404, "job_not_found", "Job not found", { jobId });
    } catch (error) {
      const normalized = asError(error);
      return responseError(statusFor(normalized.code), normalized.code, normalized.message, normalized.details);
    }
  };
}
