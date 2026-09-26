import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { mediaInvalid, mediaSha256, regularMediaPath, readMediaAsset, resolveProject, serializeProjectOperation, type MediaAsset } from "@video-workbench/core/node";
import { probeMedia } from "@video-workbench/koubo-adapter";
import { isLoopbackAddress, trustedLoopbackOrigin } from "./jobs-api";
import { parseMediaRange } from "./project-media";

async function jsonBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) mediaInvalid("Body required");
  let size = 0; const parts: Uint8Array[] = [];
  const timer = setTimeout(() => { void reader.cancel(); }, 5000);
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length;
      if (size > 16384) { await reader.cancel(); mediaInvalid("Request too large"); } parts.push(r.value); }
    return JSON.parse(Buffer.concat(parts).toString());
  } finally { clearTimeout(timer); }
}
async function mediaParent(root: string) {
  let current = await realpath(root);
  for (const name of [".chengfeng-videocut", "media"]) {
    current = resolve(current, name);
    await mkdir(current).catch(e => { if (e.code !== "EEXIST") throw e; });
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) mediaInvalid("Media parent is not a real directory");
  }
  return current;
}
export function createMediaAssetsApi(projectsDir: string, port: number) {
  return async (request: Request, client?: string): Promise<Response | null> => {
    const url = new URL(request.url);
    const m = /^\/api\/v1\/projects\/([^/]+)\/media-assets(?:\/([a-f0-9]{64})(\/content)?)?$/.exec(url.pathname);
    if (!m) return null;
    const origin = trustedLoopbackOrigin(request.headers.get("host"), port);
    if (!client || !isLoopbackAddress(client) || !origin || url.origin !== origin ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin))
      return Response.json({ error: { code: "origin_forbidden" } }, { status: 403 });
    try {
      const id = decodeURIComponent(m[1]!);
      if (!id || /[\\/\0]/.test(id) || id === "." || id === "..") mediaInvalid("Invalid project id");
      const project = await resolveProject(resolve(projectsDir, id));
      let assetId = m[2];
      let created = false;
      if (!assetId && request.method === "POST") {
        const b = await jsonBody(request);
        if (b?.confirmed !== true || typeof b.sourcePath !== "string" || extname(b.sourcePath).toLowerCase() !== ".mp4" ||
          typeof b.expectedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.expectedSourceSha256)) mediaInvalid("Confirmed local MP4 and SHA256 required");
        assetId = b.expectedSourceSha256;
        await serializeProjectOperation(project.directory, async () => {
          const source = await regularMediaPath(b.sourcePath);
          if (await mediaSha256(source, assetId) !== assetId) mediaInvalid("Source hash mismatch");
          const parent = await mediaParent(project.directory);
          const target = resolve(parent, assetId!);
          let exists = false;
          try { await lstat(target); exists = true; } catch (e: any) { if (e.code !== "ENOENT") throw e; }
          if (exists) { await readMediaAsset(project.directory, assetId!); return; }
          const staging = await mkdtemp(resolve(parent, ".import-"));
          try {
            const dest = resolve(staging, "source.mp4");
            await copyFile(source, dest, constants.COPYFILE_EXCL);
            await regularMediaPath(source);
            if (await mediaSha256(dest, assetId) !== assetId || await mediaSha256(source, assetId) !== assetId) mediaInvalid("Media changed during import");
            const p = await probeMedia(dest);
            // Audio/container tails must never extend the usable video range.
            const duration = Math.min(p.duration, p.videoDuration ?? 0);
            if (!p.hasVideo || p.videoCodec !== "h264" || p.pixelFormat !== "yuv420p" || !(duration > 0 && duration <= 3600) ||
              !(p.width > 0 && p.width <= 8192 && p.height > 0 && p.height <= 8192) || !(p.frameRate! > 0 && p.frameRate! <= 120))
              mediaInvalid("MP4 must contain H264/yuv420p video with valid duration, dimensions and frame rate");
            const manifest: MediaAsset = { schemaVersion: 1, assetId: assetId!, sha256: assetId!, bytes: (await lstat(dest)).size,
              duration, width: p.width, height: p.height, frameRate: p.frameRate!, codec: "h264", hasAudio: p.hasAudio };
            await writeFile(resolve(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
            await rename(staging, target); created = true;
          } finally { await rm(staging, { recursive: true, force: true }); }
        });
      } else if (!assetId || !["GET", "HEAD"].includes(request.method)) {
        return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
      }
      const { manifest, path } = await readMediaAsset(project.directory, assetId!);
      if (m[3]) {
        const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ETag: `"${assetId}"` };
        const value = request.headers.get("range");
        const range = value ? parseMediaRange(value, manifest.bytes) : null;
        if (value && !range) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${manifest.bytes}` } });
        headers["Content-Length"] = String(range ? range.end - range.start + 1 : manifest.bytes);
        if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${manifest.bytes}`;
        const file = Bun.file(path);
        return new Response(request.method === "HEAD" ? null : range ? file.slice(range.start, range.end + 1) : file, { status: range ? 206 : 200, headers });
      }
      return Response.json({ schemaVersion: 1, projectId: id, created, manifest,
        contentUrl: `${origin}/api/v1/projects/${encodeURIComponent(id)}/media-assets/${assetId}/content` }, { headers: { "Cache-Control": "no-store" } });
    } catch (e: any) {
      return Response.json({ error: { code: "media_asset_invalid", message: e.message } }, { status: e.code === "ENOENT" ? 404 : 400 });
    }
  };
}
