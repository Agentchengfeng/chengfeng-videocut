import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const MEDIA_TYPES = new Map<string, string>([
  [".mp4", "video/mp4"],
  // Assembled-stream fragments. Without this the route returns null rather than a
  // 404, and the request falls through to a handler with no Range guarantee — the
  // failure would look like media that simply does not play.
  [".m4s", "video/iso.segment"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".webm", "video/webm"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".aac", "audio/aac"],
]);

interface PreviewMediaRoute {
  projectId: string;
  assetPath: string;
  contentType: string;
}

interface ResolvedMedia {
  path: string;
  size: number;
  mtime: Date;
  mtimeMs: number;
}

interface ByteRange {
  start: number;
  end: number;
}

export interface ProjectMediaHandlerOptions {
  projectsDir: string;
}

export type ProjectMediaHandler = (request: Request) => Promise<Response | null>;

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function isSafeProjectId(projectId: string): boolean {
  return (
    projectId.length > 0 &&
    projectId !== "." &&
    projectId !== ".." &&
    !projectId.includes("/") &&
    !projectId.includes("\\") &&
    !projectId.includes("\0") &&
    // A second decode must not be able to introduce a path separator.
    !/%(?:2f|5c)/i.test(projectId)
  );
}

function isSafeAssetPath(assetPath: string): boolean {
  if (
    !assetPath ||
    isAbsolute(assetPath) ||
    assetPath.includes("\\") ||
    assetPath.includes("\0")
  ) {
    return false;
  }
  return !assetPath.split("/").some((segment) => segment === "." || segment === "..");
}

function parsePreviewMediaRoute(pathname: string): PreviewMediaRoute | null | "invalid" {
  const match = /^\/api\/projects\/([^/]+)\/preview\/(.+)$/.exec(pathname);
  if (!match) return null;

  let projectId: string;
  let assetPath: string;
  try {
    projectId = decodeURIComponent(match[1]);
    assetPath = decodeURIComponent(match[2]);
  } catch {
    return "invalid";
  }

  const contentType = MEDIA_TYPES.get(extname(assetPath).toLowerCase());
  if (!contentType) return null;
  if (!isSafeProjectId(projectId) || !isSafeAssetPath(assetPath)) return "invalid";
  return { projectId, assetPath, contentType };
}

async function registeredProjectRoot(projectsDir: string, projectId: string): Promise<string | null> {
  try {
    const registration = resolve(projectsDir, projectId);
    if (!isWithin(projectsDir, registration)) return null;
    const root = await realpath(registration);
    const info = await stat(root);
    return info.isDirectory() ? root : null;
  } catch {
    return null;
  }
}

async function resolveMedia(root: string, assetPath: string): Promise<ResolvedMedia | null> {
  try {
    const candidate = resolve(root, assetPath);
    if (!isWithin(root, candidate)) return null;

    // realpath() follows every path component. Checking the canonical result
    // prevents a media symlink (or a symlinked parent directory) from escaping
    // the registered project root.
    const path = await realpath(candidate);
    if (!isWithin(root, path)) return null;
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { path, size: info.size, mtime: info.mtime, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function safeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse one RFC 9110 byte range. Multipart ranges are deliberately rejected. */
export function parseMediaRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || size <= 0) return null;

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = safeInteger(endText);
    if (suffixLength === null || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = safeInteger(startText);
  if (start === null || start >= size) return null;
  if (!endText) return { start, end: size - 1 };

  const requestedEnd = safeInteger(endText);
  if (requestedEnd === null || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function streamFile(path: string, range?: ByteRange): Blob {
  // Bun.file() is a lazy, file-backed Blob. slice() preserves that behavior,
  // so neither full nor ranged responses materialize the media in memory.
  const file = Bun.file(path);
  return range ? file.slice(range.start, range.end + 1) : file;
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function createProjectMediaHandler(
  options: ProjectMediaHandlerOptions,
): ProjectMediaHandler {
  const projectsDir = resolve(options.projectsDir);

  return async (request: Request): Promise<Response | null> => {
    const route = parsePreviewMediaRoute(new URL(request.url).pathname);
    if (route === null) return null;
    if (route === "invalid") return notFound();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      });
    }

    const root = await registeredProjectRoot(projectsDir, route.projectId);
    if (!root) return notFound();
    const media = await resolveMedia(root, route.assetPath);
    if (!media) return notFound();

    const etag = `"${Math.trunc(media.mtimeMs).toString(36)}-${media.size.toString(36)}"`;
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600, must-revalidate",
      "Content-Type": route.contentType,
      ETag: etag,
      "Last-Modified": media.mtime.toUTCString(),
      "X-Content-Type-Options": "nosniff",
    };

    const rangeHeader = request.headers.get("range");
    if (rangeHeader !== null) {
      const range = parseMediaRange(rangeHeader, media.size);
      if (!range) {
        return new Response(null, {
          status: 416,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes */${media.size}`,
          },
        });
      }
      const contentLength = range.end - range.start + 1;
      return new Response(request.method === "HEAD" ? null : streamFile(media.path, range), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(contentLength),
          "Content-Range": `bytes ${range.start}-${range.end}/${media.size}`,
        },
      });
    }

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }
    return new Response(request.method === "HEAD" ? null : streamFile(media.path), {
      headers: {
        ...baseHeaders,
        "Content-Length": String(media.size),
      },
    });
  };
}
