#!/usr/bin/env node
"use strict";

// chengfeng-videocut Runtime 安装器。
//
// 安装的事务边界只有 app/、bin/ 与 installer-state.json；projects/ 从不进入
// 事务。macOS 的 symlink rename 是原子的；Windows 的 junction 不能原地 replace，
// 所以 Windows 采用 journal + 可恢复的两次 rename，绝不把 remove+create 叫作原子。

const { createHash, randomUUID } = require("node:crypto");
const {
  copyFileSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  writeFileSync,
  chmodSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const REPOSITORY = "Agentchengfeng/chengfeng-videocut";
const VERSION = "0.4.8";
const ARCHIVE_NAME = "chengfeng-videocut-portable.tar.gz";
const CHECKSUM_NAME = "SHA256SUMS.txt";
const ARCHIVE_ROOT_NAME = `chengfeng-videocut-${VERSION}`;
const IS_WINDOWS = process.platform === "win32";
const STATE_SCHEMA_VERSION = 1;

const DOWNLOAD_BASE =
  process.env.CHENGFENG_VIDEOCUT_DOWNLOAD_BASE ||
  `https://github.com/${REPOSITORY}/releases/download/v${VERSION}`;
const INSTALL_ROOT =
  process.env.CHENGFENG_VIDEOCUT_HOME || path.join(os.homedir(), ".chengfeng-videocut");
const APP_ROOT = path.join(INSTALL_ROOT, "app");
const TOOLS_ROOT = path.join(INSTALL_ROOT, "tools");
const TOOLS_CURRENT_LINK = path.join(TOOLS_ROOT, "current");
const BIN_ROOT = path.join(INSTALL_ROOT, "bin");
const TARGET_DIR = path.join(APP_ROOT, VERSION);
const CURRENT_LINK = path.join(APP_ROOT, "current");
const BIN_LINK = path.join(BIN_ROOT, IS_WINDOWS ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
const STATE_PATH = path.join(INSTALL_ROOT, "installer-state.json");
const UPDATE_LOCK_PATH = path.join(INSTALL_ROOT, "runtime-update.lock");
const PENDING_ROOT = path.join(APP_ROOT, ".pending");
const SERVICE_HTTP_REQUEST_TIMEOUT_MS = positiveMilliseconds(
  process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_REQUEST_TIMEOUT_MS,
  5_000,
);
const SERVICE_VERIFICATION_BUDGET_MS = positiveMilliseconds(
  process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_BUDGET_MS,
  15_000,
);
const CANDIDATE_SELF_TEST_TIMEOUT_MS = positiveMilliseconds(
  process.env.CHENGFENG_VIDEOCUT_TEST_SELF_TEST_TIMEOUT_MS,
  10_000,
);
const BUN_VERSION_PROBE_TIMEOUT_MS = positiveMilliseconds(
  process.env.CHENGFENG_VIDEOCUT_TEST_BUN_VERSION_PROBE_TIMEOUT_MS,
  10_000,
);
const EXECUTABLE_OUTPUT_LIMIT_BYTES = positiveBytes(
  process.env.CHENGFENG_VIDEOCUT_TEST_EXECUTABLE_OUTPUT_LIMIT_BYTES,
  1_048_576,
);
const EXECUTABLE_DIAGNOSTIC_TAIL_BYTES = 65_536;
const EXECUTABLE_TERMINATION_GRACE_MS = 1_000;
// Electron can request one complete shared-Runtime transaction.  This remains
// an installer concern: Desktop only supplies the local Release payload and
// observes the resulting shared service.
const ENSURE_MANAGED_SERVICE = process.env.CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE === "1";
const MANAGED_TOOLS_DIR = process.env.CHENGFENG_VIDEOCUT_MANAGED_TOOLS_DIR || null;

function fail(message) {
  throw new Error(message);
}

function positiveMilliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60_000) : fallback;
}

function positiveBytes(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 4_096
    ? Math.min(parsed, 16 * 1_048_576)
    : fallback;
}

function pathExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isLink(candidate) {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isManagedPath(candidate, root = APP_ROOT) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertManagedPath(candidate, label, root = APP_ROOT) {
  if (!isManagedPath(candidate, root)) fail(`${label} 不在受管 app 目录内，安装已停止。`);
}

function canonicalPath(candidate) {
  return realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
}

function assertCanonicalInside(candidate, root, label) {
  const canonicalRoot = canonicalPath(root);
  const canonicalCandidate = canonicalPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (
    relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} 的真实路径逃出受管目录，安装已停止。`);
  }
  return canonicalCandidate;
}

function assertCanonicalManagedDirectory(candidate, label, root = APP_ROOT) {
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} 不是普通目录，安装已停止。`);
  }
  return assertCanonicalInside(candidate, root, label);
}

function removeLink(linkPath) {
  try {
    unlinkSync(linkPath);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EISDIR")) {
      rmdirSync(linkPath);
      return;
    }
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function removeTreeWithoutFollowingLinks(candidate) {
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    removeLink(candidate);
    return;
  }
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(candidate)) {
      removeTreeWithoutFollowingLinks(path.join(candidate, entry));
    }
    rmdirSync(candidate);
    return;
  }
  unlinkSync(candidate);
}

function removeManagedDirectory(directory) {
  assertManagedPath(directory, "候选目录");
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`候选目录不是受管的普通目录：${directory}`);
  }
  assertCanonicalInside(directory, APP_ROOT, "候选目录");
  removeTreeWithoutFollowingLinks(directory);
}

function maybeFailPersistence(phase, operation) {
  if (process.env.CHENGFENG_VIDEOCUT_TEST_FAIL_JOURNAL_AT === `${phase}:${operation}`) {
    const error = new Error(`TEST_FAIL_JOURNAL_AT=${phase}:${operation}`);
    error.code = "EIO";
    throw error;
  }
}

