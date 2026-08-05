import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function resolveManagedRuntimeLayout({ dataDir, version, platform }) {
  const root = resolve(dataDir);
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const toolsRoot = join(root, "tools");
  const toolsVersionDir = join(toolsRoot, version);
  const toolsCurrentDir = join(toolsRoot, "current");
  const appRoot = join(root, "app");
  const appCurrentDir = join(appRoot, "current");
  return {
    root,
    toolsRoot,
    toolsVersionDir,
    toolsCurrentDir,
    toolsManifestPath: join(toolsVersionDir, "resources-manifest.json"),
    managedBunPath: join(toolsVersionDir, `bun${executableSuffix}`),
    managedFfmpegPath: join(toolsVersionDir, `ffmpeg${executableSuffix}`),
    managedFfprobePath: join(toolsVersionDir, `ffprobe${executableSuffix}`),
    appRoot,
    appCurrentDir,
    installedCliPath: join(appCurrentDir, "cli.js"),
    stableLauncherPath: join(
      root,
      "bin",
      platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut",
    ),
    desktopReceiptPath: join(root, "desktop-installation.json"),
  };
}

function prependPath(currentPath, first) {
  return currentPath ? `${first}${delimiter}${currentPath}` : first;
}

async function isReadableFile(path, executable = false) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  try {
    await access(
      path,
      executable && process.platform !== "win32"
        ? constants.R_OK | constants.X_OK
        : constants.R_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function managedToolsAreCurrent(layout, manifest, platform) {
  let installedManifest;
  try {
    installedManifest = JSON.parse(await readFile(layout.toolsManifestPath, "utf8"));
  } catch {
    return false;
  }
  if (
    installedManifest?.product !== manifest.product ||
    installedManifest?.productVersion !== manifest.productVersion ||
    installedManifest?.platform !== manifest.platform ||
    installedManifest?.arch !== manifest.arch ||
    installedManifest?.bun !== manifest.bun ||
    installedManifest?.ffmpeg !== manifest.ffmpeg ||
    installedManifest?.ffprobe !== manifest.ffprobe
  ) {
    return false;
  }
  const executable = platform !== "win32";
  const checks = await Promise.all([
    isReadableFile(layout.managedBunPath, executable),
    isReadableFile(layout.managedFfmpegPath, executable),
    isReadableFile(layout.managedFfprobePath, executable),
  ]);
  return checks.every(Boolean);
}

export async function installBundledTools({
  dataDir,
  version,
  platform,
  manifest,
  bundledBunPath,
  bundledFfmpegPath,
  bundledFfprobePath,
}) {
  const layout = resolveManagedRuntimeLayout({ dataDir, version, platform });
  await mkdir(layout.toolsRoot, { recursive: true });
  if (!(await managedToolsAreCurrent(layout, manifest, platform))) {
    const stagedDir = join(layout.toolsRoot, `.${version}.new.${process.pid}`);
    const backupDir = join(layout.toolsRoot, `.${version}.backup.${process.pid}`);
    await rm(stagedDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
    await mkdir(stagedDir, { recursive: true });
    const suffix = platform === "win32" ? ".exe" : "";
    await Promise.all([
      copyFile(bundledBunPath, join(stagedDir, `bun${suffix}`)),
      copyFile(bundledFfmpegPath, join(stagedDir, `ffmpeg${suffix}`)),
      copyFile(bundledFfprobePath, join(stagedDir, `ffprobe${suffix}`)),
      writeFile(
        join(stagedDir, "resources-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    ]);
    if (platform !== "win32") {
      await Promise.all([
        chmod(join(stagedDir, "bun"), 0o755),
        chmod(join(stagedDir, "ffmpeg"), 0o755),
        chmod(join(stagedDir, "ffprobe"), 0o755),
      ]);
    }

    const existing = await stat(layout.toolsVersionDir).catch(() => null);
    if (existing) await rename(layout.toolsVersionDir, backupDir);
    try {
      await rename(stagedDir, layout.toolsVersionDir);
      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      if (await stat(backupDir).catch(() => null)) {
        await rm(layout.toolsVersionDir, { recursive: true, force: true });
        await rename(backupDir, layout.toolsVersionDir);
      }
      throw error;
    } finally {
      await rm(stagedDir, { recursive: true, force: true });
    }
  }
  return layout;
}

export async function runCaptured(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let overflow = false;
  const append = (stream, chunk) => {
    const text = String(chunk);
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > MAX_OUTPUT_BYTES) {
      overflow = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return;
    }
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));

  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise((resolveResult) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({ ...result, stdout, stderr, overflow });
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish({ code: null, signal: null, timeout: true });
    }, timeoutMs);
    child.once("exit", (code, signal) => finish({ code, signal, timeout: false }));
    child.once("error", (error) =>
      finish({ code: null, signal: null, timeout: false, error })
    );
  });
}

function commandFailure(label, result) {
  const detail = {
    code: result.code,
    signal: result.signal,
    timeout: result.timeout,
    overflow: result.overflow,
    error: result.error?.message,
    stdout: result.stdout.trim().slice(-2_000),
    stderr: result.stderr.trim().slice(-4_000),
  };
  return new Error(`${label} failed: ${JSON.stringify(detail)}`);
}

async function verifyBundledTools(layout) {
  for (const [label, command, args] of [
    ["Bundled Bun", layout.managedBunPath, ["--version"]],
    ["Bundled FFmpeg", layout.managedFfmpegPath, ["-version"]],
    ["Bundled FFprobe", layout.managedFfprobePath, ["-version"]],
  ]) {
    const result = await runCaptured(command, args, { timeoutMs: 15_000 });
    if (
      result.timeout ||
      result.overflow ||
      result.error ||
      result.code !== 0
    ) {
      throw commandFailure(`${label} verification`, result);
    }
  }
}

async function installedRuntimeIsCurrent(layout, version, environment) {
  if (
    !(await isReadableFile(layout.installedCliPath)) ||
    !(await isReadableFile(layout.stableLauncherPath, true))
  ) {
    return false;
  }
  const result = await runCaptured(
    layout.managedBunPath,
    [layout.installedCliPath, "--version"],
    { env: environment, timeoutMs: 15_000 },
  );
  return (
    !result.timeout &&
    !result.overflow &&
    !result.error &&
    result.code === 0 &&
    new RegExp(`(?:^|\\s)${version.replaceAll(".", "\\.")}(?=\\s|$)`).test(result.stdout)
  );
}

function parseJsonEnvelope(result, label) {
  if (
    result.timeout ||
    result.overflow ||
    result.error ||
    result.code !== 0
  ) {
    throw commandFailure(label, result);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(
      `${label} returned invalid JSON: ${result.stdout.trim().slice(-2_000)}`,
    );
  }
}

async function writeDesktopReceipt(layout, manifest, service) {
  const temporary = `${layout.desktopReceiptPath}.${process.pid}.tmp`;
  const receipt = {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    source: "desktop",
    productVersion: manifest.productVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    runtimeMode: service.runtimeMode,
    installedAt: new Date().toISOString(),
  };
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporary, layout.desktopReceiptPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ensureManagedRuntime({
  dataDir,
  version,
  platform,
  manifest,
  bundledBunPath,
  bundledFfmpegPath,
  bundledFfprobePath,
  installerDir,
  installerPath,
}) {
  const layout = await installBundledTools({
    dataDir,
    version,
    platform,
    manifest,
    bundledBunPath,
    bundledFfmpegPath,
    bundledFfprobePath,
    activate: false,
  });
  // Keep the previous tools/current live until the shared installer has
  // verified and activated the Runtime.  The installer receives this version
  // directory directly; Electron never owns app/current or service rollback.
  await verifyBundledTools(layout);
  const environment = {
    ...process.env,
    PATH: prependPath(process.env.PATH ?? "", layout.toolsVersionDir),
    CHENGFENG_VIDEOCUT_HOME: layout.root,
    CHENGFENG_VIDEOCUT_DATA_DIR: layout.root,
    CHENGFENG_VIDEOCUT_EXECUTABLE: layout.stableLauncherPath,
  };

  const installEnvironment = {
    ...environment,
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(
      `${resolve(installerDir)}${process.platform === "win32" ? "\\" : "/"}`,
    ).href.replace(/\/$/, ""),
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_DIR: layout.toolsVersionDir,
  };
  const installResult = await runCaptured(
    layout.managedBunPath,
    [resolve(installerPath)],
    {
      cwd: dirname(resolve(installerPath)),
      env: installEnvironment,
      timeoutMs: 180_000,
    },
  );
  if (
    installResult.timeout ||
    installResult.overflow ||
    installResult.error ||
    installResult.code !== 0
  ) {
    throw commandFailure("Bundled Runtime installation", installResult);
  }
  if (!(await installedRuntimeIsCurrent(layout, version, environment))) {
    throw new Error(
      `Bundled Runtime installation completed, but ${version} could not prove itself`,
    );
  }

  const statusResult = await runCaptured(
    layout.managedBunPath,
    [layout.installedCliPath, "service", "status", "--json"],
    { env: environment, timeoutMs: 120_000 },
  );
  const envelope = parseJsonEnvelope(statusResult, "Managed Runtime service status");
  const expectedMode = platform === "win32" ? "windows-task" : "launchd";
  if (
    envelope?.ok !== true ||
    envelope?.data?.ready !== true ||
    envelope?.data?.healthy !== true ||
    envelope?.data?.productVersion !== version ||
    envelope?.data?.runtimeMode !== expectedMode
  ) {
    throw new Error(
      `Managed Runtime did not become ready as ${expectedMode}: ${JSON.stringify(envelope)}`,
    );
  }
  await writeDesktopReceipt(layout, manifest, envelope.data);
  return { layout, envelope, environment };
}
