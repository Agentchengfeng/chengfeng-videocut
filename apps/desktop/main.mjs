import { spawn } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import {
  classifyRuntimeHealth,
  DEFAULT_DESKTOP_HOST,
  parseDesktopPort,
  parseDesktopProjectId,
  prependToolsPath,
  resolveDesktopLayout,
  studioUrl,
} from "./runtime.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const smokeMode = process.env.CHENGFENG_VIDEOCUT_DESKTOP_SMOKE === "1";
const host = DEFAULT_DESKTOP_HOST;
const port = parseDesktopPort(process.env.CHENGFENG_VIDEOCUT_DESKTOP_PORT);
const baseUrl = `http://${host}:${port}`;
const projectId = parseDesktopProjectId(
  process.argv.slice(1),
  process.env.CHENGFENG_VIDEOCUT_DESKTOP_PROJECT_ID,
);
const dataDir = resolve(
  process.env.CHENGFENG_VIDEOCUT_DESKTOP_DATA_DIR ??
    process.env.CHENGFENG_VIDEOCUT_DATA_DIR ??
    join(homedir(), ".chengfeng-videocut"),
);
const layout = resolveDesktopLayout({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appRoot,
  platform: process.platform,
  bunOverride: process.env.CHENGFENG_VIDEOCUT_DESKTOP_BUN,
});

let mainWindow = null;
let ownedRuntime = null;
let quittingAfterCleanup = false;
const runtimeLog = [];
let runtimeLogBytes = 0;
const MAX_RUNTIME_LOG_BYTES = 64 * 1024;

function appendRuntimeLog(stream, chunk) {
  const text = String(chunk);
  runtimeLog.push(`[${stream}] ${text}`);
  runtimeLogBytes += Buffer.byteLength(text);
  while (runtimeLogBytes > MAX_RUNTIME_LOG_BYTES && runtimeLog.length > 1) {
    const removed = runtimeLog.shift();
    runtimeLogBytes -= Buffer.byteLength(removed ?? "");
  }
}

function runtimeLogTail() {
  return runtimeLog.join("").trim();
}