function flushDirectoryIfSupported(directory, phase) {
  if (IS_WINDOWS) return;
  let descriptor = null;
  try {
    descriptor = openSync(directory, "r");
    maybeFailPersistence(phase, "fsync_directory");
    fsyncSync(descriptor);
  } catch (error) {
    if (!error || !["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function atomicWriteJson(destination, value, phase = "unknown") {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  let descriptor = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    let written = 0;
    while (written < bytes.length) {
      maybeFailPersistence(phase, "write");
      const count = writeSync(descriptor, bytes, written, bytes.length - written, null);
      if (count <= 0) fail(`安装 journal 写入不完整：${destination}`);
      written += count;
    }
    maybeFailPersistence(phase, "fsync_temp");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    maybeFailPersistence(phase, "rename");
    renameSync(temporary, destination);

    // Windows 不能可靠 fsync 目录；至少在 rename 前 flush 临时文件，并在
    // rename 后重新打开目标文件 flush。POSIX 还会 flush 父目录元数据。
    // Windows 的 FlushFileBuffers 要求句柄带写权限；只读句柄会返回 EPERM。
    // r+ 不截断目标，并让 rename 后的文件内容得到真实 flush。
    descriptor = openSync(destination, "r+");
    maybeFailPersistence(phase, "fsync_destination");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    flushDirectoryIfSupported(path.dirname(destination), phase);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readCurrentTarget() {
  if (!pathExists(CURRENT_LINK)) return null;
  if (!isLink(CURRENT_LINK)) fail(`${CURRENT_LINK} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
  const rawTarget = readlinkSync(CURRENT_LINK);
  const target = path.resolve(path.dirname(CURRENT_LINK), rawTarget);
  assertManagedPath(target, "current 目标");
  assertCanonicalManagedDirectory(target, "current 目标");
  return target;
}

function readManagedToolsTarget() {
  if (!pathExists(TOOLS_CURRENT_LINK)) return null;
  if (!isLink(TOOLS_CURRENT_LINK)) fail(`${TOOLS_CURRENT_LINK} 已存在且不是链接；安装已停止。`);
  const target = path.resolve(path.dirname(TOOLS_CURRENT_LINK), readlinkSync(TOOLS_CURRENT_LINK));
  assertCanonicalManagedDirectory(target, "tools/current 目标", TOOLS_ROOT);
  return target;
}

function validateManagedToolsCandidate(candidate) {
  if (!candidate) return null;
  assertCanonicalManagedDirectory(candidate, "Desktop 候选工具", TOOLS_ROOT);
  if (path.dirname(path.resolve(candidate)) !== path.resolve(TOOLS_ROOT)) {
    fail("Desktop 候选工具必须是 tools/<version> 目录。");
  }
  const suffix = IS_WINDOWS ? ".exe" : "";
  for (const name of [`bun${suffix}`, `ffmpeg${suffix}`, `ffprobe${suffix}`]) {
    const item = path.join(candidate, name);
    if (!lstatSync(item).isFile()) fail(`Desktop 候选工具缺少 ${name}。`);
  }
  return path.resolve(candidate);
}

function runtimeRefFromPath(
  target,
  archiveSha256 = null,
  buildId = null,
  versionOverride = null,
  treeDigest = null,
) {
  assertManagedPath(target, "Runtime 目录");
  const version = versionOverride || path.basename(target);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Runtime 目录版本无效：${target}`);
  }
  return { version, path: target, archiveSha256, buildId, treeDigest };
}

function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    transactionId: null,
    phase: "idle",
    active: null,
    previous: null,
    pending: null,
    transaction: null,
    terminationFailure: null,
    updatedAt: new Date().toISOString(),
  };
}

function validateRuntimeRef(ref, label, { allowNull = false } = {}) {
  if (ref === null && allowNull) return;
  if (!ref || typeof ref !== "object" || typeof ref.version !== "string" || typeof ref.path !== "string") {
    fail(`安装 journal 的 ${label} 无效。`);
  }
  assertManagedPath(ref.path, `安装 journal 的 ${label}`);
  for (const field of ["archiveSha256", "buildId", "treeDigest"]) {
    if (
      ref[field] !== undefined && ref[field] !== null &&
      (typeof ref[field] !== "string" || !ref[field])
    ) {
      fail(`安装 journal 的 ${label}.${field} 无效。`);
    }
  }
  if (ref.archiveSha256 && !/^[0-9a-f]{64}$/.test(ref.archiveSha256)) {
    fail(`安装 journal 的 ${label}.archiveSha256 格式无效。`);
  }
  if (ref.buildId && !/^[0-9a-f]{16}$/.test(ref.buildId)) {
    fail(`安装 journal 的 ${label}.buildId 格式无效。`);
  }
  if (ref.treeDigest && !/^[0-9a-f]{64}$/.test(ref.treeDigest)) {
    fail(`安装 journal 的 ${label}.treeDigest 格式无效。`);
  }
}

function validateTerminationFailure(failure) {
  return Boolean(
    failure && typeof failure === "object" &&
    Number.isInteger(failure.rootPid) && failure.rootPid > 0 &&
    typeof failure.observedRootAlive === "boolean" &&
    typeof failure.duringPhase === "string" && failure.duringPhase &&
    typeof failure.failedAt === "string" && Number.isFinite(Date.parse(failure.failedAt)) &&
    ["taskkill", "process_group_sigkill"].includes(failure.method) &&
    typeof failure.detailCode === "string" && /^[0-9A-Za-z_]+$/.test(failure.detailCode) &&
    typeof failure.reasonCode === "string" && /^[0-9A-Za-z_]+$/.test(failure.reasonCode)
  );
}

function validateState(state) {
  if (!state || typeof state !== "object" || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    fail("安装 journal 版本未知；为避免覆盖现有 Runtime，安装已停止。");
  }
  if (typeof state.transactionId !== "string" && state.transactionId !== null) fail("安装 journal transactionId 无效。");
  if (typeof state.phase !== "string") fail("安装 journal phase 无效。");
  validateRuntimeRef(state.active, "active", { allowNull: true });
  validateRuntimeRef(state.previous, "previous", { allowNull: true });
  validateRuntimeRef(state.pending, "pending", { allowNull: true });
  if (["termination_failed", "rollback_failed"].includes(state.phase)) {
    if (
      state.phase === "termination_failed" && !validateTerminationFailure(state.terminationFailure)
    ) {
      fail("安装 journal 的 terminationFailure 无效；安装已停止。");
    }
    if (
      state.terminationFailure !== undefined && state.terminationFailure !== null &&
      !validateTerminationFailure(state.terminationFailure)
    ) {
      fail("安装 journal 的 terminationFailure 无效；安装已停止。");
    }
  } else if (
    state.terminationFailure !== undefined && state.terminationFailure !== null &&
    state.phase !== "rollback_failed"
  ) {
    fail("安装 journal 在非阻塞阶段包含 terminationFailure；安装已停止。");
  }
  return state;
}

function readState() {
  if (!pathExists(STATE_PATH)) {
    const current = readCurrentTarget();
    const state = emptyState();
    if (current) state.active = runtimeRefFromPath(current);
    return state;
  }
  try {
    return validateState(JSON.parse(readFileSync(STATE_PATH, "utf8")));
  } catch (error) {
    if (error instanceof Error) throw error;
    fail("安装 journal 无法解析；安装已停止。");
  }
}

function writeState(state) {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(STATE_PATH, state, state.phase);
}

function sameRuntime(left, right) {
  if (left === null || right === null) return left === right;
  return path.resolve(left.path) === path.resolve(right.path) && left.version === right.version;
}

function assertCurrentMatches(state) {
  const observed = readCurrentTarget();
  if (!sameRuntime(state.active, observed && runtimeRefFromPath(observed))) {
    fail("current 与安装 journal 不一致；可能有另一进程或手工操作，安装已停止。");
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === "ESRCH");
  }
}

function acquireUpdateLock() {
  mkdirSync(INSTALL_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(UPDATE_LOCK_PATH, { mode: 0o700 });
      const pauseMilliseconds = Number(process.env.CHENGFENG_VIDEOCUT_TEST_PAUSE_AFTER_LOCK_DIRECTORY_MS || 0);
      if (Number.isFinite(pauseMilliseconds) && pauseMilliseconds > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMilliseconds);
      }
      atomicWriteJson(path.join(UPDATE_LOCK_PATH, "owner.json"), {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        transactionId: randomUUID(),
      }, "lock_owner");
      return () => rmSync(UPDATE_LOCK_PATH, { recursive: true, force: true });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(readFileSync(path.join(UPDATE_LOCK_PATH, "owner.json"), "utf8"));
      } catch {
        fail("Runtime 更新锁尚未包含可验证 owner；为避免删除活锁，安装已停止。");
      }
      if (
        !owner || typeof owner !== "object" || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt)) ||
        typeof owner.transactionId !== "string" || !owner.transactionId
      ) {
        fail("Runtime 更新锁 owner 无效；不会删除无法证明已死亡的锁。");
      }
      if (processIsAlive(owner.pid)) {
        fail(`已有 Runtime 更新在执行（pid ${owner.pid}）；不会并发改写 current。`);
      }
      if (attempt === 0) {
        rmSync(UPDATE_LOCK_PATH, { recursive: true, force: true });
        continue;
      }
      fail("无法取得 Runtime 更新锁。");
    }
  }
  fail("无法取得 Runtime 更新锁。");
}

function findProgram(name) {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = IS_WINDOWS
    ? [".exe", ".cmd", ".bat", ""]
    : [""];
  for (const entry of entries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue with the next candidate.
      }
    }
  }
  return null;
}

