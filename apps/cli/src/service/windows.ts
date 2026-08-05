import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PRODUCT_NAME } from "../output";
import {
  STUDIO_SERVICE_LABEL,
  STUDIO_SERVICE_URL,
  SERVICE_API_VERSION,
  StudioServiceError,
  acquireServiceLock,
  assertNoPortConflict,
  atomicWrite,
  compatibleIdentity,
  ensureServiceDirectories,
  isProductProcessOwnedByManagedJob,
  pathExists,
  probeHealth,
  readTail,
  requireLauncher,
  xmlEscape,
  type ManagedJobStatus,
  type ResolvedServiceDependencies,
  type StudioServiceAction,
  type StudioServiceCommandResult,
  type StudioServicePaths,
  type StudioServiceStatus,
} from "./index";

// Windows 托管形态：计划任务只负责「登录自启 + 脱离父进程」，崩溃重启由产品
// 自带的 supervisor（service supervise）完成——Task Scheduler 原生重启最小间隔
// 一分钟，远弱于 launchd 的 5 秒节流，所以看门狗必须自持。
export const WINDOWS_TASK_NAME = "chengfeng-videocut-studio";

// 任务的 UserId：工作组机器上 DOMAIN\user 形式会被拒（"No mapping between account
// names and security IDs"，2026-08-03 真机实测），SID 在域/工作组都成立。
function currentUserId(): string {
  const sid = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
    { encoding: "utf8" },
  );
  const value = (sid.stdout || "").trim();
  if (/^S-1-[0-9-]+$/.test(value)) return value;
  const name = process.env.USERNAME || process.env.USER || "";
  return name ? `${process.env.COMPUTERNAME || "."}\\${name}` : name;
}
const RESPAWN_THROTTLE_MS = 5_000;

const MAX_LOG_LINES = 1_000;

export interface SupervisorState {
  supervisorPid: number | null;
  serverPid: number | null;
  updatedAt: number | null;
}

export function windowsSupervisorStatePath(paths: StudioServicePaths): string {
  return join(paths.dataDir, "service", "supervisor.json");
}

export function renderStudioScheduledTask(paths: StudioServicePaths, userId = currentUserId()): string {
  // 声明必须与落盘编码一致：文件按 UTF-16LE+BOM 写（schtasks /XML 的要求），
  // 若这里仍写 UTF-8，解析器报「无法切换编码」——2026-08-03 真机实测。
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`${PRODUCT_NAME} Studio 常驻服务（${STUDIO_SERVICE_LABEL}）`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
${userId ? `      <UserId>${xmlEscape(userId)}</UserId>` : ""}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
${userId ? `      <UserId>${xmlEscape(userId)}</UserId>` : ""}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(paths.launcherPath)}</Command>
      <Arguments>service supervise</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

async function writeTaskDefinition(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, Buffer.from(`\ufeff${content}`, "utf16le"), { flag: "w", mode: 0o600 });
  await rename(temporary, path);
}