async function requireExecutable(path, label) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label} is missing: ${path}`);
  await access(path, process.platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK);
}

async function readResourceManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(layout.manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Desktop resource manifest is missing or invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.product !== "chengfeng-videocut" ||
    manifest.productVersion !== app.getVersion() ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  ) {
    throw new Error(
      `Desktop resource manifest does not match this app (${app.getVersion()} ${process.platform}-${process.arch}).`,
    );
  }
  return manifest;
}

async function verifyResources() {
  const manifest = await readResourceManifest();
  await Promise.all([
    requireExecutable(layout.bunPath, "Bundled Bun"),
    requireExecutable(layout.ffmpegPath, "Bundled FFmpeg"),
    requireExecutable(layout.ffprobePath, "Bundled FFprobe"),
    access(layout.cliPath, constants.R_OK),
    access(join(layout.runtimeDir, "studio", "index.html"), constants.R_OK),
  ]);
  return manifest;
}

async function fetchHealth(timeoutMs = 1_000) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status };
    }
    return await response.json();
  } catch {
    return null;
  }
}

function createExitPromise(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
  });
}

function spawnRuntime() {
  const environment = {
    ...process.env,
    PATH: prependToolsPath(process.env.PATH ?? "", layout.toolsDir),
    CHENGFENG_VIDEOCUT_DATA_DIR: dataDir,
    CHENGFENG_VIDEOCUT_SERVICE: "foreground",
  };
  const child = spawn(
    layout.bunPath,
    [
      layout.cliPath,
      "start",
      "--host",
      host,
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--json",
    ],
    {
      cwd: layout.runtimeDir,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => appendRuntimeLog("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendRuntimeLog("stderr", chunk));
  ownedRuntime = { child, exit: createExitPromise(child) };
  return ownedRuntime;
}

async function waitForCompatibleHealth(runtime, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth();
    if (health !== null) {
      const decision = classifyRuntimeHealth(health, app.getVersion());
      if (decision.action === "reuse") return { health, decision };
    }
    const exit = await Promise.race([
      runtime.exit,
      new Promise((resolveExit) => setTimeout(() => resolveExit(null), 100)),
    ]);
    if (exit) {
      throw new Error(
        `Bundled Runtime exited before becoming ready${
          runtimeLogTail() ? `:\n${runtimeLogTail()}` : "."
        }`,
      );
    }
  }
  throw new Error(
    `Bundled Runtime did not become ready within ${timeoutMs}ms${
      runtimeLogTail() ? `:\n${runtimeLogTail()}` : "."
    }`,
  );
}

async function ensureRuntime() {
  const existingHealth = await fetchHealth();
  const decision = classifyRuntimeHealth(existingHealth, app.getVersion());
  if (decision.action === "reuse") {
    return { owned: false, health: existingHealth, decision };
  }
  const runtime = spawnRuntime();
  const ready = await waitForCompatibleHealth(runtime);
  return { owned: true, ...ready };
}

async function waitForChildExit(runtime, timeoutMs) {
  return await Promise.race([
    runtime.exit,
    new Promise((resolveExit) => setTimeout(() => resolveExit(null), timeoutMs)),
  ]);
}

async function stopOwnedRuntime() {
  const runtime = ownedRuntime;
  if (!runtime) return;
  ownedRuntime = null;
  const { child } = runtime;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  if (await waitForChildExit(runtime, 5_000)) return;

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await Promise.race([
      new Promise((resolveExit) => killer.once("exit", resolveExit)),
      new Promise((resolveExit) => setTimeout(resolveExit, 2_000)),
    ]);
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await waitForChildExit(runtime, 2_000);
}

function installNavigationGuards(window, trustedOrigin) {
  window.webContents.on("will-navigate", (event, requestedUrl) => {
    if (new URL(requestedUrl).origin === trustedOrigin) return;
    event.preventDefault();
    void shell.openExternal(requestedUrl);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin !== trustedOrigin) void shell.openExternal(url);
    return { action: "deny" };
  });
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#09090b",
    title: "Chengfeng VideoCut",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installNavigationGuards(window, new URL(baseUrl).origin);
  window.once("ready-to-show", () => {
    if (!smokeMode) window.show();
  });
  await window.loadURL(studioUrl(baseUrl, projectId));
  mainWindow = window;
  return window;
}

async function waitForProjectWorkspace(window, timeoutMs = 30_000) {
  if (!projectId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workspace = await window.webContents.executeJavaScript(`
      (() => {
        const element = document.querySelector(".cf-cut-workspace[data-project-id]");
        return element ? {
          projectId: element.getAttribute("data-project-id"),
          mediaCount: element.getAttribute("data-player-media-count"),
          previewArtifactPhase: element.getAttribute("data-preview-artifact-phase"),
          previewArtifactCurrent: element.getAttribute("data-preview-artifact-current"),
          editListSaveState: element.getAttribute("data-edit-list-save-state"),
          cutSelectionSaveState: element.getAttribute("data-cut-selection-save-state"),
          loading: document.body.innerText.includes("正在读取逐词转录") ||
            document.body.innerText.includes("正在读取剪辑时间线") ||
            document.body.innerText.includes("正在准备剪辑预览")
        } : null;
      })()
    `);
    if (
      workspace?.projectId === projectId &&
      workspace.mediaCount === "1" &&
      workspace.previewArtifactPhase === "current" &&
      workspace.previewArtifactCurrent === "true" &&
      workspace.loading === false
    ) {
      return workspace;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const visibleText = await window.webContents.executeJavaScript(
    "document.body.innerText.slice(0, 2000)",
  );
  throw new Error(
    `Project workspace ${projectId} did not become ready within ${timeoutMs}ms: ${visibleText}`,
  );
}

async function runSmoke(window, runtimeState, resourceManifest) {
  const workspace = await waitForProjectWorkspace(window);
  if (workspace) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    window.webContents.invalidate();
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const renderer = await window.webContents.executeJavaScript(`
    (async () => {
      const response = await fetch("/api/health", { cache: "no-store" });
      return {
        title: document.title,
        view: new URL(location.href).searchParams.get("view"),
        hash: location.hash,
        health: await response.json()
      };
    })()
  `);
  const screenshotPath = process.env.CHENGFENG_VIDEOCUT_DESKTOP_SMOKE_SCREENSHOT;
  if (screenshotPath) {
    const image = await window.webContents.capturePage();
    await writeFile(resolve(screenshotPath), image.toPNG());
  }
  console.log(`DESKTOP_SMOKE_OK ${JSON.stringify({
    ownedRuntime: runtimeState.owned,
    renderer,
    workspace,
    resources: resourceManifest,
  })}`);
  window.destroy();
  mainWindow = null;
  if (process.env.CHENGFENG_VIDEOCUT_DESKTOP_SMOKE_NORMAL_QUIT === "1") {
    app.quit();
    return;
  }
  await stopOwnedRuntime();
  app.exit(0);
}

async function bootstrap() {
  const resourceManifest = await verifyResources();
  const runtimeState = await ensureRuntime();
  const window = await createMainWindow();
  if (smokeMode) await runSmoke(window, runtimeState, resourceManifest);
}

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!ownedRuntime || quittingAfterCleanup) return;
    event.preventDefault();
    quittingAfterCleanup = true;
    void stopOwnedRuntime().finally(() => app.quit());
  });
  app.whenReady().then(bootstrap).catch(async (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`DESKTOP_START_FAILED ${message}`);
    await stopOwnedRuntime();
    if (!smokeMode) dialog.showErrorBox("Chengfeng VideoCut 无法启动", message);
    app.exit(1);
  });
}