function findBun() {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const isFile = (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (IS_WINDOWS) {
    for (const entry of entries) {
      const candidate = path.join(entry, "bun.exe");
      if (isFile(candidate)) return candidate;
    }
    const managed = path.join(os.homedir(), ".bun", "bin", "bun.exe");
    if (isFile(managed)) return managed;
    for (const entry of entries) {
      const candidate = path.join(entry, "bun.cmd");
      if (isFile(candidate)) return candidate;
    }
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(entry, "bun");
    if (isFile(candidate)) return candidate;
  }
  for (const candidate of [
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

async function assertSupportedBun(bunExecutable) {
  const probe = await runExecutable(bunExecutable, ["--version"], {
    timeout: BUN_VERSION_PROBE_TIMEOUT_MS,
  });
  if (probe.error || probe.status !== 0) fail(`无法验证 Bun 版本：${probeFailureDetail(probe)}`);
  const match = String(probe.stdout || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 2)) {
    fail(`需要 Bun 1.2 或更高版本，实际为 ${String(probe.stdout || "").trim() || "无法识别"}。`);
  }
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (/[\0\r\n"]/.test(text)) throw new Error("unsafe Windows command argument");
  return `"${text.replaceAll("%", "%%")}"`;
}

function forceTerminateProcessTree(child) {
  const rootPid = child.pid || null;
  if (!rootPid) {
    return Promise.resolve({
      confirmed: false,
      rootPid,
      method: IS_WINDOWS ? "taskkill" : "process_group_sigkill",
      detailCode: "missing_root_pid",
    });
  }
  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      let taskkill;
      let taskkillWatchdog = null;
      let settled = false;
      const settle = (confirmed, detailCode) => {
        if (settled) return;
        settled = true;
        if (taskkillWatchdog) clearTimeout(taskkillWatchdog);
        resolve({
          confirmed,
          rootPid,
          method: "taskkill",
          detailCode,
        });
      };
      try {
        taskkill = spawn(
          process.env.CHENGFENG_VIDEOCUT_TEST_TASKKILL_PATH ||
            path.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(rootPid), "/t", "/f"],
          { stdio: "ignore", windowsHide: true },
        );
      } catch (error) {
        settle(false, `taskkill_spawn_${error?.code || "error"}`);
        return;
      }
      taskkillWatchdog = setTimeout(() => {
        try {
          taskkill.kill("SIGKILL");
        } catch {
          // taskkill 本身也不得阻止安装器 settle。
        }
        settle(false, "taskkill_timeout");
      }, EXECUTABLE_TERMINATION_GRACE_MS);
      taskkill.once("close", (status) => {
        settle(status === 0, status === 0 ? "taskkill_exit_0" : `taskkill_exit_${status}`);
      });
      taskkill.once("error", (error) => {
        settle(false, `taskkill_error_${error?.code || "error"}`);
      });
    });
  }
  try {
    // timeout 子进程使用独立 process group；SIGKILL 不能被候选 CLI 捕获，
    // 同时清理它在自证期间创建的仍在前台等待的后代。
    process.kill(-rootPid, "SIGKILL");
    return Promise.resolve({
      confirmed: true,
      rootPid,
      method: "process_group_sigkill",
      detailCode: "process_group_sigkill_sent",
    });
  } catch (groupError) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 下面会把未确认终止传播给事务状态机。
    }
    return Promise.resolve({
      confirmed: false,
      rootPid,
      method: "process_group_sigkill",
      detailCode: `process_group_sigkill_${groupError?.code || "error"}`,
    });
  }
}

function appendDiagnosticTail(existing, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const combined = existing.length === 0 ? bytes : Buffer.concat([existing, bytes]);
  return combined.length <= EXECUTABLE_DIAGNOSTIC_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - EXECUTABLE_DIAGNOSTIC_TAIL_BYTES);
}

async function runExecutable(command, args, { env = process.env, cwd, timeout } = {}) {
  let executable = command;
  let executableArgs = args;
  let windowsVerbatimArguments = false;
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(command)) {
    const commandLine = `"${[quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ")}"`;
    executable = process.env.ComSpec || "cmd.exe";
    executableArgs = ["/d", "/v:off", "/s", "/c", commandLine];
    windowsVerbatimArguments = true;
  }
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, executableArgs, {
        env,
        cwd,
        windowsHide: true,
        windowsVerbatimArguments,
        detached: !IS_WINDOWS && Number.isFinite(timeout),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: "", stderr: "", error });
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let spawnError = null;
    let timer = null;
    let finished = false;
    let terminationRequested = false;
    let termination = null;
    let exitStatus = null;
    let exitSignal = null;
    const finish = (status = exitStatus, signal = exitSignal) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        error: spawnError,
        termination,
      });
    };
    const requestTermination = (error) => {
      if (!spawnError) spawnError = error;
      if (terminationRequested) return;
      terminationRequested = true;
      // 后代继承 pipe 且父进程已退出时，Windows 可能已失去可遍历的父 PID。
      // 主动关闭读取端，让 runner 有界返回；但只有 process-tree 终止被确认后，
      // 调用方才可把它当作普通失败清理事务。
      child.stdout.destroy();
      child.stderr.destroy();
      forceTerminateProcessTree(child).then((outcome) => {
        termination = outcome;
        if (!outcome.confirmed) {
          // fail-closed journal 会接管安全边界；不让仍存活的 Windows 根进程
          // 继续把 updater 本身的事件循环拖到候选自行退出。
          child.unref();
        }
        finish(exitStatus, exitSignal);
      });
    };
    const receiveOutput = (kind, chunk) => {
      if (finished) return;
      outputBytes += chunk.length;
      if (kind === "stdout") stdout = appendDiagnosticTail(stdout, chunk);
      else stderr = appendDiagnosticTail(stderr, chunk);
      if (outputBytes >= EXECUTABLE_OUTPUT_LIMIT_BYTES) {
        const error = new Error(`子进程输出达到 ${EXECUTABLE_OUTPUT_LIMIT_BYTES} bytes 上限`);
        error.code = "ENOBUFS";
        requestTermination(error);
      }
    };
    child.stdout.on("data", (chunk) => receiveOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => receiveOutput("stderr", chunk));
    child.on("error", (error) => { spawnError = error; });
    child.on("exit", (status, signal) => {
      exitStatus = status;
      exitSignal = signal;
    });
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        const error = new Error(`执行超过 ${timeout}ms`);
        error.code = "ETIMEDOUT";
        requestTermination(error);
      }, timeout);
    }
    child.on("close", (status, signal) => {
      exitStatus = status;
      exitSignal = signal;
      if (!terminationRequested) finish(status, signal);
    });
  });
}

function probeFailureDetail(probe) {
  const detail = [];
  if (probe.error) detail.push(`spawn=${probe.error.code || probe.error.message}`);
  if (probe.termination && probe.termination.confirmed === false) {
    detail.push(
      `tree_termination=unconfirmed(root_pid=${probe.termination.rootPid || "unknown"},method=${probe.termination.method},detail=${probe.termination.detailCode})`,
    );
  }
  if (probe.status !== null) detail.push(`exit=${probe.status}`);
  if (probe.signal) detail.push(`signal=${probe.signal}`);
  const stderr = String(probe.stderr || "").trim();
  if (stderr) detail.push(`stderr=${stderr.slice(-1200)}`);
  const stdout = String(probe.stdout || "").trim();
  if (stdout) detail.push(`stdout=${stdout.slice(-400)}`);
  return detail.join("; ") || "子进程没有返回可诊断信息";
}

function executableFailure(message, probe) {
  const error = new Error(`${message}：${probeFailureDetail(probe)}。`);
  if (probe.termination && probe.termination.confirmed === false) {
    error.code = "EPROCESSTREE";
    error.terminationFailure = {
      rootPid: probe.termination.rootPid,
      method: probe.termination.method,
      detailCode: probe.termination.detailCode,
      reasonCode: probe.error?.code || "unknown",
    };
  }
  return error;
}

function hasUnconfirmedProcessTree(error) {
  return Boolean(
    error && error.code === "EPROCESSTREE" &&
    error.terminationFailure && error.terminationFailure.rootPid,
  );
}

function terminationFailureMessage(failure) {
  const visibility = failure.observedRootAlive ? "仍可见" : "状态无法确认";
  return (
    `进程树终止未确认；Runtime 更新已进入 termination_failed 并阻止后续安装。` +
    `发生阶段 ${failure.duringPhase}，进程树根 PID ${failure.rootPid}（${visibility}），` +
    `记录时间 ${failure.failedAt}。请保留 installer-state.json；Windows 可先由管理员执行 ` +
    `"taskkill /PID ${failure.rootPid} /T /F"，再联系维护者完成明确恢复。本安装器不会自动清 journal 或重试。`
  );
}

function persistUnconfirmedTermination(state, error) {
  const duringPhase = state.phase;
  const details = error.terminationFailure;
  const failure = {
    rootPid: details.rootPid,
    observedRootAlive: processIsAlive(details.rootPid),
    duringPhase,
    failedAt: new Date().toISOString(),
    method: details.method,
    detailCode: details.detailCode,
    reasonCode: details.reasonCode,
  };
  state.terminationFailure = failure;
  if (state.phase !== "rollback_failed") state.phase = "termination_failed";
  writeState(state);
  return new Error(`${error.message} ${terminationFailureMessage(failure)}`);
}

