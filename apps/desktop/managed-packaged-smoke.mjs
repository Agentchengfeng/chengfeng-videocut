import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(fileURLToPath(import.meta.url));
const releaseRoot = join(appRoot, "release");
const configured = process.env.CHENGFENG_VIDEOCUT_PACKAGED_APP;
const candidates = configured
  ? [resolve(configured)]
  : platform === "darwin"
  ? [
      join(releaseRoot, `mac-${arch}`, "Chengfeng VideoCut.app", "Contents", "MacOS", "Chengfeng VideoCut"),
      join(releaseRoot, "mac", "Chengfeng VideoCut.app", "Contents", "MacOS", "Chengfeng VideoCut"),
    ]
  : platform === "win32"
  ? [join(releaseRoot, "win-unpacked", "Chengfeng VideoCut.exe")]
  : [join(releaseRoot, "linux-unpacked", "chengfeng-videocut")];
const executable = candidates.find((candidate) => existsSync(candidate));
if (!executable) {
  throw new Error(`Packaged desktop executable was not found. Tried:\n${candidates.join("\n")}`);
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (/[\0\r\n"]/.test(text)) throw new Error("unsafe Windows smoke argument");
  return `"${text.replaceAll("%", "%%")}"`;
}

function stableCommand(launcher, args) {
  if (platform !== "win32") return { executable: launcher, args };
  const line = `"${[
    quoteWindowsArgument(launcher),
    ...args.map(quoteWindowsArgument),
  ].join(" ")}"`;
  return {
    executable: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", line],
    windowsVerbatimArguments: true,
  };
}

async function runProcess(command, args, env, options = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (options.trace) process.stdout.write(chunk);
    stdout = `${stdout}${chunk}`.slice(-1024 * 1024);
  });
  child.stderr.on("data", (chunk) => {
    if (options.trace) process.stderr.write(chunk);
    stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
  });
  const timeoutMs = options.timeoutMs ?? 180_000;
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExit({ ...result, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish({ timeout: true, code: null, signal: null });
    }, timeoutMs);
    child.once("exit", (code, signal) => finish({ code, signal }));
    child.once("error", (error) => finish({ code: null, signal: null, error }));
  });
}

function assertSuccess(label, result, marker) {
  if (
    result.timeout ||
    result.error ||
    result.code !== 0 ||
    (marker && !result.stdout.includes(marker))
  ) {
    throw new Error(`${label} failed: ${JSON.stringify({
      code: result.code,
      signal: result.signal,
      timeout: result.timeout,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    })}`);
  }
}