async function taskConfigurationCurrent(paths: StudioServicePaths): Promise<boolean> {
  try {
    return await readFile(paths.plistPath, "utf16le") === `\ufeff${renderStudioScheduledTask(paths)}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function readSupervisorState(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<SupervisorState> {
  try {
    const raw = JSON.parse(
      await readFile(windowsSupervisorStatePath(paths), "utf8"),
    ) as Record<string, unknown>;
    return {
      supervisorPid: typeof raw.supervisorPid === "number" ? raw.supervisorPid : null,
      serverPid: typeof raw.serverPid === "number" ? raw.serverPid : null,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
    };
  } catch {
    return { supervisorPid: null, serverPid: null, updatedAt: null };
  }
}

async function scheduledTaskStatus(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<ManagedJobStatus> {
  // /XML 输出的标签不随系统语言本地化；/FO CSV 的 Status 文案会（Running/正在运行），
  // 所以注册与启用状态只从 XML 判断，PID 只信 supervisor 状态文件 + 活性校验。
  const result = await deps.runCommand("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/XML"]);
  if (result.code !== 0) return { loaded: false, pid: null, raw: result.stderr || result.stdout };
  const raw = result.stdout;
  // 任务级 <Enabled> 在导出 XML 的 <Settings> 段（Triggers 之后）；
  // 触发器自己的 <Enabled> 在 Triggers 段内，不能混。
  const afterTriggers = raw.split("</Triggers>").pop() ?? raw;
  const disabled = /<Enabled>\s*false\s*<\/Enabled>/i.test(afterTriggers);
  const state = await readSupervisorState(deps, paths);
  const serverAlive = state.serverPid !== null && deps.isProcessAlive(state.serverPid);
  return {
    loaded: !disabled,
    pid: serverAlive ? state.serverPid : null,
    raw,
  };
}

async function runSchtasksOrThrow(
  deps: ResolvedServiceDependencies,
  args: readonly string[],
  operation: string,
): Promise<void> {
  const result = await deps.runCommand("schtasks", args);
  if (result.code !== 0) {
    throw new StudioServiceError(
      "service_unavailable",
      `schtasks ${operation} failed`,
      { args, code: result.code, stderr: (result.stderr || result.stdout).trim().slice(0, 2_000) },
    );
  }
}

async function inspectWindowsStatus(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  const [installed, configured, job, health] = await Promise.all([
    pathExists(paths.plistPath),
    taskConfigurationCurrent(paths),
    scheduledTaskStatus(deps, paths),
    probeHealth(deps),
  ]);
  let conflict: string | undefined;
  try {
    assertNoPortConflict(job, health, "windows-task");
  } catch (error) {
    conflict = error instanceof Error ? error.message : String(error);
  }
  const identity = compatibleIdentity(job, health, "windows-task");
  let state: StudioServiceStatus["state"];
  if (conflict) state = "conflict";
  else if (identity && configured) state = "running";
  else if (identity) state = "unhealthy";
  else if (!installed && !job.loaded) state = "uninstalled";
  else if (!job.loaded) state = "stopped";
  // 任务仍启用但进程不在、端口也没人应答 = 干净的停止态（stop 之后正是这样）；
  // 只有「有 PID 却答不上健康」才是真的不健康。2026-08-03 真机 stop 实测修正。
  else if (!health.reachable) state = job.pid ? "starting" : "stopped";
  else state = "unhealthy";
  return {
    serviceApiVersion: SERVICE_API_VERSION,
    label: STUDIO_SERVICE_LABEL,
    state,
    installed,
    configured,
    loaded: job.loaded,
    ready: identity !== null && configured,
    healthy: identity !== null && configured,
    pid: job.pid,
    runtimeMode: identity?.runtimeMode ?? null,
    productVersion: identity?.productVersion ?? null,
    studioBuildId: identity?.studioBuildId ?? health.studioBuildId,
    url: STUDIO_SERVICE_URL,
    identity,
    paths,
    ...(conflict
      ? { detail: conflict }
      : identity && !configured
        ? { detail: "Scheduled task configuration is missing or stale" }
        : {}),
  };
}

async function waitUntilWindowsReady(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
  previousPid: number | null = null,
): Promise<StudioServiceStatus> {
  const deadline = deps.now() + deps.readyTimeoutMs;
  let last = await inspectWindowsStatus(deps, paths);
  while ((!last.ready || (previousPid !== null && last.pid === previousPid)) && deps.now() < deadline) {
    await deps.sleep(100);
    last = await inspectWindowsStatus(deps, paths);
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

async function terminateSupervisedProcesses(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<void> {
  const state = await readSupervisorState(deps, paths);
  for (const pid of [state.serverPid, state.supervisorPid]) {
    if (pid !== null && deps.isProcessAlive(pid)) {
      try {
        deps.killProcess(pid);
      } catch {
        // Already exited between the aliveness check and the signal.
      }
    }
  }
  const deadline = deps.now() + Math.min(10_000, deps.readyTimeoutMs);
  for (;;) {
    const current = await readSupervisorState(deps, paths);
    const supervisorAlive = current.supervisorPid !== null &&
      deps.isProcessAlive(current.supervisorPid);
    const serverAlive = current.serverPid !== null && deps.isProcessAlive(current.serverPid);
    if (!supervisorAlive && !serverAlive) return;
    if (deps.now() >= deadline) {
      throw new StudioServiceError(
        "service_unavailable",
        "Studio service did not finish stopping before the lifecycle timeout",
        { label: STUDIO_SERVICE_LABEL, supervisorPid: current.supervisorPid, serverPid: current.serverPid },
      );
    }
    await deps.sleep(100);
  }
}

async function installWindowsUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  await requireLauncher(paths);
  await ensureServiceDirectories(paths);
  const job = await scheduledTaskStatus(deps, paths);
  const health = await probeHealth(deps);
  if (!isProductProcessOwnedByManagedJob(job, health, "windows-task")) {
    assertNoPortConflict(job, health, "windows-task");
  }

  // schtasks 的 /XML 解析器只接受 UTF-16LE + BOM 的任务定义（即便 XML 声明写着
  // UTF-8）；2026-08-03 Windows 真机首次点火实测：无 BOM 报「无法切换编码」。
  await writeTaskDefinition(paths.plistPath, renderStudioScheduledTask(paths));
  await runSchtasksOrThrow(
    deps,
    ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", paths.plistPath, "/F"],
    "create",
  );
  if (job.pid !== null || job.loaded) {
    await deps.runCommand("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
    await terminateSupervisedProcesses(deps, paths);
  }
  await runSchtasksOrThrow(deps, ["/Run", "/TN", WINDOWS_TASK_NAME], "run");
  return waitUntilWindowsReady(deps, paths);
}

async function startWindowsUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  if (!(await pathExists(paths.plistPath))) {
    throw new StudioServiceError(
      "service_not_installed",
      "Studio service is not installed; run service install or service ensure",
      { definitionPath: paths.plistPath },
    );
  }
  await requireLauncher(paths);
  await ensureServiceDirectories(paths);
  const job = await scheduledTaskStatus(deps, paths);
  const health = await probeHealth(deps);
  if (!isProductProcessOwnedByManagedJob(job, health, "windows-task")) {
    assertNoPortConflict(job, health, "windows-task");
  }
  if (compatibleIdentity(job, health, "windows-task")) return inspectWindowsStatus(deps, paths);

  await runSchtasksOrThrow(deps, ["/Change", "/TN", WINDOWS_TASK_NAME, "/ENABLE"], "enable");
  await runSchtasksOrThrow(deps, ["/Run", "/TN", WINDOWS_TASK_NAME], "run");
  return waitUntilWindowsReady(deps, paths, job.pid);
}

async function stopWindowsUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  const job = await scheduledTaskStatus(deps, paths);
  if (job.raw && (job.loaded || job.pid !== null)) {
    await runSchtasksOrThrow(deps, ["/Change", "/TN", WINDOWS_TASK_NAME, "/DISABLE"], "disable");
    await deps.runCommand("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
  }
  await terminateSupervisedProcesses(deps, paths);
  const status = await inspectWindowsStatus(deps, paths);
  if (status.pid !== null) {
    throw new StudioServiceError("service_unavailable", "Studio service remained running after stop", {
      label: STUDIO_SERVICE_LABEL,
    });
  }
  return status;
}

async function restartWindowsUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceStatus> {
  if (!(await pathExists(paths.plistPath))) {
    throw new StudioServiceError("service_not_installed", "Studio service is not installed", {
      definitionPath: paths.plistPath,
    });
  }
  await requireLauncher(paths);
  await ensureServiceDirectories(paths);
  const job = await scheduledTaskStatus(deps, paths);
  const health = await probeHealth(deps);
  if (!isProductProcessOwnedByManagedJob(job, health, "windows-task")) {
    assertNoPortConflict(job, health, "windows-task");
  }
  await runSchtasksOrThrow(deps, ["/Change", "/TN", WINDOWS_TASK_NAME, "/ENABLE"], "enable");
  if (job.pid !== null) {
    await deps.runCommand("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
    await terminateSupervisedProcesses(deps, paths);
  }
  await runSchtasksOrThrow(deps, ["/Run", "/TN", WINDOWS_TASK_NAME], "run");
  return waitUntilWindowsReady(deps, paths, job.pid);
}

async function ensureWindowsUnlocked(
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<{ status: StudioServiceStatus; changed: boolean }> {
  const before = await inspectWindowsStatus(deps, paths);
  const configurationCurrent = await taskConfigurationCurrent(paths);
  if (before.state === "conflict") {
    const job = await scheduledTaskStatus(deps, paths);
    const health = await probeHealth(deps);
    const staleOwnedConfiguration = !configurationCurrent &&
      isProductProcessOwnedByManagedJob(job, health, "windows-task");
    if (!staleOwnedConfiguration) assertNoPortConflict(job, health, "windows-task");
  }
  if (!configurationCurrent) {
    return { status: await installWindowsUnlocked(deps, paths), changed: true };
  }
  if (before.ready) return { status: before, changed: false };
  if (!before.installed) {
    return { status: await installWindowsUnlocked(deps, paths), changed: true };
  }
  return { status: await startWindowsUnlocked(deps, paths), changed: true };
}

export async function runWindowsStudioServiceCommand(
  action: StudioServiceAction,
  options: { lines?: number },
  deps: ResolvedServiceDependencies,
  paths: StudioServicePaths,
): Promise<StudioServiceCommandResult> {
  if (action === "status") {
    return { action, changed: false, ...await inspectWindowsStatus(deps, paths) };
  }
  if (action === "logs") {
    const lines = Math.min(MAX_LOG_LINES, Math.max(1, options.lines ?? 200));
    const [status, stdout, stderr] = await Promise.all([
      inspectWindowsStatus(deps, paths),
      readTail(paths.stdoutLogPath, lines),
      readTail(paths.stderrLogPath, lines),
    ]);
    return { action, changed: false, ...status, logs: { lines, stdout, stderr } };
  }

  const release = await acquireServiceLock(deps, paths);
  try {
    if (action === "install") {
      const before = await inspectWindowsStatus(deps, paths);
      if (before.ready && await taskConfigurationCurrent(paths)) {
        return { action, changed: false, ...before };
      }
      return { action, changed: true, ...await installWindowsUnlocked(deps, paths) };
    }
    if (action === "start") {
      const before = await inspectWindowsStatus(deps, paths);
      if (!(await taskConfigurationCurrent(paths))) {
        return { action, changed: true, ...await installWindowsUnlocked(deps, paths) };
      }
      return { action, changed: !before.ready, ...await startWindowsUnlocked(deps, paths) };
    }
    if (action === "stop") {
      const before = await inspectWindowsStatus(deps, paths);
      return {
        action,
        changed: before.loaded || before.pid !== null,
        ...await stopWindowsUnlocked(deps, paths),
      };
    }
    if (action === "restart") {
      if (!(await taskConfigurationCurrent(paths))) {
        return { action, changed: true, ...await installWindowsUnlocked(deps, paths) };
      }
      return { action, changed: true, ...await restartWindowsUnlocked(deps, paths) };
    }
    const ensured = await ensureWindowsUnlocked(deps, paths);
    return { action, changed: ensured.changed, ...ensured.status };
  } finally {
    await release();
  }
}

// 看门狗：直接以 bun 起 server 子进程（child.pid 即 health 报告的 PID），
// 崩溃 5 秒节流后重拉，日志追加到与 launchd 相同的文件，状态发布到
// supervisor.json 供 status/stop 交叉验证。任务结束（schtasks /End、注销）
// 或收到终止信号时退出。
export async function runStudioSupervisor(paths: StudioServicePaths): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("service supervise 仅用于 Windows 计划任务托管。\n");
    return 2;
  }
  const statePath = windowsSupervisorStatePath(paths);
  try {
    const previous = JSON.parse(await readFile(statePath, "utf8")) as { supervisorPid?: number };
    if (
      typeof previous.supervisorPid === "number" &&
      previous.supervisorPid !== process.pid
    ) {
      try {
        process.kill(previous.supervisorPid, 0);
        return 0; // 另一个看门狗还活着（IgnoreNew 的双保险），安静退出。
      } catch {
        // 前任已死，接管。
      }
    }
  } catch {
    // 没有状态文件即首启。
  }

  await mkdir(join(paths.dataDir, "logs"), { recursive: true });
  await mkdir(join(paths.dataDir, "service"), { recursive: true });
  const cliEntry = join(paths.dataDir, "app", "current", "cli.js");
  // `service supervise` 本身已由稳定启动器通过验证过的 Bun 启动。复用当前
  // execPath，避免再次扫描 PATH 时被陈旧的 bun.cmd shim 遮蔽原生 bun.exe。
  const bun = process.execPath;

  let stopping = false;
  let child: ReturnType<typeof spawn> | null = null;
  const publish = async (serverPid: number | null) => {
    await atomicWrite(
      statePath,
      `${JSON.stringify({ supervisorPid: process.pid, serverPid, updatedAt: Date.now() })}\n`,
      0o600,
    );
  };
  const shutdown = () => {
    stopping = true;
    if (child?.pid) {
      try {
        process.kill(child.pid);
      } catch {
        // Child already gone.
      }
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGBREAK", shutdown);

  for (;;) {
    const startedAt = Date.now();
    const stdoutFd = openSync(paths.stdoutLogPath, "a");
    const stderrFd = openSync(paths.stderrLogPath, "a");
    child = spawn(bun, [
      cliEntry,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      "5190",
      "--data-dir",
      paths.dataDir,
    ], {
      env: {
        ...process.env,
        CHENGFENG_VIDEOCUT_SERVICE: "windows-task",
        CHENGFENG_VIDEOCUT_HOME: paths.dataDir,
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    await publish(child.pid ?? null);
    const exitCode: number = await new Promise((resolveExit) => {
      child?.once("close", (code) => resolveExit(code ?? 1));
      child?.once("error", () => resolveExit(1));
    });
    await publish(null);
    if (stopping) return 0;
    process.stderr.write(
      `Studio server exited with code ${exitCode}; restarting in ${RESPAWN_THROTTLE_MS}ms\n`,
    );
    const elapsed = Date.now() - startedAt;
    if (elapsed < RESPAWN_THROTTLE_MS) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RESPAWN_THROTTLE_MS - elapsed));
    }
  }
}
