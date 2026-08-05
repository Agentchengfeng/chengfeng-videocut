import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../output";

export const STUDIO_SERVICE_LABEL = "com.chengfeng.videocut.studio";
export const STUDIO_SERVICE_URL = "http://127.0.0.1:5190";
export const SERVICE_API_VERSION = 1;

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const STALE_LOCK_MS = 30_000;
const MAX_LOG_LINES = 1_000;
const MAX_LOG_BYTES = 1024 * 1024;

export type StudioServiceAction =
  | "install"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "logs"
  | "ensure";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface StudioServiceDependencies {
  platform?: string;
  homeDir?: string;
  dataDir?: string;
  launcherPath?: string;
  uid?: number;
  pid?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  runCommand?: CommandRunner;
  fetch?: typeof globalThis.fetch;
  isPortOccupied?: () => Promise<boolean>;
  getPortOwnerPid?: () => Promise<number | null>;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  readyTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface StudioServicePaths {
  homeDir: string;
  dataDir: string;
  launcherPath: string;
  plistPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  operationLockPath: string;
}

export interface StudioServiceIdentity {
  product: string;
  productVersion: string;
  pid: number;
  runtimeMode: "launchd" | "windows-task";
  studioBuildId: string;
}

export interface StudioServiceStatus {
  serviceApiVersion: number;
  label: string;
  state: "uninstalled" | "stopped" | "starting" | "running" | "unhealthy" | "conflict";
  installed: boolean;
  configured: boolean;
  loaded: boolean;
  ready: boolean;
  healthy: boolean;
  pid: number | null;
  runtimeMode: "launchd" | "windows-task" | null;
  productVersion: string | null;
  studioBuildId: string | null;
  url: string;
  identity: StudioServiceIdentity | null;
  paths: StudioServicePaths;
  detail?: string;
}

export interface StudioServiceCommandResult extends StudioServiceStatus {
  action: StudioServiceAction;
  changed: boolean;
  logs?: {
    lines: number;
    stdout: string;
    stderr: string;
  };
}

export interface ManagedJobStatus {
  loaded: boolean;
  pid: number | null;
  raw: string;
}
type LaunchdStatus = ManagedJobStatus;

interface HealthProbe {
  reachable: boolean;
  portOwnerPid: number | null;
  product: string | null;
  productVersion: string | null;
  reportedPid: number | null;
  reportedRuntimeMode: string | null;
  studioBuildId: string | null;
  detail?: string;
}

export interface ResolvedServiceDependencies {
  platform: string;
  homeDir: string;
  dataDir: string;
  launcherPath: string;
  uid: number;
  pid: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  runCommand: CommandRunner;
  fetch: typeof globalThis.fetch;
  isPortOccupied: () => Promise<boolean>;
  getPortOwnerPid: () => Promise<number | null>;
  isProcessAlive: (pid: number) => boolean;
  killProcess: (pid: number) => void;
  readyTimeoutMs: number;
  lockTimeoutMs: number;
}

export class StudioServiceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "StudioServiceError";
    this.code = code;
    this.details = details;
  }
}

