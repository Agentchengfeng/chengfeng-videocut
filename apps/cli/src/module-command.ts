import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { request } from "node:http";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { checkResources, validateModuleManifest } from "./server/module-api";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./output";
import type { ParsedArgs } from "./args";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Manifest = ReturnType<typeof validateModuleManifest>;
type Identity = { product: string; productVersion: string; pid: number; studioBuildId: string };
export class ModuleCommandError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
const fail = (code: string, message: string, details: Record<string, unknown> = {}): never => { throw new ModuleCommandError(code, message, details); };

export function moduleOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("invalid_argument", "Invalid --api-base"); }
  // Reject alternate IP spellings and paths before URL normalization.
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(raw) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "http:") {
    fail("invalid_argument", "--api-base requires an HTTP 127.0.0.1 or [::1] origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export async function ordinaryFile(path: string, limit: number): Promise<Buffer> {
  let current = parse(path).root;
  const parts = path.slice(current.length).split(sep);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw Error("Candidate must use ordinary files and directories, not symlinks");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw Error("Candidate file exceeds size limit");
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length > limit || before.size !== length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(path) !== path) throw Error("Candidate changed while reading or exceeds limit");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function readModuleCandidate(file: string, cwd: string) {
  try {
    const path = resolve(cwd, file), root = dirname(path);
    const manifest = validateModuleManifest(JSON.parse((await ordinaryFile(path, 65536)).toString("utf8")));
    const files: Record<string, string> = {};
    for (const item of manifest.files) {
      const target = resolve(root, item.path), rel = relative(root, target);
      if (rel.startsWith("..") || rel.startsWith(sep)) throw Error("Candidate escapes package directory");
      const bytes = await ordinaryFile(target, 512 * 1024);
      if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw Error("Module hash or byte count mismatch");
      checkResources(item.path, bytes, manifest);
      files[item.path] = bytes.toString("base64");
    }
    return { manifest, files };
  } catch (error) { return fail("module_candidate_invalid", error instanceof Error ? error.message : "Invalid candidate", { stage: "candidate", submitted: false }); }
}

// Native HTTP ignores proxy environment variables, does not follow redirects, and never retries.
async function jsonRequest(url: string, body?: unknown): Promise<any> {
  return new Promise((resolveResponse, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(url, { method: bytes ? "POST" : "GET", headers: { "Cache-Control": "no-store", ...(bytes ? { "Content-Type": "application/json", "Content-Length": bytes.length } : {}) } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128 * 1024) req.destroy(new ModuleCommandError("module_response_invalid", "Response exceeds limit"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) return reject(new ModuleCommandError("module_redirect_rejected", "Redirect rejected", { httpStatus: status }));
        let value: any;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(new ModuleCommandError("module_response_invalid", "Invalid JSON response", { httpStatus: status })); }
        if (status < 200 || status >= 300) return reject(new ModuleCommandError("module_http_error", "Module service rejected request", { httpStatus: status, serviceCode: value?.error?.code, immutableConflict: status === 409 && value?.error?.code === "module_conflict" && value?.error?.message === "Module version conflict" }));
        resolveResponse(value);
      });
    });
    const timer = setTimeout(() => req.destroy(new ModuleCommandError("module_service_unavailable", "Module request timed out")), 10000);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(bytes);
  });
}

async function identity(origin: string, expected?: Identity): Promise<Identity> {
  const h = await jsonRequest(origin + "/api/health");
  if (h?.ok !== true || h.product !== PRODUCT_NAME || h.productVersion !== PRODUCT_VERSION || !Number.isSafeInteger(h.pid) || h.pid <= 0 || typeof h.studioBuildId !== "string" || !h.studioBuildId.trim()) fail("module_source_mismatch", "Health product/version/PID/build identity is incompatible");
  if (h.modulePublishApiVersion !== 1) fail("module_capability_missing", "Service requires modulePublishApiVersion=1");
  const actual = { product: h.product, productVersion: h.productVersion, pid: h.pid, studioBuildId: h.studioBuildId };
  if (expected && JSON.stringify(actual) !== JSON.stringify(expected)) fail("module_source_changed", "Service identity changed; reconnect before any further action");
  return actual;
}

function receipt(raw: any, project: string, moduleId: string, version: string, expected?: Manifest) {
  const manifest = validateModuleManifest(raw?.manifest);
  const entryPath = `modules/published/${moduleId}/${version}/${manifest.entry}`;
  if (raw?.schemaVersion !== 1 || raw.projectId !== project || manifest.moduleId !== moduleId || manifest.version !== version || raw.entryPath !== entryPath || raw.digest !== hash(JSON.stringify(manifest)) || (expected && JSON.stringify(manifest) !== JSON.stringify(expected))) fail("module_readback_mismatch", "Module receipt does not match requested identity/manifest/digest");
  return { schemaVersion: 1, projectId: project, manifest, digest: raw.digest, entryPath };
}

export async function runModuleCommand(args: ParsedArgs, cwd: string) {
  const origin = moduleOrigin(args.apiBase!), project = args.project!;
  const endpoint = origin + `/api/v1/projects/${encodeURIComponent(project)}/module-packages`;
  let submitted = false, stage = "confirmation";
  let source: Identity | undefined;
  let moduleId = args.moduleId, version = args.moduleVersion;
  try {
    if (args.command === "module.publish" && !args.confirmed && !args.dryRun) fail("confirmation_required", "module publish requires existing user authorization via --confirmed (or use --dry-run)");
    stage = "candidate";
    const candidate = args.command === "module.publish" ? await readModuleCandidate(args.file!, cwd) : undefined;
    moduleId = candidate?.manifest.moduleId ?? moduleId; version = candidate?.manifest.version ?? version;
    stage = "health"; source = await identity(origin);
    if (args.dryRun) return { dryRun: true, submitted: false, candidateVerified: true, manifest: candidate!.manifest, digest: hash(JSON.stringify(candidate!.manifest)), source };
    if (candidate) {
      stage = "pre-submit"; await identity(origin, source);
      stage = "submit"; submitted = true;
      receipt(await jsonRequest(endpoint, candidate), project, moduleId!, version!, candidate.manifest);
    }
    stage = "pre-readback"; await identity(origin, source);
    stage = "readback";
    const result = receipt(await jsonRequest(`${endpoint}/${moduleId}/${version}`), project, moduleId!, version!, candidate?.manifest);
    stage = "post-readback"; await identity(origin, source);
    return { ...result, source, readBackVerified: true };
  } catch (error) {
    const e = error instanceof ModuleCommandError ? error : new ModuleCommandError("module_request_failed", error instanceof Error ? error.message : "Module request failed");
    // Only this exact handler branch is known to run before commit. Generic 400/409 may be post-commit integrity failures.
    const rejected = submitted && stage === "submit" && e.code === "module_http_error" && e.details.immutableConflict === true;
    if (rejected) fail("module_conflict", "Module version conflict; existing version must not be overwritten", {
      ...e.details, stage, submitted: "rejected", projectId: project, moduleId, version, source,
    });
    // An error may follow a commit. Never infer non-submission once POST starts.
    fail(submitted ? "module_publish_result_unknown" : e.code, submitted ? "Publication result unknown; do not retry or change version. Use module get for the same project/module/version and verify service identity." : e.message,
      { ...e.details, stage, submitted: submitted ? "unknown" : false, causeCode: e.code, projectId: project, moduleId, version, ...(source ? { source } : {}) });
  }
}