function failIfTerminationRecoveryIsBlocked(state) {
  if (state.phase === "termination_failed") {
    fail(terminationFailureMessage(state.terminationFailure));
  }
}

function resolvedRuntimeEnvironment(bunExecutable, { launcher = null } = {}) {
  const toolDirectories = [path.dirname(path.resolve(bunExecutable))];
  for (const tool of [findProgram("ffmpeg"), findProgram("ffprobe")]) {
    if (tool) toolDirectories.push(path.dirname(path.resolve(tool)));
  }
  // 这些是操作系统命令目录，不是模糊地继承用户 PATH；service ensure 需要
  // launchctl/lsof 或 schtasks/netstat，而候选 self-test 仍只会看到明确目录。
  if (IS_WINDOWS) {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    toolDirectories.push(path.join(systemRoot, "System32"));
  } else {
    toolDirectories.push("/usr/bin", "/bin");
  }
  const deterministicPath = [...new Set(toolDirectories)].join(path.delimiter);
  return {
    ...process.env,
    PATH: deterministicPath,
    CHENGFENG_VIDEOCUT_HOME: INSTALL_ROOT,
    CHENGFENG_VIDEOCUT_DATA_DIR: INSTALL_ROOT,
    ...(launcher ? { CHENGFENG_VIDEOCUT_EXECUTABLE: launcher } : {}),
  };
}

async function download(url, destination) {
  if (url.startsWith("file://")) {
    copyFileSync(fileURLToPath(url), destination);
    return;
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500 * (attempt + 1)));
    }
  }
  fail(`下载失败 ${url}：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function expectedHashFor(checksumPath, assetName) {
  for (const line of readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runTar(args, cwd) {
  const result = spawnSync("tar", args, { encoding: "utf8", cwd });
  if (result.error) {
    fail("找不到 tar：macOS 系统自带；Windows 10 1803+ 系统自带（C\\\\Windows\\\\System32\\\\tar.exe）。");
  }
  return result;
}

function validateArchive(archivePath, checksumPath, tmpDir) {
  const expected = expectedHashFor(checksumPath, ARCHIVE_NAME);
  if (!expected) fail(`${CHECKSUM_NAME} 中没有 ${ARCHIVE_NAME} 的校验值。`);
  const actual = sha256(archivePath);
  if (actual !== expected) fail("SHA-256 校验失败；文件可能不完整，安装已停止。");

  const listing = runTar(["-tzf", ARCHIVE_NAME], tmpDir);
  if (listing.status !== 0) {
    fail(`安装包无法读取，安装已停止。tar 退出码 ${listing.status}：${String(listing.stderr || "").trim().slice(0, 300)}`);
  }
  for (const entry of String(listing.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (
      normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").some((part) => part === "..") ||
      (normalized !== ARCHIVE_ROOT_NAME && !normalized.startsWith(`${ARCHIVE_ROOT_NAME}/`))
    ) {
      fail("安装包包含不安全的路径，安装已停止。");
    }
  }
  const verbose = runTar(["-tvzf", ARCHIVE_NAME], tmpDir);
  if (verbose.status !== 0) {
    fail(`安装包类型清单无法读取，安装已停止。tar 退出码 ${verbose.status}。`);
  }
  for (const line of String(verbose.stdout || "").split(/\r?\n/).filter(Boolean)) {
    // bsdtar/GNU tar 的 verbose 首字符都是条目类型。只接受普通文件和目录；
    // symlink(l)、hardlink(h)、设备、FIFO 和其他特殊条目全部 fail-closed。
    if (line[0] !== "-" && line[0] !== "d") {
      fail(`安装包包含链接或特殊条目（${line[0] || "未知"}），安装已停止。`);
    }
  }
  const extraction = runTar(["-xzf", ARCHIVE_NAME], tmpDir);
  if (extraction.status !== 0) {
    fail(`安装包解压失败，安装已停止。tar 退出码 ${extraction.status}：${String(extraction.stderr || "").trim().slice(0, 300)}`);
  }
  return actual;
}

function validateRegularTree(root, container, label = "候选 Runtime") {
  assertCanonicalManagedDirectory(root, label, container);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const actual = path.join(directory, entry.name);
      const metadata = lstatSync(actual);
      if (metadata.isSymbolicLink()) fail(`${label} 包含链接 ${entry.name}；安装已停止。`);
      if (metadata.isDirectory()) {
        assertCanonicalInside(actual, root, label);
        walk(actual);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail(`${label} 包含 hardlink、reparse point 或特殊文件 ${entry.name}；安装已停止。`);
      }
      assertCanonicalInside(actual, root, label);
    }
  };
  walk(root);
}

function regularTreeDigest(root) {
  const digest = createHash("sha256");
  digest.update("chengfeng-videocut-regular-tree-v1\0");
  const walk = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = lstatSync(absolute);
      const permissions = (metadata.mode & 0o777).toString(8).padStart(3, "0");
      if (metadata.isDirectory()) {
        digest.update(`d\0${Buffer.byteLength(relative)}\0${relative}\0${permissions}\0`);
        walk(absolute, relative);
      } else if (metadata.isFile()) {
        digest.update(`f\0${Buffer.byteLength(relative)}\0${relative}\0${permissions}\0${metadata.size}\0`);
        digest.update(readFileSync(absolute));
      } else {
        fail(`Runtime 内容摘要遇到非普通条目 ${relative}。`);
      }
    }
  };
  walk(root);
  return digest.digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function studioBuildId(studioDir) {
  const digest = createHash("sha256");
  const walk = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile() && !relative.endsWith(".tsbuildinfo")) {
        digest.update(`/${relative}`);
        digest.update(readFileSync(absolute));
      }
    }
  };
  walk(studioDir);
  return digest.digest("hex").slice(0, 16);
}

function assertRequiredRegularFile(candidatePath, relativePath, label) {
  const assetPath = path.join(candidatePath, relativePath);
  let metadata;
  try {
    metadata = lstatSync(assetPath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      fail(`安装包缺少 ${label}。`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.nlink !== 1) {
    fail(`安装包的 ${label} 不是普通文件。`);
  }
  return assetPath;
}

function normalizeCandidatePermissions(candidatePath, container = path.dirname(candidatePath)) {
  // 权限归一化也是写操作，必须先证明候选是一棵不含链接/reparse 的普通树。
  validateRegularTree(candidatePath, container);
  const launcher = assertRequiredRegularFile(candidatePath, "chengfeng-videocut", "可执行启动器");
  if (!IS_WINDOWS) chmodSync(launcher, 0o755);
}

function validateCandidateLayout(candidatePath, container = path.dirname(candidatePath)) {
  validateRegularTree(candidatePath, container);
  for (const [relativePath, label] of [
    ["cli.js", "cli.js"],
    [path.join("studio", "index.html"), "Studio"],
    [path.join("studio", "chengfeng-videocut-capabilities.json"), "能力合同"],
    [path.join("legal", "LICENSE"), "许可证"],
    ["chengfeng-videocut", "可执行启动器"],
    ["VERSION", "版本信息"],
  ]) {
    assertRequiredRegularFile(candidatePath, relativePath, label);
  }
  if (!IS_WINDOWS && (lstatSync(path.join(candidatePath, "chengfeng-videocut")).mode & 0o111) === 0) {
    fail("安装包启动器缺少 POSIX 可执行位。");
  }
  const packagedVersion = readFileSync(path.join(candidatePath, "VERSION"), "utf8").split(/\r?\n/)[0];
  if (packagedVersion !== VERSION) fail("安装包版本与安装器不一致。");
  let capabilities;
  try {
    capabilities = JSON.parse(readFileSync(path.join(candidatePath, "studio", "chengfeng-videocut-capabilities.json"), "utf8"));
  } catch {
    fail("安装包能力合同不是合法 JSON。");
  }
  if (
    !capabilities || capabilities.schemaVersion !== 1 || capabilities.product !== "chengfeng-videocut" ||
    capabilities.studioVersion !== VERSION || !capabilities.features || typeof capabilities.features !== "object"
  ) {
    fail("安装包能力合同与当前 Runtime 版本不一致。");
  }
  return {
    capabilities,
    buildId: studioBuildId(path.join(candidatePath, "studio")),
    treeDigest: regularTreeDigest(candidatePath),
  };
}

async function selfTestCandidate(candidatePath, bunExecutable, expectedBuildId) {
  const environment = resolvedRuntimeEnvironment(bunExecutable);
  const probe = await runExecutable(bunExecutable, [path.join(candidatePath, "cli.js"), "--version"], {
    env: environment,
    cwd: candidatePath,
    timeout: CANDIDATE_SELF_TEST_TIMEOUT_MS,
  });
  if (probe.error || probe.status !== 0) {
    throw executableFailure("候选 Runtime 版本自证失败", probe);
  }
  const reportedVersion = String(probe.stdout || "").match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1];
  if (reportedVersion !== VERSION) {
    fail(`候选 Runtime 版本不一致：期望 ${VERSION}，实际 ${reportedVersion || "无法解析"}。`);
  }
  if (!/^[0-9a-f]{16}$/.test(expectedBuildId)) fail("候选 Studio build 标识无效。");
}

function createLink(linkPath, target, kind) {
  if (pathExists(linkPath)) fail(`内部错误：临时链接已存在 ${linkPath}`);
  symlinkSync(target, linkPath, kind);
}

function switchCurrent(target, transactionId) {
  assertManagedPath(target, "候选 Runtime");
  assertCanonicalManagedDirectory(target, "候选 Runtime");
  const nextLink = path.join(APP_ROOT, `.current.next.${transactionId}`);
  const backupLink = path.join(APP_ROOT, `.current.previous.${transactionId}`);
  if (pathExists(nextLink)) removeLink(nextLink);
  if (pathExists(backupLink)) removeLink(backupLink);
  if (IS_WINDOWS) {
    createLink(nextLink, path.resolve(target), "junction");
    // Windows Junction 不能 replace-in-place。这里是 journal 驱动的可恢复事务，
    // 而不是“原子切换”：任何中断都由 recoverInterruptedTransaction 恢复。
    try {
      if (pathExists(CURRENT_LINK)) renameSync(CURRENT_LINK, backupLink);
      renameSync(nextLink, CURRENT_LINK);
      if (pathExists(backupLink)) removeLink(backupLink);
    } catch (error) {
      try {
        if (!pathExists(CURRENT_LINK) && pathExists(backupLink)) renameSync(backupLink, CURRENT_LINK);
      } catch {
        // Journal recovery will retry from the durable phase.
      }
      throw error;
    } finally {
      if (pathExists(nextLink)) removeLink(nextLink);
    }
    return;
  }
  createLink(nextLink, path.relative(APP_ROOT, target), "dir");
  try {
    renameSync(nextLink, CURRENT_LINK);
  } finally {
    if (pathExists(nextLink)) removeLink(nextLink);
  }
}

function clearCurrentForFirstInstall(transactionId) {
  const nextLink = path.join(APP_ROOT, `.current.clear.${transactionId}`);
  if (!pathExists(CURRENT_LINK)) return;
  if (!isLink(CURRENT_LINK)) fail(`${CURRENT_LINK} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
  if (IS_WINDOWS) {
    renameSync(CURRENT_LINK, nextLink);
    removeLink(nextLink);
  } else {
    // POSIX rename of a fresh empty directory is not a replacement mechanism for
    // a link. unlink is safe here because the journal records active=null and
    // there is no old Runtime to preserve.
    removeLink(CURRENT_LINK);
  }
}

