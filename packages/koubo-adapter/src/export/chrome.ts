/**
 * A browser, driven one frame at a time.
 *
 * The film's overlay — subtitles and modules — is HTML, so something has to
 * turn HTML into pictures. That something is the same engine the preview runs
 * in, which is the whole point: the export is not a second renderer that
 * agrees with the preview, it *is* the preview's renderer, asked for one frame
 * at a time instead of sixty a second.
 *
 * This talks to Chrome over the DevTools protocol directly rather than through
 * Puppeteer. The reason is packaging, not purity: the CLI ships as a single
 * bundled file with no runtime dependencies, and a browser automation library
 * is a large thing to bundle for the six commands actually used here —
 * navigate, evaluate, screenshot. The protocol is a JSON-over-WebSocket
 * request/response, so six commands is about a hundred lines.
 *
 * Nothing here knows what a subtitle is. It opens a page, runs an expression
 * in it, and hands back a PNG.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a system Chrome lives.
 *
 * A browser is not installed for this product: the export borrows the one on
 * the machine. If there is none, the export says so plainly rather than
 * downloading a hundred and fifty megabytes behind the user's back.
 */
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findSystemChrome(): string | null {
  return CHROME_PATHS.find((path) => existsSync(path)) ?? null;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface ChromePageOptions {
  width: number;
  height: number;
  /**
   * Render onto nothing instead of onto white.
   *
   * The overlay is a sheet laid over the footage, so every pixel it does not
   * draw has to come out of the encoder as "leave the footage alone". Without
   * this the sheet is opaque white and the film is a slideshow of blank pages.
   */
  transparent: boolean;
  /** Extra seconds to wait for the browser to come up. */
  launchTimeoutMs?: number;
}

export class ChromeError extends Error {}

export class ChromePage {
  #socket: WebSocket;
  #process: ChildProcess;
  #profileDir: string;
  #sessionId: string;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #closed = false;

  private constructor(
    socket: WebSocket,
    process: ChildProcess,
    profileDir: string,
    sessionId: string,
  ) {
    this.#socket = socket;
    this.#process = process;
    this.#profileDir = profileDir;
    this.#sessionId = sessionId;
  }

  static async launch(options: ChromePageOptions): Promise<ChromePage> {
    const executable = findSystemChrome();
    if (!executable) {
      throw new ChromeError(
        "找不到 Chrome。导出要用系统上的 Chrome 把字幕和动画画成图片，请先安装 Google Chrome。",
      );
    }
    const profileDir = await mkdtemp(join(tmpdir(), "chengfeng-videocut-export-"));
    const child = spawn(executable, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${Math.round(options.width)},${Math.round(options.height)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      // Deterministic type. Subpixel antialiasing paints coloured fringes that
      // are only correct against the background it assumed; on a transparent
      // sheet destined to be composited over footage they are wrong by
      // construction. Grayscale antialiasing composites correctly anywhere.
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--force-device-scale-factor=1",
      // Headless windows are "hidden" as far as the scheduler is concerned, and
      // a throttled renderer paints the frame before the one that was asked for.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--run-all-compositor-stages-before-draw",
      "--disable-new-content-rendering-timeout",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let endpoint: string;
    try {
      endpoint = await readDevToolsEndpoint(child, options.launchTimeoutMs ?? 20_000);
    } catch (error) {
      child.kill("SIGKILL");
      await rm(profileDir, { recursive: true, force: true });
      throw error;
    }

    const socket = await openSocket(endpoint);
    const page = new ChromePage(socket, child, profileDir, "");
    socket.addEventListener("message", (event) => page.#onMessage(String(event.data)));

    const target = await page.#send("Target.createTarget", { url: "about:blank" });
    const attached = await page.#send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    page.#sessionId = String(attached.sessionId);

    await page.#send("Page.enable", {});
    await page.#send("Runtime.enable", {});
    await page.#send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(options.width),
      height: Math.round(options.height),
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (options.transparent) {
      await page.#send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
    }
    return page;
  }

  #onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    const error = message.error as { message?: string } | undefined;
    if (error) pending.reject(new ChromeError(error.message ?? "DevTools command failed"));
    else pending.resolve((message.result ?? {}) as Record<string, unknown>);
  }

  async #send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#closed) throw new ChromeError("The browser has already been closed");
    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (this.#sessionId) payload.sessionId = this.#sessionId;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#socket.send(JSON.stringify(payload));
    return result;
  }

  /** Load a URL and wait until the document and its subresources are in. */
  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = this.#waitForLoad(timeoutMs);
    await this.#send("Page.navigate", { url });
    await loaded;
  }

  #waitForLoad(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#socket.removeEventListener("message", listener);
        reject(new ChromeError("The overlay page did not finish loading"));
      }, timeoutMs);
      const listener = (event: MessageEvent) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.method !== "Page.loadEventFired") return;
        clearTimeout(timer);
        this.#socket.removeEventListener("message", listener);
        resolve();
      };
      this.#socket.addEventListener("message", listener);
    });
  }

  /** Run an expression in the page and return its value. Awaits promises. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.#send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = result.exceptionDetails as
      | { exception?: { description?: string }; text?: string }
      | undefined;
    if (exception) {
      throw new ChromeError(exception.exception?.description ?? exception.text ?? "page error");
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  }

  /** One PNG of the current state of the page, alpha included. */
  async screenshot(): Promise<Buffer> {
    const result = await this.#send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
      optimizeForSpeed: true,
    });
    return Buffer.from(String(result.data), "base64");
  }


  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // The socket dying first is the normal shutdown order, not a failure.
    }
    this.#process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#process.kill("SIGKILL");
        resolve();
      }, 3_000);
      this.#process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(this.#profileDir, { recursive: true, force: true });
  }
}

/**
 * Chrome announces its debugging endpoint on stderr and nowhere else.
 *
 * The port is asked for as 0 — let the OS pick — precisely so an export never
 * collides with a browser the user already has open on a fixed port.
 */
function readDevToolsEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new ChromeError(`Chrome did not report a DevTools endpoint within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (value: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      buffered += chunk;
      const match = /ws:\/\/[^\s]+/.exec(buffered);
      if (match) finish(match[0]);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new ChromeError(`Chrome exited before it was ready (${code ?? "signal"})`));
    });
  });
}

function openSocket(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new ChromeError("Could not connect to Chrome's DevTools endpoint")),
      { once: true },
    );
  });
}