function defaultCommandRunner(executable: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const appendBounded = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= MAX_LOG_BYTES) return current;
      const accepted = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - current));
      if (accepted.length > 0) chunks.push(accepted);
      return current + accepted.length;
    };
    child.stdout.on("data", (value: Buffer) => {
      stdoutBytes = appendBounded(stdout, value, stdoutBytes);
    });
    child.stderr.on("data", (value: Buffer) => {
      stderrBytes = appendBounded(stderr, value, stderrBytes);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function defaultPortOccupied(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 5190 });
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function defaultPortOwnerPid(runCommand: CommandRunner): Promise<number | null> {
  const result = await runCommand("/usr/sbin/lsof", [
    "-nP",
    "-iTCP:5190",
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (result.code !== 0) return null;
  const pids = [...new Set(
    result.stdout
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  )];
  return pids.length === 1 ? pids[0] : null;
}

async function defaultWindowsPortOwnerPid(runCommand: CommandRunner): Promise<number | null> {
  let result: CommandResult;
  try {
    result = await runCommand("netstat", ["-ano", "-p", "TCP"]);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const pids = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line) || !/[:.]5190\s/.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).at(-1));
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids.size === 1 ? [...pids][0] : null;
}

function managedRootFromExecutable(executable: string | undefined): string | null {
  if (!executable || !isAbsolute(executable)) return null;
  const absolute = resolve(executable);
  const binDir = dirname(absolute);
  const name = basename(absolute);
  if ((name !== "chengfeng-videocut" && name !== "chengfeng-videocut.cmd") || basename(binDir) !== "bin") return null;
  return dirname(binDir);
}

function resolveDependencies(input: StudioServiceDependencies): ResolvedServiceDependencies {
  const homeDir = input.homeDir ?? homedir();
  const injectedHome = input.homeDir !== undefined;
  const environmentExecutable = injectedHome
    ? undefined
    : process.env.CHENGFENG_VIDEOCUT_EXECUTABLE;
  const executableRoot = managedRootFromExecutable(environmentExecutable);
  const dataDir = resolve(
    input.dataDir ??
    (!injectedHome ? process.env.CHENGFENG_VIDEOCUT_HOME : undefined) ??
    executableRoot ??
    join(homeDir, ".chengfeng-videocut"),
  );
  const runCommand = input.runCommand ?? defaultCommandRunner;
  return {
    platform: input.platform ?? process.platform,
    homeDir,
    dataDir,
    launcherPath: resolve(
      input.launcherPath ??
      (executableRoot && environmentExecutable
        ? environmentExecutable
        : join(
            dataDir,
            "bin",
            (input.platform ?? process.platform) === "win32"
              ? "chengfeng-videocut.cmd"
              : "chengfeng-videocut",
          )),
    ),
    uid: input.uid ?? process.getuid?.() ?? -1,
    pid: input.pid ?? process.pid,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    runCommand,
    fetch: input.fetch ?? globalThis.fetch,
    isPortOccupied: input.isPortOccupied ?? defaultPortOccupied,
    getPortOwnerPid: input.getPortOwnerPid ?? (
      (input.platform ?? process.platform) === "win32"
        ? () => defaultWindowsPortOwnerPid(runCommand)
        : () => defaultPortOwnerPid(runCommand)
    ),
    isProcessAlive: input.isProcessAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
    killProcess: input.killProcess ?? ((pid) => {
      process.kill(pid);
    }),
    readyTimeoutMs: input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    lockTimeoutMs: input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  };
}

export function studioServicePaths(
  homeDir = homedir(),
  dataDir = join(homeDir, ".chengfeng-videocut"),
  launcherPath?: string,
  platform: string = process.platform,
): StudioServicePaths {
  return {
    homeDir,
    dataDir: resolve(dataDir),
    launcherPath: resolve(
      launcherPath ??
      join(dataDir, "bin", platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut"),
    ),
    // 服务定义文件：darwin 是 LaunchAgent plist，win32 是计划任务 XML。
    plistPath: platform === "win32"
      ? join(dataDir, "service", "studio-task.xml")
      : join(homeDir, "Library", "LaunchAgents", `${STUDIO_SERVICE_LABEL}.plist`),
    stdoutLogPath: join(dataDir, "logs", "studio.stdout.log"),
    stderrLogPath: join(dataDir, "logs", "studio.stderr.log"),
    operationLockPath: join(dataDir, "service-operation.lock"),
  };
}

function requireManagedPlatform(deps: ResolvedServiceDependencies): void {
  if (deps.platform === "win32") return;
  if (deps.platform !== "darwin" || deps.uid < 0) {
    throw new StudioServiceError(
      "service_unsupported",
      "Managed Studio service is supported only for macOS user sessions and Windows logon sessions",
      { platform: deps.platform },
    );
  }
}

function launchdTarget(deps: ResolvedServiceDependencies): string {
  return `gui/${deps.uid}/${STUDIO_SERVICE_LABEL}`;
}

function launchdDomain(deps: ResolvedServiceDependencies): string {
  return `gui/${deps.uid}`;
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderStudioLaunchAgent(paths: StudioServicePaths): string {
  const args = [
    paths.launcherPath,
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    "5190",
    "--data-dir",
    paths.dataDir,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${STUDIO_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHENGFENG_VIDEOCUT_SERVICE</key>
    <string>launchd</string>
    <key>CHENGFENG_VIDEOCUT_HOME</key>
    <string>${xmlEscape(paths.dataDir)}</string>
    <key>HOME</key>
    <string>${xmlEscape(paths.homeDir)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(paths.homeDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(paths.stdoutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(paths.stderrLogPath)}</string>
</dict>
</plist>
`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function requireLauncher(paths: StudioServicePaths): Promise<void> {
  try {
    await access(
      paths.launcherPath,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
  } catch {
    throw new StudioServiceError(
      "service_launcher_missing",
      `Stable product launcher is missing or not executable: ${paths.launcherPath}`,
      { launcherPath: paths.launcherPath },
    );
  }
}

export async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function launchAgentConfigurationCurrent(paths: StudioServicePaths): Promise<boolean> {
  try {
    return await readFile(paths.plistPath, "utf8") === renderStudioLaunchAgent(paths);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function launchdStatus(deps: ResolvedServiceDependencies): Promise<LaunchdStatus> {
  const result = await deps.runCommand("/bin/launchctl", ["print", launchdTarget(deps)]);
  if (result.code !== 0) {
    const raw = result.stderr || result.stdout;
    if (/Could not find service\b/i.test(raw) && !/Could not find domain\b/i.test(raw)) {
      return { loaded: false, pid: null, raw };
    }
    throw new StudioServiceError(
      "service_unavailable",
      "launchctl could not inspect the Studio service",
      { code: result.code, stderr: raw.trim().slice(0, 2_000) },
    );
  }
  const raw = result.stdout || result.stderr;
  const match = /(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/m.exec(raw);
  return {
    loaded: true,
    pid: match ? Number(match[1]) : null,
    raw,
  };
}

export async function probeHealth(deps: ResolvedServiceDependencies): Promise<HealthProbe> {
  let response: Response;
  try {
    response = await deps.fetch(`${STUDIO_SERVICE_URL}/api/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    const occupied = await deps.isPortOccupied();
    const portOwnerPid = occupied ? await deps.getPortOwnerPid() : null;
    return {
      reachable: occupied,
      portOwnerPid,
      product: null,
      productVersion: null,
      reportedPid: null,
      reportedRuntimeMode: null,
      studioBuildId: null,
      ...(occupied ? { detail: "Port accepts TCP connections but has no valid Product health" } : {}),
    };
  }

  let health: Record<string, unknown> | null = null;
  try {
    const payload = await response.json();
    health = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    health = null;
  }
  if (!response.ok || !health) {
    return {
      reachable: true,
      portOwnerPid: await deps.getPortOwnerPid(),
      product: null,
      productVersion: null,
      reportedPid: null,
      reportedRuntimeMode: null,
      studioBuildId: null,
      detail: `Port returned an invalid Product health response (HTTP ${response.status})`,
    };
  }
  if (health.schemaVersion !== 1 || health.ok !== true) {
    return {
      reachable: true,
      portOwnerPid: await deps.getPortOwnerPid(),
      product: null,
      productVersion: null,
      reportedPid: null,
      reportedRuntimeMode: null,
      studioBuildId: null,
      detail: "Port returned an incompatible Product health contract",
    };
  }
  const productVersion = typeof health.productVersion === "string"
    ? health.productVersion
    : null;
  const product = typeof health.product === "string" ? health.product : null;
  const reportedPid = typeof health.pid === "number" && Number.isInteger(health.pid)
    ? health.pid
    : null;
  const reportedRuntimeMode = typeof health.runtimeMode === "string"
    ? health.runtimeMode
    : null;
  const needsOsOwnership = product !== PRODUCT_NAME || reportedPid === null ||
    reportedRuntimeMode === null;
  return {
    reachable: true,
    portOwnerPid: needsOsOwnership ? await deps.getPortOwnerPid() : null,
    product,
    productVersion,
    reportedPid,
    reportedRuntimeMode,
    studioBuildId: typeof health.studioBuildId === "string" && health.studioBuildId.trim()
      ? health.studioBuildId
      : null,
  };
}

export function assertNoPortConflict(
  launchd: ManagedJobStatus,
  health: HealthProbe,
  expectedMode: "launchd" | "windows-task" = "launchd",
): void {
  if (!health.reachable) return;
  if (health.product !== PRODUCT_NAME) {
    throw new StudioServiceError(
      "service_port_conflict",
      `${STUDIO_SERVICE_URL} is occupied by an unknown service; it was not stopped`,
      { url: STUDIO_SERVICE_URL, observedProduct: health.product },
    );
  }
  if (
    !health.productVersion ||
    health.reportedPid === null ||
    !health.reportedRuntimeMode ||
    !health.studioBuildId
  ) {
    throw new StudioServiceError(
      "service_port_conflict",
      "Studio port returned an incomplete Product health identity; no process was stopped",
      {
        url: STUDIO_SERVICE_URL,
        productVersion: health.productVersion,
        healthPid: health.reportedPid,
        runtimeMode: health.reportedRuntimeMode,
        studioBuildId: health.studioBuildId,
      },
    );
  }
  if (!launchd.loaded || !launchd.pid) {
    throw new StudioServiceError(
      "service_port_conflict",
      "Studio port is owned by a foreground or otherwise unmanaged Runtime; it was not stopped",
      { url: STUDIO_SERVICE_URL, runtimeMode: health.reportedRuntimeMode ?? "foreground" },
    );
  }
  if (health.reportedRuntimeMode !== expectedMode) {
    throw new StudioServiceError(
      "service_port_conflict",
      `Studio reports runtimeMode=${health.reportedRuntimeMode ?? "missing"}; managed service requires ${expectedMode}`,
      { url: STUDIO_SERVICE_URL, runtimeMode: health.reportedRuntimeMode ?? null },
    );
  }
  if (health.reportedPid !== launchd.pid) {
    throw new StudioServiceError(
      "service_port_conflict",
      "Studio health PID does not match the managed service PID; no process was stopped",
      { url: STUDIO_SERVICE_URL, healthPid: health.reportedPid, launchdPid: launchd.pid },
    );
  }
}

export function isProductProcessOwnedByManagedJob(
  launchd: ManagedJobStatus,
  health: HealthProbe,
  expectedMode: "launchd" | "windows-task" = "launchd",
): boolean {
  return health.reachable &&
    health.product === PRODUCT_NAME &&
    Boolean(health.productVersion) &&
    health.reportedPid !== null &&
    health.reportedPid === launchd.pid &&
    health.reportedRuntimeMode === expectedMode &&
    Boolean(health.studioBuildId) &&
    launchd.loaded &&
    launchd.pid !== null;
}

function assertPortAvailableOrManagedJobLoaded(
  launchd: LaunchdStatus,
  health: HealthProbe,
): void {
  // A loaded label is not proof of port ownership: the job may be crash-looping
  // while an unrelated process owns 5190. Only an exact Product health PID may
  // be restarted; every other occupied-port shape fails before launchctl writes.
  if (isProductProcessOwnedByManagedJob(launchd, health)) return;
  assertNoPortConflict(launchd, health);
}

export async function ensureServiceDirectories(paths: StudioServicePaths): Promise<void> {
  await mkdir(join(paths.dataDir, "logs"), { recursive: true });
}

export function compatibleIdentity(
  launchd: ManagedJobStatus,
  health: HealthProbe,
  expectedMode: "launchd" | "windows-task" = "launchd",
): StudioServiceIdentity | null {
  if (!health.reachable || health.product !== PRODUCT_NAME || !launchd.loaded || !launchd.pid) {
    return null;
  }
  if (health.productVersion !== PRODUCT_VERSION) return null;
  if (health.reportedRuntimeMode !== expectedMode) return null;
  if (health.reportedPid !== launchd.pid) return null;
  if (!health.studioBuildId) return null;
  return {
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    pid: launchd.pid,
    runtimeMode: expectedMode,
    studioBuildId: health.studioBuildId,
  };
}

async function inspectStatus(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  const [installed, configured, launchd, health] = await Promise.all([
    pathExists(paths.plistPath),
    launchAgentConfigurationCurrent(paths),
    launchdStatus(deps),
    probeHealth(deps),
  ]);
  let conflict: string | undefined;
  try {
    assertNoPortConflict(launchd, health);
  } catch (error) {
    conflict = error instanceof Error ? error.message : String(error);
  }
  const identity = compatibleIdentity(launchd, health);
  let state: StudioServiceStatus["state"];
  if (conflict) state = "conflict";
  else if (identity && configured) state = "running";
  else if (identity) state = "unhealthy";
  else if (!installed && !launchd.loaded) state = "uninstalled";
  else if (!launchd.loaded) state = "stopped";
  else if (!health.reachable && launchd.loaded) state = launchd.pid ? "starting" : "unhealthy";
  else state = "unhealthy";
  return {
    serviceApiVersion: SERVICE_API_VERSION,
    label: STUDIO_SERVICE_LABEL,
    state,
    installed,
    configured,
    loaded: launchd.loaded,
    ready: identity !== null && configured,
    healthy: identity !== null && configured,
    pid: launchd.pid,
    runtimeMode: identity?.runtimeMode ?? null,
    productVersion: identity?.productVersion ?? null,
    studioBuildId: identity?.studioBuildId ?? health.studioBuildId,
    url: STUDIO_SERVICE_URL,
    identity,
    paths,
    ...(conflict
      ? { detail: conflict }
      : identity && !configured
        ? { detail: "LaunchAgent configuration is missing or stale" }
        : {}),
  };
}

async function waitUntilReady(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
  previousPid: number | null = null,
): Promise<StudioServiceStatus> {
  const deadline = deps.now() + deps.readyTimeoutMs;
  let last = await inspectStatus(deps, paths);
  while ((!last.ready || (previousPid !== null && last.pid === previousPid)) && deps.now() < deadline) {
    if (last.state === "conflict") {
      const launchd = await launchdStatus(deps);
      const health = await probeHealth(deps);
      const managedTransition = previousPid !== null &&
        launchd.loaded && Boolean(launchd.pid) && launchd.pid !== previousPid &&
        health.reachable && health.product === PRODUCT_NAME &&
        health.reportedRuntimeMode === "launchd" &&
        health.reportedPid === previousPid;
      if (!managedTransition) assertNoPortConflict(launchd, health);
    }
    await deps.sleep(100);
    last = await inspectStatus(deps, paths);
  }
  if (!last.ready || (previousPid !== null && last.pid === previousPid)) {
    throw new StudioServiceError(
      "service_unavailable",
      `Studio service did not become ready within ${deps.readyTimeoutMs}ms`,
      {
        state: last.state,
        url: last.url,
        previousPid,
        observedPid: last.pid,
        stderrLogPath: paths.stderrLogPath,
      },
    );
  }
  return last;
}

async function waitUntilUnloaded(
  deps: ResolvedServiceDependencies,
  previousPid: number | null,
): Promise<void> {
  const deadline = deps.now() + Math.min(10_000, deps.readyTimeoutMs);
  for (;;) {
    const [launchd, health] = await Promise.all([launchdStatus(deps), probeHealth(deps)]);
    const previousProcessStillServing = previousPid !== null && health.reachable &&
      health.product === PRODUCT_NAME && health.reportedPid === previousPid;
    const previousProcessStillAlive = previousPid !== null && deps.isProcessAlive(previousPid);
    if (!launchd.loaded && !previousProcessStillServing && !previousProcessStillAlive) return;
    if (deps.now() >= deadline) {
      throw new StudioServiceError(
        "service_unavailable",
        "Studio service did not finish stopping before the lifecycle timeout",
        { label: STUDIO_SERVICE_LABEL, previousPid },
      );
    }
    await deps.sleep(100);
  }
}

async function runLaunchctlOrThrow(
  deps: ResolvedServiceDependencies,
  args: readonly string[],
  operation: string,
): Promise<void> {
  const result = await deps.runCommand("/bin/launchctl", args);
  if (result.code !== 0) {
    throw new StudioServiceError(
      "service_unavailable",
      `launchctl ${operation} failed`,
      { args, code: result.code, stderr: result.stderr.trim().slice(0, 2_000) },
    );
  }
}

async function startUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  if (!(await pathExists(paths.plistPath))) {
    throw new StudioServiceError(
      "service_not_installed",
      "Studio service is not installed; run service install or service ensure",
      { plistPath: paths.plistPath },
    );
  }
  await requireLauncher(paths);
  await ensureServiceDirectories(paths);
  const launchd = await launchdStatus(deps);
  const health = await probeHealth(deps);
  assertPortAvailableOrManagedJobLoaded(launchd, health);
  if (compatibleIdentity(launchd, health)) return inspectStatus(deps, paths);

  await runLaunchctlOrThrow(deps, ["enable", launchdTarget(deps)], "enable");
  if (!launchd.loaded) {
    await runLaunchctlOrThrow(
      deps,
      ["bootstrap", launchdDomain(deps), paths.plistPath],
      "bootstrap",
    );
  } else {
    await runLaunchctlOrThrow(deps, ["kickstart", "-k", launchdTarget(deps)], "kickstart");
  }
  return waitUntilReady(deps, paths, launchd.loaded ? launchd.pid : null);
}

async function installUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  await requireLauncher(paths);
  await ensureServiceDirectories(paths);
  const launchd = await launchdStatus(deps);
  const health = await probeHealth(deps);
  assertPortAvailableOrManagedJobLoaded(launchd, health);

  await atomicWrite(paths.plistPath, renderStudioLaunchAgent(paths), 0o600);
  await runLaunchctlOrThrow(deps, ["enable", launchdTarget(deps)], "enable");
  if (launchd.loaded) {
    await runLaunchctlOrThrow(deps, ["bootout", launchdTarget(deps)], "bootout");
    await waitUntilUnloaded(deps, launchd.pid);
  }
  await runLaunchctlOrThrow(
    deps,
    ["bootstrap", launchdDomain(deps), paths.plistPath],
    "bootstrap",
  );
  return waitUntilReady(deps, paths);
}

async function stopUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  const launchd = await launchdStatus(deps);
  await runLaunchctlOrThrow(deps, ["disable", launchdTarget(deps)], "disable");
  if (launchd.loaded) {
    await runLaunchctlOrThrow(deps, ["bootout", launchdTarget(deps)], "bootout");
    await waitUntilUnloaded(deps, launchd.pid);
  }
  const status = await inspectStatus(deps, paths);
  if (status.loaded) {
    throw new StudioServiceError("service_unavailable", "Studio service remained loaded after stop", {
      label: STUDIO_SERVICE_LABEL,
    });
  }
  return status;
}

async function restartUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  if (!(await pathExists(paths.plistPath))) {
    throw new StudioServiceError("service_not_installed", "Studio service is not installed", {
      plistPath: paths.plistPath,
    });
  }
  await requireLauncher(paths);
  await ensureServiceDirectories(paths);
  const launchd = await launchdStatus(deps);
  assertPortAvailableOrManagedJobLoaded(launchd, await probeHealth(deps));
  await runLaunchctlOrThrow(deps, ["enable", launchdTarget(deps)], "enable");
  if (launchd.loaded) {
    await runLaunchctlOrThrow(deps, ["kickstart", "-k", launchdTarget(deps)], "kickstart");
  } else {
    await runLaunchctlOrThrow(
      deps,
      ["bootstrap", launchdDomain(deps), paths.plistPath],
      "bootstrap",
    );
  }
  return waitUntilReady(deps, paths, launchd.loaded ? launchd.pid : null);
}

async function ensureUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<{ status: StudioServiceStatus; changed: boolean }> {
  const before = await inspectStatus(deps, paths);
  const configurationCurrent = await launchAgentConfigurationCurrent(paths);
  if (before.state === "conflict") {
    const launchd = await launchdStatus(deps);
    const health = await probeHealth(deps);
    const staleOwnedConfiguration = !configurationCurrent &&
      isProductProcessOwnedByManagedJob(launchd, health);
    if (!staleOwnedConfiguration) assertPortAvailableOrManagedJobLoaded(launchd, health);
  }
  if (!configurationCurrent) {
    return { status: await installUnlocked(deps, paths), changed: true };
  }
  if (before.ready) return { status: before, changed: false };
  if (!before.installed) {
    return { status: await installUnlocked(deps, paths), changed: true };
  }
  if (!before.loaded) {
    return { status: await startUnlocked(deps, paths), changed: true };
  }
  return { status: await restartUnlocked(deps, paths), changed: true };
}

export async function acquireServiceLock(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<() => Promise<void>> {
  await mkdir(paths.dataDir, { recursive: true });
  const deadline = deps.now() + deps.lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(paths.operationLockPath);
      try {
        await atomicWrite(
          join(paths.operationLockPath, "owner.json"),
          `${JSON.stringify({ pid: deps.pid, acquiredAt: deps.now() })}\n`,
          0o600,
        );
      } catch (error) {
        await rm(paths.operationLockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        await rm(paths.operationLockPath, { recursive: true, force: true });
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "EEXIST") throw error;
    }

    let stale = false;
    try {
      const [lockStat, raw] = await Promise.all([
        stat(paths.operationLockPath),
        readFile(join(paths.operationLockPath, "owner.json"), "utf8").catch(() => "{}"),
      ]);
      const owner = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown };
      const ownerPid = typeof owner.pid === "number" ? owner.pid : null;
      const acquiredAt = typeof owner.acquiredAt === "number"
        ? owner.acquiredAt
        : lockStat.mtimeMs;
      stale = ownerPid === null
        ? deps.now() - acquiredAt > STALE_LOCK_MS
        : !deps.isProcessAlive(ownerPid);
    } catch {
      stale = false;
    }

    if (stale) {
      const stalePath = `${paths.operationLockPath}.stale.${randomUUID()}`;
      try {
        await rename(paths.operationLockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
        continue;
      } catch {
        // Another process recovered or replaced the stale lock first.
      }
    }
    if (deps.now() >= deadline) {
      throw new StudioServiceError(
        "service_busy",
        "Another chengfeng-videocut process is changing the Studio service",
        { lockPath: paths.operationLockPath, timeoutMs: deps.lockTimeoutMs },
      );
    }
    await deps.sleep(100);
  }
}

export async function readTail(path: string, requestedLines: number): Promise<string> {
  const lines = Math.min(MAX_LOG_LINES, Math.max(1, requestedLines));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const fileStat = await handle.stat();
    let position = fileStat.size;
    let accumulated = Buffer.alloc(0);
    while (position > 0 && accumulated.length < MAX_LOG_BYTES) {
      const size = Math.min(64 * 1024, position, MAX_LOG_BYTES - accumulated.length);
      position -= size;
      const chunk = Buffer.alloc(size);
      await handle.read(chunk, 0, size, position);
      accumulated = Buffer.concat([chunk, accumulated]);
      if (accumulated.toString("utf8").split("\n").length > lines) break;
    }
    const decoded = accumulated.toString("utf8").split("\n");
    if (decoded.at(-1) === "") decoded.pop();
    return decoded.slice(-lines).join("\n");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return "";
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function runStudioServiceCommand(
  action: StudioServiceAction,
  options: { lines?: number } = {},
  dependencies: StudioServiceDependencies = {},
): Promise<StudioServiceCommandResult> {
  const deps = resolveDependencies(dependencies);
  requireManagedPlatform(deps);
  const paths = studioServicePaths(deps.homeDir, deps.dataDir, deps.launcherPath, deps.platform);
  if (deps.platform === "win32") {
    // 动态引入避免 index/windows 循环依赖在模块初始化期互咬。
    const { runWindowsStudioServiceCommand } = await import("./windows");
    return runWindowsStudioServiceCommand(action, options, deps, paths);
  }
  if (action === "status") {
    return { action, changed: false, ...await inspectStatus(deps, paths) };
  }
  if (action === "logs") {
    const lines = Math.min(MAX_LOG_LINES, Math.max(1, options.lines ?? 200));
    const [status, stdout, stderr] = await Promise.all([
      inspectStatus(deps, paths),
      readTail(paths.stdoutLogPath, lines),
      readTail(paths.stderrLogPath, lines),
    ]);
    return { action, changed: false, ...status, logs: { lines, stdout, stderr } };
  }

  const release = await acquireServiceLock(deps, paths);
  try {
    if (action === "install") {
      const before = await inspectStatus(deps, paths);
      if (before.ready && await launchAgentConfigurationCurrent(paths)) {
        return { action, changed: false, ...before };
      }
      return { action, changed: true, ...await installUnlocked(deps, paths) };
    }
    if (action === "start") {
      const before = await inspectStatus(deps, paths);
      if (!(await launchAgentConfigurationCurrent(paths))) {
        return { action, changed: true, ...await installUnlocked(deps, paths) };
      }
      return { action, changed: !before.ready, ...await startUnlocked(deps, paths) };
    }
    if (action === "stop") {
      const before = await inspectStatus(deps, paths);
      return { action, changed: before.loaded, ...await stopUnlocked(deps, paths) };
    }
    if (action === "restart") {
      if (!(await launchAgentConfigurationCurrent(paths))) {
        return { action, changed: true, ...await installUnlocked(deps, paths) };
      }
      return { action, changed: true, ...await restartUnlocked(deps, paths) };
    }
    const ensured = await ensureUnlocked(deps, paths);
    return { action, changed: ensured.changed, ...ensured.status };
  } finally {
    await release();
  }
}

// `service supervise` is launched by the installed stable launcher rather than
// through `runStudioServiceCommand`. Keep its data-root resolution identical to
// every other service verb: in particular a Windows scheduled task must retain
// the root derived from CHENGFENG_VIDEOCUT_EXECUTABLE instead of silently
// falling back to the user's default directory.
export function resolveStudioServicePaths(
  dependencies: StudioServiceDependencies = {},
): StudioServicePaths {
  const deps = resolveDependencies(dependencies);
  return studioServicePaths(deps.homeDir, deps.dataDir, deps.launcherPath, deps.platform);
}