function switchManagedTools(target, transactionId, { injectFailure = true } = {}) {
  assertCanonicalManagedDirectory(target, "候选 Desktop 工具", TOOLS_ROOT);
  const next = path.join(TOOLS_ROOT, `.current.next.${transactionId}`);
  const backup = path.join(TOOLS_ROOT, `.current.previous.${transactionId}`);
  if (pathExists(next)) removeLink(next);
  if (pathExists(backup)) removeLink(backup);
  const maybeFailToolsPromotion = (phase) => {
    const configured = process.env.CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_PROMOTION;
    if (
      injectFailure && (
        (configured === "1" && phase === "before_backup") ||
        configured === phase
      )
    ) {
      fail(`TEST_FAIL_TOOLS_PROMOTION=${phase}`);
    }
  };
  if (IS_WINDOWS) {
    symlinkSync(path.resolve(target), next, "junction");
    try {
      maybeFailToolsPromotion("before_backup");
      if (pathExists(TOOLS_CURRENT_LINK)) renameSync(TOOLS_CURRENT_LINK, backup);
      maybeFailToolsPromotion("after_backup");
      renameSync(next, TOOLS_CURRENT_LINK);
      maybeFailToolsPromotion("after_current");
      if (pathExists(backup)) removeLink(backup);
    } catch (error) {
      try {
        if (!pathExists(TOOLS_CURRENT_LINK) && pathExists(backup)) renameSync(backup, TOOLS_CURRENT_LINK);
      } catch {
        // The durable installer journal will retry recovery on the next launch.
      }
      throw error;
    } finally {
      if (pathExists(next)) removeLink(next);
    }
    return;
  }
  symlinkSync(path.relative(TOOLS_ROOT, target), next, "dir");
  try {
    renameSync(next, TOOLS_CURRENT_LINK);
    maybeFailToolsPromotion("after_current");
  } finally {
    if (pathExists(next)) removeLink(next);
  }
}

function restoreManagedTools(previous, transactionId) {
  if (previous) return switchManagedTools(previous, transactionId, { injectFailure: false });
  if (pathExists(TOOLS_CURRENT_LINK)) removeLink(TOOLS_CURRENT_LINK);
}

function createLauncher() {
  if (IS_WINDOWS) {
    const launcher = `@echo off\r\nsetlocal\r\nset "CHENGFENG_VIDEOCUT_EXECUTABLE=%~f0"\r\nfor %%I in ("%~dp0..") do set "CHENGFENG_VIDEOCUT_DATA_DIR=%%~fI"\r\nset "APP_DIR=%~dp0..\\app\\current"\r\nset "MANAGED_TOOLS=%~dp0..\\tools\\current"\r\nif exist "%MANAGED_TOOLS%" set "PATH=%MANAGED_TOOLS%;%PATH%"\r\nset "BUN_EXE="\r\nif exist "%MANAGED_TOOLS%\\bun.exe" set "BUN_EXE=%MANAGED_TOOLS%\\bun.exe"\r\nfor /f "delims=" %%B in ('where bun.exe 2^>nul') do if not defined BUN_EXE set "BUN_EXE=%%~fB"\r\nif not defined BUN_EXE if exist "%USERPROFILE%\\.bun\\bin\\bun.exe" set "BUN_EXE=%USERPROFILE%\\.bun\\bin\\bun.exe"\r\nfor /f "delims=" %%B in ('where bun.cmd 2^>nul') do if not defined BUN_EXE set "BUN_EXE=%%~fB"\r\nif not defined BUN_EXE (\r\n  echo chengfeng-videocut 需要 Bun 1.2 或更高版本：https://bun.sh/docs/installation 1>&2\r\n  exit /b 127\r\n)\r\n"%BUN_EXE%" "%APP_DIR%\\cli.js" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    writeFileSync(BIN_LINK, launcher);
    return;
  }
  if (pathExists(BIN_LINK) && !isLink(BIN_LINK)) {
    fail(`${BIN_LINK} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
  }
  if (!pathExists(BIN_LINK)) symlinkSync(path.join("..", "app", "current", "chengfeng-videocut"), BIN_LINK, "file");
}

function captureLauncher() {
  if (!pathExists(BIN_LINK)) return { kind: "missing" };
  const metadata = lstatSync(BIN_LINK);
  if (metadata.isSymbolicLink()) return { kind: "link", target: readlinkSync(BIN_LINK) };
  if (IS_WINDOWS && metadata.isFile()) {
    return {
      kind: "file",
      contents: readFileSync(BIN_LINK).toString("base64"),
      mode: metadata.mode & 0o777,
    };
  }
  fail(`${BIN_LINK} 已存在且不是受管启动器；安装已停止。`);
}

