import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VideocutError, asVideocutError, parseCanvasAspect, parseCanvasBackground, parseNarrationGainDb } from "@video-workbench/core";
import { atomicWriteJson, resolveProject, serializeProjectOperation } from "@video-workbench/core/node";
import { isLoopbackAddress, trustedLoopbackOrigin } from "./jobs-api";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function invalid(message: string): never { throw new VideocutError("invalid_project_config", message); }
interface Options {
  projectsDir: string;
  port: number;
  isBusy: (directory: string) => Promise<boolean>;
  onChanged?: (change: { projectId: string; path: string; revision: string }) => void | Promise<void>;
}
async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") invalid("application/json required");
  if (!request.body || Number(request.headers.get("content-length")) > 4096) invalid("Request body must be at most 4096 bytes");
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length;
      if (size > 4096) { await reader.cancel(); invalid("Request too large"); } parts.push(r.value); }
    if (expired) invalid("Request body timed out");
    const b: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!record(b) || Object.keys(b).some(k => !["confirmed", "expectedRevision", "config"].includes(k)) ||
        b.confirmed !== true || typeof b.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(b.expectedRevision) ||
        !record(b.config) || Object.keys(b.config).length < 1 ||
        Object.keys(b.config).some(k => !["aspectRatio", "canvasBackground", "narrationGainDb"].includes(k)) ||
        (b.config.aspectRatio !== undefined && !parseCanvasAspect(b.config.aspectRatio)) ||
        (b.config.canvasBackground !== undefined && !parseCanvasBackground(b.config.canvasBackground)) ||
        (b.config.narrationGainDb !== undefined && parseNarrationGainDb(b.config.narrationGainDb) === null))
      invalid("Only confirmed aspectRatio, canvasBackground (#RRGGBB) and/or narrationGainDb (-12…24 dB) with current project expectedRevision are allowed");
    const patch: { aspectRatio?: string; canvasBackground?: string; narrationGainDb?: number } = {};
    if (b.config.aspectRatio !== undefined) patch.aspectRatio = String(b.config.aspectRatio).trim().replace("：", ":");
    if (b.config.canvasBackground !== undefined) patch.canvasBackground = parseCanvasBackground(b.config.canvasBackground)!;
    if (b.config.narrationGainDb !== undefined) patch.narrationGainDb = parseNarrationGainDb(b.config.narrationGainDb)!;
    return { expectedRevision: b.expectedRevision, patch };
  } finally { clearTimeout(timer); }
}
async function snapshot(directory: string, projectId: string) {
  const file = join(directory, "project.json"), info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) invalid("Project document must be a bounded regular file");
  const raw = await readFile(file, "utf8"), document: unknown = JSON.parse(raw);
  if (!record(document) || (document.config !== undefined && !record(document.config))) invalid("Invalid project configuration");
  const config = record(document.config) ? document.config : {};
  return { raw, document, file, config, result: { schemaVersion: 1, projectId,
    projectRevision: sha(raw), configRevision: sha(JSON.stringify(config)),
    config: { aspectRatio: typeof config.aspectRatio === "string" ? config.aspectRatio : null,
      canvasBackground: parseCanvasBackground(config.canvasBackground),
      narrationGainDb: parseNarrationGainDb(config.narrationGainDb) ?? 0 } } };
}
async function backup(directory: string, revision: string, raw: string) {
  let dir = await realpath(directory);
  for (const name of [".chengfeng-videocut", "project-config-history"]) {
    dir = join(dir, name); await mkdir(dir).catch(e => { if (e.code !== "EEXIST") throw e; });
    const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) invalid("Unsafe config history directory");
  }
  const file = join(dir, revision + ".json");
  try { await writeFile(file, raw, { flag: "wx", mode: 0o600 }); }
  catch (e: any) { if (e.code !== "EEXIST") throw e;
    const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || await readFile(file, "utf8") !== raw) invalid("Config history identity mismatch"); }
}
export function createProjectConfigApi(options: Options) {
  return async (request: Request, client?: string): Promise<Response | null> => {
    const url = new URL(request.url), match = /^\/api\/v1\/projects\/([^/]+)\/project-config$/.exec(url.pathname);
    if (!match) return null;
    const origin = trustedLoopbackOrigin(request.headers.get("host"), options.port);
    if (!client || !isLoopbackAddress(client) || !origin || url.origin !== origin ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin))
      return Response.json({ error: { code: "origin_forbidden" } }, { status: 403 });
    if (!["GET", "PATCH"].includes(request.method)) return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
    try {
      const id = decodeURIComponent(match[1]!); if (!id || id === "." || id === ".." || /[\\/\0]/.test(id)) invalid("Invalid project id");
      const body = request.method === "PATCH" ? await readBody(request) : null;
      const initial = await lstat(resolve(options.projectsDir, id, "project.json"));
      if (initial.isSymbolicLink() || !initial.isFile() || initial.size > 1024 * 1024) invalid("Project document must be a bounded regular file");
      const project = await resolveProject(resolve(options.projectsDir, id));
      const result = await serializeProjectOperation(project.directory, async () => {
        const before = await snapshot(project.directory, id);
        if (!body) return before.result;
        if (body.expectedRevision !== before.result.projectRevision) throw new VideocutError("revision_conflict", "Project changed; read config before proposing a new edit");
        if (await options.isBusy(project.directory) || ["cutting", "rendering", "running", "queued", "transcribing", "processing"].includes(String(before.document.status)))
          throw new VideocutError("project_busy", "Wait for the current project job before changing canvas");
        if (Object.entries(body.patch).every(([k, v]) => before.config[k] === v)) return { ...before.result, changed: false, previousRevision: before.result.projectRevision };
        await backup(project.directory, before.result.projectRevision, before.raw);
        const revision = await atomicWriteJson(before.file, { ...before.document, config: { ...before.config, ...body.patch } });
        const after = await snapshot(project.directory, id);
        if (after.result.projectRevision !== revision || Object.entries(body.patch).some(([k, v]) => (after.result.config as Record<string, unknown>)[k] !== v)) throw new VideocutError("readback_mismatch", "Config write needs readback investigation");
        let notificationWarning: string | undefined;
        try { await options.onChanged?.({ projectId: id, path: "project.json", revision }); }
        catch { notificationWarning = "committed_but_refresh_required"; }
        return { ...after.result, changed: true, previousRevision: before.result.projectRevision, ...(notificationWarning ? { notificationWarning } : {}) };
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const e = asVideocutError(error);
      return Response.json({ error: { code: e.code, message: e.message } }, { status: ["revision_conflict", "project_busy", "project_locked"].includes(e.code) ? 409 : e.code === "project_not_found" ? 404 : 400 });
    }
  };
}
