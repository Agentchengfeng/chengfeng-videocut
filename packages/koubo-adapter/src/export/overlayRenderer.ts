/**
 * Turning the overlay page into a picture per frame.
 *
 * The film is a fixed number of pictures, decided in the plan. This asks the
 * browser for each of them in order and writes them out as PNGs with an alpha
 * channel — transparent everywhere the film should show the footage.
 *
 * Two properties make this an export rather than a screen recording:
 *
 * ```text
 * 逐帧驱动   the page is told an instant and asked for that instant. Nothing
 *           runs on a clock, so nothing can drift, and the same second of the
 *           film renders identically on a fast machine and a slow one
 * 逐帧应答   the page confirms the module has processed the seek before the
 *           picture is taken. Without it a screenshot can be of the previous
 *           frame, and a whole export can sit one frame behind the audio
 *           without ever looking obviously broken
 * ```
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { ExportPlan } from "@video-workbench/core";
import { ChromePage } from "./chrome";
import { OVERLAY_PAGE_NAME, renderOverlayPage } from "./overlayPage";

/**
 * What a module is allowed to fetch.
 *
 * Serving only HTML is not a safe default, it is a silent one: a module whose
 * `gsap.min.js` 404s renders a blank page and reports no fault at all. The
 * list is what an animation legitimately needs and nothing else.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function contentTypeFor(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * A read-only view of the project directory, on a port nobody else knows.
 *
 * The overlay page and the modules have to share one origin: the page reaches
 * into each module's window to install the acknowledgement hook, and a
 * cross-origin frame would refuse. Serving both from here is what makes that
 * legal — and the server exists only for the length of one export.
 */
export async function startProjectFileServer(
  projectDirectory: string,
  overlayHtml: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const root = resolve(projectDirectory);
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === `/${OVERLAY_PAGE_NAME}`) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(overlayHtml);
        return;
      }
      const target = normalize(join(root, pathname));
      if (target !== root && !target.startsWith(root + sep)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const type = contentTypeFor(target);
      if (!type) {
        response.writeHead(415).end("unsupported");
        return;
      }
      try {
        const body = await readFile(target);
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(body);
      } catch {
        response.writeHead(404).end("not found");
      }
    })();
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("File server did not bind a port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

export interface RenderOverlayFramesInput {
  plan: ExportPlan;
  projectDirectory: string;
  /** Where the PNGs go. Created if missing. */
  framesDirectory: string;
  onProgress?: (rendered: number, total: number) => void;
}

export interface RenderOverlayFramesResult {
  framesDirectory: string;
  frameCount: number;
  /** `%06d.png`, the pattern ffmpeg reads them back with. */
  pattern: string;
}

export async function renderOverlayFrames(
  input: RenderOverlayFramesInput,
): Promise<RenderOverlayFramesResult> {
  const { plan } = input;
  await mkdir(input.framesDirectory, { recursive: true });
  const html = renderOverlayPage(plan, "/");
  const server = await startProjectFileServer(input.projectDirectory, html);
  let page: ChromePage | null = null;
  try {
    page = await ChromePage.launch({
      width: plan.output.width,
      height: plan.output.height,
      transparent: true,
    });
    await page.goto(`${server.origin}/${OVERLAY_PAGE_NAME}`);
    await page.evaluate<boolean>("window.__ready()");
    const failure = await page.evaluate<string | undefined>("window.__overlayError");
    if (failure) throw new Error(`The overlay page could not reach a module: ${failure}`);

    for (let index = 0; index < plan.frameCount; index += 1) {
      // The frame's own timestamp, not its middle: this is the instant the
      // picture claims to be, and it is what the player shows when the
      // playhead reads that number.
      const time = index / plan.fps;
      await page.evaluate(`window.__seek(${time.toFixed(6)})`);
      const png = await page.screenshot();
      await writeFile(join(input.framesDirectory, `${String(index).padStart(6, "0")}.png`), png);
      input.onProgress?.(index + 1, plan.frameCount);
    }
  } finally {
    if (page) await page.close();
    await server.close();
  }
  return {
    framesDirectory: input.framesDirectory,
    frameCount: plan.frameCount,
    pattern: join(input.framesDirectory, "%06d.png"),
  };
}