function restoreLauncher(snapshot) {
  if (!snapshot || snapshot.kind === "missing") {
    removeLink(BIN_LINK);
    return;
  }
  removeLink(BIN_LINK);
  if (snapshot.kind === "link") {
    symlinkSync(snapshot.target, BIN_LINK, "file");
    return;
  }
  if (snapshot.kind === "file" && IS_WINDOWS) {
    writeFileSync(BIN_LINK, Buffer.from(snapshot.contents, "base64"), { mode: snapshot.mode });
    return;
  }
  fail("安装 journal 的启动器快照无效；安装已停止。");
}

function parseCliJson(result, command) {
  if (result.error || result.status !== 0) {
    throw executableFailure(`${command} 失败`, result);
  }
  try {
    const parsed = JSON.parse(String(result.stdout || ""));
    if (!parsed || parsed.ok !== true || !parsed.data || typeof parsed.data !== "object") {
      fail(`${command} 没有返回成功 JSON。`);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.message.includes(command)) throw error;
    fail(`${command} 返回了无法解析的 JSON。`);
  }
}

function runCliAt(runtime, bunExecutable, args, timeout) {
  return runExecutable(bunExecutable, [path.join(runtime.path, "cli.js"), ...args], {
    env: resolvedRuntimeEnvironment(bunExecutable, { launcher: BIN_LINK }),
    cwd: runtime.path,
    timeout,
  });
}

function assertServiceIdentity(service, { version, buildId = null, label }) {
  if (
    service.healthy !== true || service.ready !== true || service.productVersion !== version ||
    typeof service.studioBuildId !== "string" || !service.studioBuildId ||
    (buildId !== null && service.studioBuildId !== buildId) ||
    typeof service.url !== "string" || !Number.isInteger(service.pid) || service.pid <= 0 ||
    typeof service.runtimeMode !== "string" || !service.runtimeMode ||
    !service.identity || service.identity.product !== "chengfeng-videocut" ||
    service.identity.productVersion !== version || service.identity.pid !== service.pid ||
    service.identity.runtimeMode !== service.runtimeMode ||
    service.identity.studioBuildId !== service.studioBuildId
  ) {
    fail(`${label} 的 health/version/build/PID/identity 未通过自证。`);
  }
}

function createServiceVerificationBudget(label) {
  return {
    label,
    deadline: Date.now() + SERVICE_VERIFICATION_BUDGET_MS,
  };
}

function remainingServiceBudget(budget) {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) {
    fail(`${budget.label}超过 ${SERVICE_VERIFICATION_BUDGET_MS}ms 事务验证预算。`);
  }
  return Math.max(1, remaining);
}

function remainingServiceRequestTimeout(budget) {
  const remaining = remainingServiceBudget(budget);
  return Math.max(1, Math.min(SERVICE_HTTP_REQUEST_TIMEOUT_MS, remaining));
}

function serviceOrigin(service, label) {
  let parsed;
  try {
    parsed = new URL(service.url);
  } catch {
    fail(`${label}返回的服务 URL 无效。`);
  }
  if (
    parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
    parsed.username || parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search || parsed.hash
  ) {
    fail(`${label}返回的服务 URL 不是规范的本机 HTTP origin。`);
  }
  return parsed.origin;
}