async function waitForHealth(expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:5190/api/health", {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      last = response.ok ? await response.json() : { status: response.status };
      if (expected(last)) return last;
    } catch {
      last = null;
      if (expected(last)) return last;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Managed Runtime health did not reach the expected state: ${JSON.stringify(last)}`);
}

const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-managed-smoke-"));
const version = JSON.parse(
  await readFile(join(appRoot, "package.json"), "utf8"),
).version;
const launcher = join(
  root,
  "bin",
  platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut",
);
const appEnvironment = {
  CHENGFENG_VIDEOCUT_DESKTOP_SMOKE: "1",
  CHENGFENG_VIDEOCUT_DESKTOP_SMOKE_NORMAL_QUIT: "1",
  CHENGFENG_VIDEOCUT_DESKTOP_DATA_DIR: root,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};

let stopped = false;
let primaryFailure = null;
try {
  const appResult = await runProcess(executable, [], appEnvironment, {
    timeoutMs: 120_000,
    trace: true,
  });
  assertSuccess("managed packaged app", appResult, "DESKTOP_SMOKE_OK");
  const smokeLine = appResult.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("DESKTOP_SMOKE_OK "));
  const smoke = JSON.parse(smokeLine.slice("DESKTOP_SMOKE_OK ".length));
  if (
    smoke.ownedRuntime !== false ||
    smoke.renderer?.health?.runtimeMode !== (platform === "win32" ? "windows-task" : "launchd")
  ) {
    throw new Error(`Desktop did not use the managed Runtime: ${JSON.stringify(smoke)}`);
  }

  const healthAfterParentExit = await waitForHealth(
    (health) =>
      health?.ok === true &&
      health.productVersion === version &&
      health.runtimeMode === (platform === "win32" ? "windows-task" : "launchd"),
  );
  const toolsCurrent = join(root, "tools", "current");
  const toolsVersion = join(root, "tools", version);
  if (await realpath(toolsCurrent) !== await realpath(toolsVersion)) {
    throw new Error("Managed tools/current does not point at the desktop version");
  }
  for (const path of [
    launcher,
    join(root, "app", "current", "cli.js"),
    join(toolsCurrent, platform === "win32" ? "bun.exe" : "bun"),
    join(toolsCurrent, platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    join(toolsCurrent, platform === "win32" ? "ffprobe.exe" : "ffprobe"),
  ]) {
    if (!(await stat(path)).isFile()) throw new Error(`Managed asset is missing: ${path}`);
  }
  const installedVersion = (
    await readFile(join(root, "app", "current", "VERSION"), "utf8")
  ).trim();
  if (installedVersion !== version) {
    throw new Error(`Installed Runtime version mismatch: ${installedVersion}`);
  }
  const receipt = JSON.parse(
    await readFile(join(root, "desktop-installation.json"), "utf8"),
  );
  if (
    receipt?.source !== "desktop" ||
    receipt?.productVersion !== version ||
    receipt?.runtimeMode !== healthAfterParentExit.runtimeMode
  ) {
    throw new Error(`Desktop installation receipt mismatch: ${JSON.stringify(receipt)}`);
  }

  const doctorCommand = stableCommand(launcher, ["doctor", "--json"]);
  const doctor = await runProcess(
    doctorCommand.executable,
    doctorCommand.args,
    {},
    { windowsVerbatimArguments: doctorCommand.windowsVerbatimArguments },
  );
  assertSuccess("stable launcher doctor", doctor);
  const doctorEnvelope = JSON.parse(doctor.stdout.trim());
  if (doctorEnvelope?.ok !== true) {
    throw new Error(`Stable launcher doctor was not healthy: ${doctor.stdout}`);
  }

  const stopCommand = stableCommand(launcher, ["service", "stop", "--json"]);
  const stop = await runProcess(
    stopCommand.executable,
    stopCommand.args,
    {},
    { windowsVerbatimArguments: stopCommand.windowsVerbatimArguments },
  );
  assertSuccess("managed service stop", stop);
  stopped = true;
  await waitForHealth((health) => health === null);

  console.log(JSON.stringify({
    status: "managed_desktop_smoke_passed",
    platform,
    version,
    parentExitPreservedPid: healthAfterParentExit.pid,
    runtimeMode: healthAfterParentExit.runtimeMode,
    stableLauncher: launcher,
  }));
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  if (!stopped && existsSync(launcher)) {
    const stopCommand = stableCommand(launcher, ["service", "stop", "--json"]);
    await runProcess(
      stopCommand.executable,
      stopCommand.args,
      {},
      {
        windowsVerbatimArguments: stopCommand.windowsVerbatimArguments,
        timeoutMs: 30_000,
      },
    ).catch(() => undefined);
    await waitForHealth((health) => health === null, 10_000).catch(
      () => undefined,
    );
  }
  try {
    if (platform === "win32") {
      // GitHub's ephemeral Windows runner owns this fixture. Defender can keep
      // several recently executed files open long after every Product PID and
      // health endpoint are gone, so filesystem deletion is not a lifecycle
      // assertion on Windows.
      console.warn(`Managed smoke retained Windows temp fixture: ${root}`);
    } else {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  } catch (cleanupError) {
    const detail = cleanupError?.message ?? cleanupError;
    if (!primaryFailure) {
      throw cleanupError;
    } else {
      console.error(`Managed smoke cleanup also failed: ${detail}`);
    }
  }
}