async function readServiceJson(service, pathname, label, budget) {
  const timeoutMilliseconds = remainingServiceRequestTimeout(budget);
  let response;
  try {
    response = await fetch(`${serviceOrigin(service, label)}${pathname}`, {
      headers: { "Cache-Control": "no-store" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error) {
    const timedOut = error && (
      error.name === "TimeoutError" || error.name === "AbortError" ||
      String(error.message || "").toLowerCase().includes("timeout")
    );
    fail(
      `${label}${pathname} 读取失败：${timedOut ? `超过 ${timeoutMilliseconds}ms` : error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) fail(`${label}${pathname} 读取失败：HTTP ${response.status}`);
  let observed;
  try {
    observed = await response.json();
  } catch {
    fail(`${label}${pathname} 不是 JSON。`);
  }
  if (Date.now() > budget.deadline) {
    fail(`${budget.label}超过 ${SERVICE_VERIFICATION_BUDGET_MS}ms 事务验证预算。`);
  }
  return observed;
}

async function readServiceCapabilities(service, expectedVersion, label, budget) {
  const observed = await readServiceJson(
    service,
    "/chengfeng-videocut-capabilities.json",
    label,
    budget,
  );
  if (
    !observed || observed.schemaVersion !== 1 || observed.product !== "chengfeng-videocut" ||
    observed.studioVersion !== expectedVersion || !observed.features || typeof observed.features !== "object"
  ) {
    fail(`${label}能力合同身份不匹配。`);
  }
  return observed;
}

async function readServiceHealth(service, expected, label, budget) {
  const observed = await readServiceJson(service, "/api/health", label, budget);
  if (
    !observed || observed.schemaVersion !== 1 || observed.ok !== true ||
    observed.product !== "chengfeng-videocut" ||
    observed.productVersion !== expected.version ||
    observed.studioBuildId !== expected.buildId ||
    observed.pid !== expected.pid ||
    observed.runtimeMode !== expected.runtimeMode
  ) {
    fail(`${label}实际端口的 version/build/PID/runtimeMode 身份不匹配。`);
  }
}

async function inspectManagedService(active, bunExecutable) {
  if (!active) return null;
  const budget = createServiceVerificationBudget("旧 Runtime 服务验证");
  const service = parseCliJson(
    await runCliAt(
      active,
      bunExecutable,
      ["service", "status", "--json"],
      remainingServiceBudget(budget),
    ),
    "旧 Runtime service status",
  );
  if (!service.installed && !service.loaded && !service.configured) return null;
  assertServiceIdentity(service, {
    version: active.version,
    buildId: active.buildId || null,
    label: "旧 Runtime 服务",
  });
  await readServiceHealth(service, {
    version: active.version,
    buildId: service.studioBuildId,
    pid: service.pid,
    runtimeMode: service.runtimeMode,
  }, "旧 Runtime 服务", budget);
  return {
    productVersion: service.productVersion,
    studioBuildId: service.studioBuildId,
    runtimeMode: service.runtimeMode,
    pid: service.pid,
    capabilities: await readServiceCapabilities(service, active.version, "旧 Runtime 服务", budget),
  };
}

async function verifyManagedService(
  candidate,
  bunExecutable,
  expectedCapabilities,
  expectedBuildId,
  onEnsureSucceeded = null,
) {
  const budget = createServiceVerificationBudget("新 Runtime 服务验证");
  const service = parseCliJson(
    await runCliAt(
      candidate,
      bunExecutable,
      ["service", "ensure", "--json"],
      remainingServiceBudget(budget),
    ),
    "新 Runtime service ensure",
  );
  if (onEnsureSucceeded) onEnsureSucceeded();
  assertServiceIdentity(service, {
    version: VERSION,
    buildId: expectedBuildId,
    label: "新 Runtime 服务",
  });
  await readServiceHealth(service, {
    version: VERSION,
    buildId: expectedBuildId,
    pid: service.pid,
    runtimeMode: service.runtimeMode,
  }, "新 Runtime 服务", budget);
  const observed = await readServiceCapabilities(service, VERSION, "新 Runtime 服务", budget);
  if (stableJson(observed) !== stableJson(expectedCapabilities)) {
    fail("新 Runtime 服务返回的能力合同与候选包不一致。");
  }
}

async function stopCandidateService(candidate, bunExecutable) {
  const budget = createServiceVerificationBudget("候选 Runtime 服务清理");
  parseCliJson(
    await runCliAt(
      candidate,
      bunExecutable,
      ["service", "stop", "--json"],
      remainingServiceBudget(budget),
    ),
    "候选 Runtime service stop",
  );
}

async function restoreService(previous, bunExecutable, serviceBefore) {
  if (!previous) return;
  const budget = createServiceVerificationBudget("回滚 Runtime 服务验证");
  const restored = parseCliJson(
    await runCliAt(
      previous,
      bunExecutable,
      ["service", "ensure", "--json"],
      remainingServiceBudget(budget),
    ),
    "回滚 Runtime service ensure",
  );
  assertServiceIdentity(restored, {
    version: previous.version,
    buildId: serviceBefore.studioBuildId,
    label: "回滚后的旧 Runtime 服务",
  });
  if (restored.runtimeMode !== serviceBefore.runtimeMode) {
    fail("回滚后的旧 Runtime 服务 runtimeMode 与切换前不一致。");
  }
  await readServiceHealth(restored, {
    version: previous.version,
    buildId: serviceBefore.studioBuildId,
    pid: restored.pid,
    runtimeMode: serviceBefore.runtimeMode,
  }, "回滚后的旧 Runtime 服务", budget);
  const capabilities = await readServiceCapabilities(
    restored,
    previous.version,
    "回滚后的旧 Runtime 服务",
    budget,
  );
  if (stableJson(capabilities) !== stableJson(serviceBefore.capabilities)) {
    fail("回滚后的旧 Runtime 服务能力合同与切换前不一致。");
  }
}

function setIdleFromRollback(state) {
  const old = state.transaction?.oldActive ?? state.previous;
  const oldPrevious = state.transaction?.oldPrevious ?? null;
  state.active = old;
  state.previous = oldPrevious;
  state.pending = null;
  state.phase = "idle";
  state.transactionId = null;
  state.transaction = null;
  state.terminationFailure = null;
  writeState(state);
}

async function rollbackActivatedTransaction(state, bunExecutable, { reason = "失败" } = {}) {
  const old = state.transaction?.oldActive ?? state.previous;
  const candidate = state.pending ?? state.active;
  state.phase = "rolling_back";
  writeState(state);
  try {
    if (old) switchCurrent(old.path, state.transactionId || randomUUID());
    else clearCurrentForFirstInstall(state.transactionId || randomUUID());
    if (state.transaction?.toolsCandidate || state.transaction?.toolsBefore) {
      restoreManagedTools(state.transaction?.toolsBefore || null, state.transactionId || randomUUID());
    }
    if (state.transaction?.candidateServiceMayExist && candidate) {
      await stopCandidateService(candidate, bunExecutable);
    }
    if (state.transaction?.serviceBefore) {
      await restoreService(old, bunExecutable, state.transaction.serviceBefore);
    }
    restoreLauncher(state.transaction?.launcherBefore);
    if (candidate && pathExists(candidate.path) && !sameRuntime(candidate, old)) removeManagedDirectory(candidate.path);
    setIdleFromRollback(state);
  } catch (error) {
    state.phase = "rollback_failed";
    state.rollbackError = error instanceof Error ? error.message : String(error);
    if (hasUnconfirmedProcessTree(error)) {
      const blocked = persistUnconfirmedTermination(state, error);
      throw new Error(`${reason}；自动回滚不完整。${blocked.message}`);
    }
    writeState(state);
    throw new Error(`${reason}；自动回滚不完整，已保留 journal：${state.rollbackError}`);
  }
}

async function activateSameVersionDesktopTools(state, bunExecutable, candidateInfo, managedTools) {
  const transactionId = randomUUID();
  state.pending = state.active;
  state.phase = "health_check";
  state.transactionId = transactionId;
  state.transaction = {
    oldActive: state.active,
    oldPrevious: state.previous,
    serviceBefore: null,
    candidateServiceMayExist: false,
    launcherBefore: captureLauncher(),
    toolsBefore: readManagedToolsTarget(),
    toolsCandidate: managedTools,
  };
  state.terminationFailure = null;
  writeState(state);
  try {
    // Even though app/current already names this verified Runtime, the stable
    // launcher and tools/current are still one Desktop-owned activation unit.
    createLauncher();
    state.transaction.serviceBefore = await inspectManagedService(state.active, bunExecutable);
    writeState(state);
    switchManagedTools(managedTools, transactionId);
    if (state.transaction.serviceBefore || ENSURE_MANAGED_SERVICE) {
      await verifyManagedService(
        state.active,
        bunExecutable,
        candidateInfo.capabilities,
        candidateInfo.buildId,
        () => {
          state.transaction.candidateServiceMayExist = true;
          writeState(state);
        },
      );
    }
  } catch (error) {
    if (hasUnconfirmedProcessTree(error)) throw error;
    await rollbackActivatedTransaction(state, bunExecutable, { reason: "同版本 Desktop 工具激活自证失败" });
    throw error;
  }
  state.pending = null;
  state.phase = "completed";
  writeState(state);
  state.phase = "idle";
  state.transactionId = null;
  state.transaction = null;
  state.terminationFailure = null;
  writeState(state);
}

async function recoverInterruptedTransaction(state, bunExecutable) {
  failIfTerminationRecoveryIsBlocked(state);
  if (state.phase === "idle") {
    assertCurrentMatches(state);
    return state;
  }
  if (state.phase === "completed") {
    state.phase = "idle";
    state.pending = null;
    state.transaction = null;
    state.transactionId = null;
    state.terminationFailure = null;
    writeState(state);
    assertCurrentMatches(state);
    return state;
  }
  if (state.phase === "rollback_failed") {
    fail("上一次 Runtime 更新回滚未完成；请保留 installer-state.json 并先诊断，安装不会覆盖它。");
  }
  if (["staged", "validated", "promoting", "switching"].includes(state.phase)) {
    const candidate = state.pending;
    if (state.active) switchCurrent(state.active.path, state.transactionId || randomUUID());
    else clearCurrentForFirstInstall(state.transactionId || randomUUID());
    if (candidate && pathExists(candidate.path) && !sameRuntime(candidate, state.active)) removeManagedDirectory(candidate.path);
    restoreLauncher(state.transaction?.launcherBefore);
    state.pending = null;
    state.phase = "idle";
    state.transaction = null;
    state.transactionId = null;
    state.terminationFailure = null;
    writeState(state);
    return state;
  }
  if (["health_check", "rolling_back"].includes(state.phase)) {
    await rollbackActivatedTransaction(state, bunExecutable, { reason: "检测到中断的 Runtime 更新" });
    return readState();
  }
  fail(`未知 Runtime 更新阶段 ${state.phase}；安装不会猜测恢复方式。`);
}

function maybeCrashAt(phase) {
  if (process.env.CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE === phase) {
    process.stderr.write(`TEST_CRASH_AT_PHASE=${phase}\n`);
    process.exit(86);
  }
}

async function main() {
  const bunExecutable = findBun();
  if (!bunExecutable) {
    const hint = IS_WINDOWS ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : "https://bun.sh/docs/installation";
    fail(`需要先安装 Bun 1.2 或更高版本：${hint}`);
  }
  await assertSupportedBun(bunExecutable);
  mkdirSync(APP_ROOT, { recursive: true });
  mkdirSync(BIN_ROOT, { recursive: true });
  // termination_failed 是人工诊断门禁。第二个安装器在取得或清理任何锁前
  // 就必须停下，不能把“原 updater 已退出”等同于“残余进程树已终止”。
  if (pathExists(STATE_PATH)) failIfTerminationRecoveryIsBlocked(readState());
  const releaseLock = acquireUpdateLock();
  let state = null;
  try {
    state = readState();
    state = await recoverInterruptedTransaction(state, bunExecutable);
    assertCurrentMatches(state);

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-"));
    try {
      const archivePath = path.join(tmpDir, ARCHIVE_NAME);
      const checksumPath = path.join(tmpDir, CHECKSUM_NAME);
      process.stdout.write(`正在下载 chengfeng-videocut ${VERSION}…\n`);
      await download(`${DOWNLOAD_BASE}/${ARCHIVE_NAME}`, archivePath);
      await download(`${DOWNLOAD_BASE}/${CHECKSUM_NAME}`, checksumPath);
      const archiveSha256 = validateArchive(archivePath, checksumPath, tmpDir);
      const extracted = path.join(tmpDir, `chengfeng-videocut-${VERSION}`);
      if (process.env.CHENGFENG_VIDEOCUT_TEST_REPLACE_EXTRACTED_ROOT_WITH_REPARSE) {
        removeTreeWithoutFollowingLinks(extracted);
        symlinkSync(
          process.env.CHENGFENG_VIDEOCUT_TEST_REPLACE_EXTRACTED_ROOT_WITH_REPARSE,
          extracted,
          IS_WINDOWS ? "junction" : "dir",
        );
      }
      normalizeCandidatePermissions(extracted, tmpDir);
      const candidateInfo = validateCandidateLayout(extracted);
      const managedTools = validateManagedToolsCandidate(MANAGED_TOOLS_DIR);

      if (state.active?.version === VERSION) {
        if (path.resolve(state.active.path) !== path.resolve(TARGET_DIR)) {
          fail("当前同版本 Runtime 不在受管版本目录；拒绝把任意 current 目标当作安装成功。");
        }
        if (!state.active.archiveSha256 || !state.active.buildId || !state.active.treeDigest) {
          fail("当前同版本 Runtime 缺少已验证的 archive/build/tree 身份；拒绝把版本号当作安装成功证明。");
        }
        if (state.active.archiveSha256 !== archiveSha256) {
          fail("同版本 Release 内容与已激活 Runtime 不同；拒绝原地覆盖。");
        }
        const activeInfo = validateCandidateLayout(state.active.path, APP_ROOT);
        if (
          activeInfo.buildId !== state.active.buildId ||
          activeInfo.buildId !== candidateInfo.buildId ||
          activeInfo.treeDigest !== state.active.treeDigest ||
          activeInfo.treeDigest !== candidateInfo.treeDigest ||
          stableJson(activeInfo.capabilities) !== stableJson(candidateInfo.capabilities)
        ) {
          fail("当前同版本 Runtime 的完整内容/build/能力身份与已验证 Release 不一致；拒绝继续。");
        }
        await selfTestCandidate(state.active.path, bunExecutable, state.active.buildId);
        if (managedTools) {
          await activateSameVersionDesktopTools(state, bunExecutable, candidateInfo, managedTools);
        } else if (ENSURE_MANAGED_SERVICE) {
          await verifyManagedService(
            state.active,
            bunExecutable,
            candidateInfo.capabilities,
            candidateInfo.buildId,
          );
        }
        process.stdout.write(`chengfeng-videocut ${VERSION} 已是当前 Runtime；未改写 current。\n`);
        return;
      }
      if (pathExists(TARGET_DIR)) {
        fail(`${TARGET_DIR} 已存在；拒绝覆盖未受本事务控制的版本目录。`);
      }

      const transactionId = randomUUID();
      const stagedRoot = path.join(PENDING_ROOT, transactionId);
      const stagedCandidate = path.join(stagedRoot, "app");
      assertManagedPath(stagedCandidate, "pending 候选目录");
      mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
      let stagedInfo;
      try {
        cpSync(extracted, stagedCandidate, { recursive: true, force: false });
        normalizeCandidatePermissions(stagedCandidate, stagedRoot);
        const stagedReparse = process.env.CHENGFENG_VIDEOCUT_TEST_ADD_STAGED_REPARSE;
        if (stagedReparse) {
          const target = stagedReparse === "self"
            ? stagedCandidate
            : stagedReparse === "inside"
              ? path.join(stagedCandidate, "studio")
              : stagedReparse;
          symlinkSync(
            target,
            path.join(stagedCandidate, ".test-reparse"),
            IS_WINDOWS ? "junction" : "dir",
          );
        }
        stagedInfo = validateCandidateLayout(stagedCandidate, stagedRoot);
        if (
          stagedInfo.buildId !== candidateInfo.buildId ||
          stagedInfo.treeDigest !== candidateInfo.treeDigest ||
          stableJson(stagedInfo.capabilities) !== stableJson(candidateInfo.capabilities)
        ) {
          fail("pending 候选的 build/能力身份在复制后发生变化，安装已停止。");
        }
      } catch (error) {
        removeTreeWithoutFollowingLinks(stagedRoot);
        throw error;
      }
      const candidate = runtimeRefFromPath(
        stagedCandidate,
        archiveSha256,
        stagedInfo.buildId,
        VERSION,
        stagedInfo.treeDigest,
      );
      state.transactionId = transactionId;
      state.phase = "staged";
      state.pending = candidate;
      state.transaction = {
        oldActive: state.active,
        oldPrevious: state.previous,
        serviceBefore: null,
        candidateServiceMayExist: false,
        launcherBefore: captureLauncher(),
        toolsBefore: managedTools ? readManagedToolsTarget() : null,
        toolsCandidate: managedTools,
      };
      state.terminationFailure = null;
      try {
        writeState(state);
      } catch (error) {
        removeTreeWithoutFollowingLinks(stagedRoot);
        throw error;
      }
      maybeCrashAt("staged");

      // 关键顺序：这里直接运行 pending/app/cli.js，绝不经 app/current 或 bin launcher。
      try {
        await selfTestCandidate(stagedCandidate, bunExecutable, candidateInfo.buildId);
      } catch (error) {
        if (hasUnconfirmedProcessTree(error)) throw error;
        // 候选还没有资格进入版本目录，更不能影响 current。失败当场删 pending，
        // journal 回到原 active，而不是等下一次安装碰运气恢复。
        removeManagedDirectory(stagedCandidate);
        removeTreeWithoutFollowingLinks(stagedRoot);
        state.pending = null;
        state.phase = "idle";
        state.transactionId = null;
        state.transaction = null;
        writeState(state);
        throw error;
      }
      state.phase = "validated";
      writeState(state);
      maybeCrashAt("validated");

      // 已验证后才把候选从 pending 提升到版本目录；同卷 rename 不跨盘。
      state.phase = "promoting";
      writeState(state);
      maybeCrashAt("promoting");
      renameSync(stagedCandidate, TARGET_DIR);
      rmdirSync(stagedRoot);
      candidate.path = TARGET_DIR;
      state.pending = candidate;
      try {
        normalizeCandidatePermissions(TARGET_DIR, APP_ROOT);
        const promotedInfo = validateCandidateLayout(TARGET_DIR, APP_ROOT);
        if (
          promotedInfo.buildId !== candidateInfo.buildId ||
          promotedInfo.treeDigest !== candidateInfo.treeDigest ||
          stableJson(promotedInfo.capabilities) !== stableJson(candidateInfo.capabilities)
        ) {
          fail("提升后的候选 Runtime 身份与已验证 pending 不一致，安装已停止。");
        }
      } catch (error) {
        if (pathExists(TARGET_DIR)) removeManagedDirectory(TARGET_DIR);
        state.pending = null;
        state.phase = "idle";
        state.transactionId = null;
        state.transaction = null;
        writeState(state);
        throw error;
      }
      writeState(state);

      try {
        createLauncher();
        state.transaction.serviceBefore = await inspectManagedService(state.active, bunExecutable);
      } catch (error) {
        if (hasUnconfirmedProcessTree(error)) throw error;
        // 目录已提升但 current 尚未改变的失败也必须当场清理，不把“等下次
        // 安装再恢复”当作正常返回路径。
        await recoverInterruptedTransaction(state, bunExecutable);
        throw error;
      }
      state.phase = "switching";
      writeState(state);
      maybeCrashAt("switching");
      switchCurrent(TARGET_DIR, transactionId);
      state.previous = state.active;
      state.active = candidate;
      state.phase = "health_check";
      writeState(state);
      maybeCrashAt("health_check");

      try {
        if (state.transaction.toolsCandidate) {
          switchManagedTools(state.transaction.toolsCandidate, transactionId);
        }
        if (state.transaction.serviceBefore || ENSURE_MANAGED_SERVICE) {
          await verifyManagedService(
            candidate,
            bunExecutable,
            candidateInfo.capabilities,
            candidateInfo.buildId,
            () => {
              state.transaction.candidateServiceMayExist = true;
              writeState(state);
            },
          );
        }
      } catch (error) {
        if (hasUnconfirmedProcessTree(error)) throw error;
        await rollbackActivatedTransaction(state, bunExecutable, { reason: "新 Runtime 服务自证失败" });
        throw error;
      }

      state.pending = null;
      state.phase = "completed";
      writeState(state);
      maybeCrashAt("completed");
      state.phase = "idle";
      state.transactionId = null;
      state.transaction = null;
      state.terminationFailure = null;
      writeState(state);
      process.stdout.write(`chengfeng-videocut ${VERSION} 已验证并激活。\n`);
      if (IS_WINDOWS) {
        process.stdout.write("Windows junction 切换采用 journal 可恢复事务；异常中断会在下次安装启动时恢复。\n");
      }
    } finally {
      removeTreeWithoutFollowingLinks(tmpDir);
    }
  } catch (error) {
    if (state && hasUnconfirmedProcessTree(error)) {
      throw persistUnconfirmedTermination(state, error);
    }
    throw error;
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
