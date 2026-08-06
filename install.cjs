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
const { fileURLToPath, pathToFileURL } = require("node:url");

const REPOSITORY = "Agentchengfeng/chengfeng-videocut";
const VERSION = "0.5.0";
const ARCHIVE_NAME = "chengfeng-videocut-portable.tar.gz";
const CHECKSUM_NAME = "SHA256SUMS.txt";
const INSTALL_MANIFEST_NAME = "chengfeng-videocut-install-manifest.json";
const EMBEDDED_PAYLOAD_MANIFEST_NAME = "chengfeng-videocut-installer-payload-manifest.json";
const EMBEDDED_PAYLOAD_CHECKSUM_NAME = "chengfeng-videocut-installer-payload-SHA256SUMS.txt";
const ARCHIVE_ROOT_NAME = `chengfeng-videocut-${VERSION}`;
const IS_WINDOWS = process.platform === "win32";
const STATE_SCHEMA_VERSION = 2;
const SMALL_MANIFEST_DOWNLOAD_LIMIT_BYTES = 1_048_576;
const RELEASE_ASSET_DOWNLOAD_LIMIT_BYTES = 4 * 1_073_741_824;

function parseInstallerArguments(argv) {
  const options = {
    manifest: null,
    targetRoot: null,
    checksumFile: null,
    json: false,
    ensureService: false,
    allowUnverifiedLocalFixture: false,
  };
  const valueOptions = new Set(["--manifest", "--target-root", "--checksum-file"]);
  const seen = new Set();
  let index = 0;
  // node install.cjs includes the script path; a compiled Bun executable does not.
  if (
    argv[0] && !argv[0].startsWith("--") &&
    /(?:^|[\\/])(?:install\.cjs|chengfeng-videocut-installer-[^/\\]+)$/.test(argv[0])
  ) index = 1;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`不接受多余位置参数：${argument}`);
    if (seen.has(argument)) fail(`安装器参数重复：${argument}`);
    seen.add(argument);
    if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} 需要一个值。`);
      if (argument === "--manifest") options.manifest = value;
      else if (argument === "--target-root") options.targetRoot = value;
      else options.checksumFile = value;
      index += 1;
      continue;
    }
    if (argument === "--json") options.json = true;
    else if (argument === "--ensure-service") options.ensureService = true;
    else if (argument === "--allow-unverified-local-fixture") options.allowUnverifiedLocalFixture = true;
    else fail(`未知安装器参数：${argument}`);
  }
  return options;
}

const INSTALLER_OPTIONS = parseInstallerArguments(process.argv.slice(1));

const DOWNLOAD_BASE =
  process.env.CHENGFENG_VIDEOCUT_DOWNLOAD_BASE ||
  `https://github.com/${REPOSITORY}/releases/download/v${VERSION}`;
const REQUESTED_INSTALL_ROOT =
  INSTALLER_OPTIONS.targetRoot || process.env.CHENGFENG_VIDEOCUT_HOME ||
  path.join(os.homedir(), ".chengfeng-videocut");
if (!path.isAbsolute(REQUESTED_INSTALL_ROOT)) {
  fail("--target-root 必须是绝对路径。");
}
const INSTALL_ROOT = path.resolve(REQUESTED_INSTALL_ROOT);
const INSTALL_ROOT_RESOLVED = path.resolve(INSTALL_ROOT);
const HOME_RESOLVED = path.resolve(os.homedir());
const INSTALL_ROOT_COMPARABLE = comparablePath(INSTALL_ROOT_RESOLVED);
const HOME_COMPARABLE = comparablePath(HOME_RESOLVED);
if (
  INSTALL_ROOT_COMPARABLE === comparablePath(path.parse(INSTALL_ROOT_RESOLVED).root) ||
  INSTALL_ROOT_COMPARABLE === HOME_COMPARABLE ||
  HOME_COMPARABLE.startsWith(`${INSTALL_ROOT_COMPARABLE}${path.sep}`)
) {
  fail("--target-root 不得是文件系统根、用户 HOME 或 HOME 的祖先。");
}
assertSafeInstallRootPath(INSTALL_ROOT_RESOLVED);
const APP_ROOT = path.join(INSTALL_ROOT, "app");
const TOOLS_ROOT = path.join(INSTALL_ROOT, "tools");
const TOOLS_CURRENT_LINK = path.join(TOOLS_ROOT, "current");
const TOOLS_PENDING_ROOT = path.join(TOOLS_ROOT, ".pending");
const BIN_ROOT = path.join(INSTALL_ROOT, "bin");
const TARGET_DIR = path.join(APP_ROOT, VERSION);
const CURRENT_LINK = path.join(APP_ROOT, "current");
const BIN_LINK = path.join(BIN_ROOT, IS_WINDOWS ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
const STATE_PATH = path.join(INSTALL_ROOT, "installer-state.json");
const TOOLS_STATE_PATH = path.join(INSTALL_ROOT, "managed-tools-state.json");
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
// A caller can request one complete shared-Runtime transaction. This remains
// a Product installer concern: callers supply only verified Release inputs and
// observe the resulting shared service.
const ENSURE_MANAGED_SERVICE =
  INSTALLER_OPTIONS.ensureService ||
  process.env.CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE === "1";
const MANAGED_TOOLS_SOURCE_DIR = process.env.CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR || null;
const DEFAULT_PRODUCT_INSTALL_ROOT = path.resolve(HOME_RESOLVED, ".chengfeng-videocut");
const COMPILED_INSTALLER_VERSION =
  typeof CHENGFENG_COMPILED_INSTALLER_VERSION === "string"
    ? CHENGFENG_COMPILED_INSTALLER_VERSION
    : null;
const EMBEDDED_PAYLOAD_BUILD =
  typeof CHENGFENG_EMBEDDED_PAYLOAD_BUILD === "boolean" &&
  CHENGFENG_EMBEDDED_PAYLOAD_BUILD === true;
const ALLOW_UNVERIFIED_LOCAL_TOOLS =
  INSTALLER_OPTIONS.allowUnverifiedLocalFixture ||
  process.env.CHENGFENG_VIDEOCUT_ALLOW_UNVERIFIED_LOCAL_TOOLS === "1";
let candidateServiceStopAttempted = false;
let installerToolsDirectory = null;
let lockedInstallRootCanonical = null;
let heldUpdateLockOwner = null;
let lockOwnerWriteInProgress = false;

if (COMPILED_INSTALLER_VERSION && COMPILED_INSTALLER_VERSION !== VERSION) {
  fail(`编译安装器版本 ${COMPILED_INSTALLER_VERSION} 与 Runtime ${VERSION} 不一致。`);
}

// launchd / Task Scheduler and port 5190 are a single user-wide service.  A
// custom target root is useful for diagnostics and fixture installs, but it
// must never be able to replace that global service definition.  Production
// Plugin installs always target the user's canonical Product root.
function assertManagedServiceUsesDefaultRoot() {
  if (
    ENSURE_MANAGED_SERVICE &&
    INSTALL_ROOT_COMPARABLE !== comparablePath(DEFAULT_PRODUCT_INSTALL_ROOT)
  ) {
    fail("--ensure-service 只能用于当前用户的默认 Product Runtime 根目录；自定义 --target-root 不得接管全局 5190 / 用户级服务。");
  }
}

// The public installer is compiled from a generated ESM wrapper.  That wrapper
// statically embeds the already-verified Runtime and tools payload and sets this
// value immediately before importing this module.  Do not capture it at module
// load time: static ESM imports evaluate this CommonJS module before the wrapper
// gets to assign the global.
function embeddedPayload() {
  const value = globalThis.__CHENGFENG_VIDEOCUT_EMBEDDED_PAYLOAD__;
  if (!value || typeof value !== "object") return null;
  return value;
}

function externalInstallManifestSource() {
  return INSTALLER_OPTIONS.manifest || process.env.CHENGFENG_VIDEOCUT_INSTALL_MANIFEST ||
    (COMPILED_INSTALLER_VERSION ? `${DOWNLOAD_BASE}/${INSTALL_MANIFEST_NAME}` : null);
}

function externalInstallManifestChecksumSource() {
  return INSTALLER_OPTIONS.checksumFile || process.env.CHENGFENG_VIDEOCUT_MANIFEST_CHECKSUM_FILE || null;
}
function progress(message) {
  (INSTALLER_OPTIONS.json ? process.stderr : process.stdout).write(message);
}

function reportSuccess(status, assetDownloads, message) {
  if (INSTALLER_OPTIONS.json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      command: "runtime.install",
      ok: true,
      data: { status, productVersion: VERSION, targetRoot: INSTALL_ROOT, assetDownloads },
    })}\n`);
  } else {
    process.stdout.write(message);
  }
}

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

function comparablePath(candidate) {
  const resolved = path.resolve(candidate);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function assertSafeInstallRootPath(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      fail(`Product 受管安装根的已有路径组件不得是链接或 reparse point：${current}`);
    }
    if (!metadata.isDirectory()) {
      fail(`Product 受管安装根的已有路径组件不是目录：${current}`);
    }
    if (comparablePath(realpathSync(current)) !== comparablePath(current)) {
      fail(`Product 受管安装根的已有路径组件发生规范路径跳转：${current}`);
    }
  }
}

function isWithinOrEqual(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function assertPlainDirectory(candidate, label) {
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} 必须是非链接普通目录；安装已停止。`);
  }
  const canonical = canonicalPath(candidate);
  if (comparablePath(canonical) !== comparablePath(path.resolve(candidate))) {
    fail(`${label} 发生链接、reparse point 或规范路径跳转；安装已停止。`);
  }
  return canonical;
}

function assertSingleLinkRegularFile(candidate, label) {
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    fail(`${label} 必须是 single-link regular file；安装已停止。`);
  }
  return metadata;
}

function assertInstallRootLayout({ requireHeldLock = false } = {}) {
  assertSafeInstallRootPath(INSTALL_ROOT);
  if (!pathExists(INSTALL_ROOT)) fail("Product 受管安装根不存在；安装已停止。");
  const canonicalRoot = assertPlainDirectory(INSTALL_ROOT, "Product 受管安装根");
  if (
    lockedInstallRootCanonical !== null &&
    comparablePath(canonicalRoot) !== comparablePath(lockedInstallRootCanonical)
  ) {
    fail("Product 受管安装根在取得更新锁后发生身份变化；安装已停止。");
  }
  for (const [directory, label] of [
    [APP_ROOT, "Product app 目录"],
    [BIN_ROOT, "Product bin 目录"],
    [TOOLS_ROOT, "Product tools 目录"],
  ]) {
    if (pathExists(directory)) {
      assertPlainDirectory(directory, label);
      assertCanonicalInside(directory, INSTALL_ROOT, label);
    }
  }
  for (const [file, label] of [
    [STATE_PATH, "installer-state.json"],
    [TOOLS_STATE_PATH, "managed-tools-state.json"],
  ]) {
    if (pathExists(file)) assertSingleLinkRegularFile(file, label);
  }
  if (pathExists(UPDATE_LOCK_PATH)) {
    assertPlainDirectory(UPDATE_LOCK_PATH, "Runtime 更新锁");
    assertCanonicalInside(UPDATE_LOCK_PATH, INSTALL_ROOT, "Runtime 更新锁");
  } else if (requireHeldLock) {
    fail("Runtime 更新锁在写入期间消失；安装已停止。");
  }
  if (requireHeldLock && !heldUpdateLockOwner && !lockOwnerWriteInProgress) {
    fail("Runtime 更新锁没有本进程可验证的 owner；安装已停止。");
  }
  return canonicalRoot;
}

function assertManagedWriteBoundary(candidate, label, { allowDuringLockOwner = false } = {}) {
  if (!isWithinOrEqual(INSTALL_ROOT, candidate) || path.resolve(candidate) === INSTALL_ROOT) {
    fail(`${label} 不在 Product 受管安装根内；安装已停止。`);
  }
  if (!heldUpdateLockOwner && !(allowDuringLockOwner && lockOwnerWriteInProgress)) {
    fail(`${label} 写入发生在 Runtime 更新锁之外；安装已停止。`);
  }
  assertInstallRootLayout({ requireHeldLock: true });
  const parent = path.dirname(path.resolve(candidate));
  const relative = path.relative(INSTALL_ROOT, parent);
  let current = INSTALL_ROOT;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!pathExists(current)) fail(`${label} 的父目录不存在：${current}`);
    assertPlainDirectory(current, `${label} 的父目录`);
    assertCanonicalInside(current, INSTALL_ROOT, `${label} 的父目录`);
  }
}

function assertAtomicWriteDestination(destination) {
  if (!isWithinOrEqual(INSTALL_ROOT, destination)) return;
  const ownerPath = path.join(UPDATE_LOCK_PATH, "owner.json");
  const isLockOwner = path.resolve(destination) === path.resolve(ownerPath);
  assertManagedWriteBoundary(destination, `原子写入 ${destination}`, {
    allowDuringLockOwner: isLockOwner,
  });
  if (pathExists(destination)) assertSingleLinkRegularFile(destination, `原子写入目标 ${destination}`);
}

function ensureManagedDirectory(candidate, label, mode = 0o700) {
  assertManagedWriteBoundary(candidate, label);
  if (!pathExists(candidate)) mkdirSync(candidate, { mode });
  assertPlainDirectory(candidate, label);
  assertCanonicalInside(candidate, INSTALL_ROOT, label);
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
  assertManagedWriteBoundary(directory, "候选 Runtime 目录删除");
  assertManagedPath(directory, "候选目录");
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`候选目录不是受管的普通目录：${directory}`);
  }
  assertCanonicalInside(directory, APP_ROOT, "候选目录");
  removeTreeWithoutFollowingLinks(directory);
}

function removeManagedToolsDirectory(directory) {
  assertManagedWriteBoundary(directory, "候选工具目录删除");
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`工具候选目录不是受管的普通目录：${directory}`);
  }
  assertCanonicalInside(directory, TOOLS_ROOT, "工具候选目录");
  removeTreeWithoutFollowingLinks(directory);
}

function removeExpectedManagedTree(directory, expected, label) {
  assertExactManagedPath(directory, expected, label);
  assertManagedWriteBoundary(directory, label);
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} 不是受管普通目录；安装已停止。`);
  }
  assertCanonicalInside(directory, INSTALL_ROOT, label);
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
  assertAtomicWriteDestination(destination);
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
    assertAtomicWriteDestination(destination);
    renameSync(temporary, destination);

    // Windows 不能可靠 fsync 目录；至少在 rename 前 flush 临时文件，并在
    // rename 后重新打开目标文件 flush。POSIX 还会 flush 父目录元数据。
    // Windows 的 FlushFileBuffers 要求句柄带写权限；只读句柄会返回 EPERM。
    // r+ 不截断目标，并让 rename 后的文件内容得到真实 flush。
    assertAtomicWriteDestination(destination);
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

function validateExternalToolsSource(source, { allowManagedRoot = false } = {}) {
  if (!source) return null;
  const resolved = path.resolve(source);
  if (!allowManagedRoot && (resolved === INSTALL_ROOT || resolved.startsWith(`${INSTALL_ROOT}${path.sep}`))) {
    fail("Product 受管工具来源不得位于 Product 受管根；安装器只接受外部暂存目录。");
  }
  let sourceReal;
  try {
    if (!lstatSync(resolved).isDirectory() || isLink(resolved)) fail("Product 受管工具来源必须是非链接目录。");
    sourceReal = realpathSync(resolved);
  } catch (error) {
    if (error instanceof Error) throw error;
    fail("Product 受管工具来源无效。");
  }
  const manifestPath = path.join(resolved, "resources-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("工具来源的 resources-manifest.json 无效。");
  }
  if (manifest?.schemaVersion === 2) {
    validateRegularTree(resolved, path.dirname(resolved), "受管工具来源");
    if (
      manifest.product !== "chengfeng-videocut-managed-tools" ||
      manifest.productVersion !== VERSION ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      !manifest.executables || !manifest.versions || !Array.isArray(manifest.files)
    ) {
      fail("受管工具 manifest 与当前 Runtime/平台不一致。");
    }
    if (manifest.licenseStatus !== "VERIFIED" && !ALLOW_UNVERIFIED_LOCAL_TOOLS) {
      fail("受管工具许可状态不是 VERIFIED；公开安装已阻止。仅隔离工程 smoke 可显式允许 UNVERIFIED。");
    }
    const requiredKeys = ["bun", "ffmpeg", "ffprobe", "chrome"];
    for (const key of requiredKeys) {
      const relative = manifest.executables[key];
      if (
        typeof relative !== "string" || !relative || path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some((part) => part === "..")
      ) fail(`受管工具 manifest 的 ${key} 路径无效。`);
      const executable = path.join(resolved, relative);
      const metadata = lstatSync(executable);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        fail(`受管工具 ${key} 不是单链接普通文件。`);
      }
      assertCanonicalInside(executable, resolved, `受管工具 ${key}`);
      if (!IS_WINDOWS && (metadata.mode & 0o111) === 0) {
        fail(`受管工具 ${key} 缺少可执行位；已激活树不会被安装器静默修复。`);
      }
    }
    const actualFiles = new Map();
    const collect = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(absolute, relative);
        else if (entry.isFile() && relative !== "resources-manifest.json") {
          actualFiles.set(relative.replaceAll("\\", "/"), {
            size: lstatSync(absolute).size,
            sha256: sha256(absolute),
          });
        }
      }
    };
    collect(resolved);
    if (actualFiles.size !== manifest.files.length) fail("受管工具文件清单数量不一致。");
    for (const record of manifest.files) {
      const actual = record && actualFiles.get(record.path);
      if (!actual || actual.size !== record.size || actual.sha256 !== record.sha256) {
        fail(`受管工具文件校验失败：${record?.path || "未知"}`);
      }
    }
    return sourceReal;
  }
  const suffix = IS_WINDOWS ? ".exe" : "";
  const required = new Set([`bun${suffix}`, `ffmpeg${suffix}`, `ffprobe${suffix}`, "resources-manifest.json"]);
  const entries = readdirSync(resolved, { withFileTypes: true });
  if (entries.length !== required.size) fail("Product 受管工具来源只能包含 Bun、FFmpeg、FFprobe 和资源清单。");
  for (const entry of entries) {
    if (!required.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail("Product 受管工具来源包含非普通文件或未知条目。");
    }
  }
  for (const name of required) {
    if (!lstatSync(path.join(resolved, name)).isFile()) fail(`Product 受管工具来源缺少 ${name}。`);
  }
  return sourceReal;
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

function assertObjectKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`安装 journal 的 ${label}.${key} 不是已知字段。`);
  }
}

function assertExactManagedPath(actual, expected, label) {
  if (typeof actual !== "string" || path.resolve(actual) !== path.resolve(expected)) {
    fail(`安装 journal 的 ${label} 不是约定的受管路径。`);
  }
}

function safeTransactionId(value) {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(value);
}

function validateRuntimeRef(ref, label, { allowNull = false, allowPending = false, transactionId = null } = {}) {
  if (ref === null && allowNull) return;
  if (!ref || typeof ref !== "object" || typeof ref.version !== "string" || typeof ref.path !== "string") {
    fail(`安装 journal 的 ${label} 无效。`);
  }
  assertObjectKeys(
    ref,
    new Set(["version", "path", "archiveSha256", "buildId", "treeDigest"]),
    label,
  );
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ref.version)) {
    fail(`安装 journal 的 ${label}.version 无效。`);
  }
  const exactVersionPath = path.join(APP_ROOT, ref.version);
  const exactPendingPath = transactionId ? path.join(PENDING_ROOT, transactionId, "app") : null;
  if (
    path.resolve(ref.path) !== path.resolve(exactVersionPath) &&
    !(allowPending && exactPendingPath && path.resolve(ref.path) === path.resolve(exactPendingPath))
  ) {
    fail(`安装 journal 的 ${label}.path 不是约定的 Runtime 版本或 pending 路径。`);
  }
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

function validateLauncherSnapshot(snapshot) {
  if (
    !snapshot || typeof snapshot !== "object" ||
    !["missing", "file", "legacy_link", "legacy_file"].includes(snapshot.kind)
  ) {
    fail("安装 journal 的 transaction.launcherBefore 无效。");
  }
  if (snapshot.kind === "missing") {
    assertObjectKeys(snapshot, new Set(["kind"]), "transaction.launcherBefore");
    return;
  }
  if (snapshot.kind === "legacy_link") {
    assertObjectKeys(snapshot, new Set(["kind", "target"]), "transaction.launcherBefore");
    if (IS_WINDOWS || snapshot.target !== LEGACY_POSIX_LAUNCHER_TARGET) {
      fail("安装 journal 的 transaction.launcherBefore legacy target 无效。");
    }
    return;
  }
  if (snapshot.kind === "legacy_file") {
    assertObjectKeys(snapshot, new Set(["kind", "sha256"]), "transaction.launcherBefore");
    const expectedSha = createHash("sha256").update(legacyWindowsLauncherContents()).digest("hex");
    if (!IS_WINDOWS || snapshot.sha256 !== expectedSha) {
      fail("安装 journal 的 transaction.launcherBefore legacy Windows 摘要无效。");
    }
    return;
  }
  assertObjectKeys(snapshot, new Set(["kind", "sha256"]), "transaction.launcherBefore");
  const expectedSha = createHash("sha256").update(managedLauncherContents()).digest("hex");
  if (snapshot.sha256 !== expectedSha) {
    fail("安装 journal 的 transaction.launcherBefore.sha256 无效。");
  }
}

function validateToolsVersionPath(value, label, { allowNull = true } = {}) {
  if ((value === null || value === undefined) && allowNull) return;
  if (typeof value !== "string") fail(`安装 journal 的 ${label} 无效。`);
  const relative = path.relative(TOOLS_ROOT, path.resolve(value));
  if (
    !relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) || relative.includes(path.sep) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(relative)
  ) fail(`安装 journal 的 ${label} 不是约定的受管工具版本路径。`);
}

function validateServiceSnapshot(value) {
  if (value === null) return;
  if (
    !value || typeof value !== "object" ||
    typeof value.productVersion !== "string" ||
    typeof value.studioBuildId !== "string" || !/^[0-9a-f]{16}$/.test(value.studioBuildId) ||
    typeof value.runtimeMode !== "string" || !value.runtimeMode ||
    !Number.isInteger(value.pid) || value.pid <= 0 ||
    !value.capabilities || typeof value.capabilities !== "object" || Array.isArray(value.capabilities)
  ) fail("安装 journal 的 transaction.serviceBefore 无效。");
}

function validateTransaction(transaction, transactionId) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    fail("安装 journal 的 transaction 无效。");
  }
  assertObjectKeys(transaction, new Set([
    "oldActive", "oldPrevious", "serviceBefore", "serviceEnsureStarted", "launcherBefore",
    "toolsBefore", "toolsSource", "toolsCandidate", "toolsPending", "toolsTarget",
    "toolsBackup", "toolsPromotionStarted", "toolsBackupMoved", "toolsPromoted",
    "toolsTargetExisted",
  ]), "transaction");
  validateRuntimeRef(transaction.oldActive, "transaction.oldActive", { allowNull: true });
  validateRuntimeRef(transaction.oldPrevious, "transaction.oldPrevious", { allowNull: true });
  validateServiceSnapshot(transaction.serviceBefore);
  if (typeof transaction.serviceEnsureStarted !== "boolean") {
    fail("安装 journal 的 transaction.serviceEnsureStarted 无效。");
  }
  validateLauncherSnapshot(transaction.launcherBefore);
  validateToolsVersionPath(transaction.toolsBefore, "transaction.toolsBefore");
  if (
    transaction.toolsSource !== null && transaction.toolsSource !== undefined &&
    (typeof transaction.toolsSource !== "string" || !path.isAbsolute(transaction.toolsSource) ||
      transaction.toolsSource.includes("\0"))
  ) fail("安装 journal 的 transaction.toolsSource 无效。");
  const expectedPending = path.join(TOOLS_PENDING_ROOT, transactionId);
  const expectedTarget = path.join(TOOLS_ROOT, VERSION);
  const expectedBackup = path.join(TOOLS_ROOT, `.${VERSION}.previous.${transactionId}`);
  if (transaction.toolsPending !== null && transaction.toolsPending !== undefined) {
    assertExactManagedPath(transaction.toolsPending, expectedPending, "transaction.toolsPending");
  }
  for (const field of ["toolsTarget", "toolsCandidate"]) {
    if (transaction[field] !== null && transaction[field] !== undefined) {
      assertExactManagedPath(transaction[field], expectedTarget, `transaction.${field}`);
    }
  }
  if (transaction.toolsBackup !== null && transaction.toolsBackup !== undefined) {
    assertExactManagedPath(transaction.toolsBackup, expectedBackup, "transaction.toolsBackup");
  }
  for (const field of ["toolsPromotionStarted", "toolsBackupMoved", "toolsPromoted", "toolsTargetExisted"]) {
    if (transaction[field] !== undefined && typeof transaction[field] !== "boolean") {
      fail(`安装 journal 的 transaction.${field} 无效。`);
    }
  }
  if (transaction.toolsPromotionStarted === true) {
    if (
      transaction.toolsPending === undefined || transaction.toolsTarget === undefined ||
      transaction.toolsCandidate === undefined || typeof transaction.toolsTargetExisted !== "boolean" ||
      typeof transaction.toolsBackupMoved !== "boolean"
    ) fail("安装 journal 的工具提升 transaction 不完整。");
    if (transaction.toolsTargetExisted && !transaction.toolsBackup) {
      fail("安装 journal 的工具提升缺少约定 backup 路径。");
    }
    if (!transaction.toolsTargetExisted && transaction.toolsBackup !== null) {
      fail("安装 journal 的首次工具提升不得包含 backup 路径。");
    }
  }
}

function migrateLegacyState(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.schemaVersion === STATE_SCHEMA_VERSION) return raw;
  if (raw.schemaVersion !== 1) return raw;
  const migrated = JSON.parse(JSON.stringify(raw));
  migrated.schemaVersion = STATE_SCHEMA_VERSION;
  const snapshot = migrated.transaction?.launcherBefore;
  if (snapshot?.kind === "link") {
    if (IS_WINDOWS || snapshot.target !== LEGACY_POSIX_LAUNCHER_TARGET) {
      fail("旧版安装 journal 含未知 launcher symlink；无法安全迁移，已保留现场。");
    }
    migrated.transaction.launcherBefore = {
      kind: "legacy_link",
      target: LEGACY_POSIX_LAUNCHER_TARGET,
    };
  } else if (snapshot?.kind === "file" && ("contents" in snapshot || "mode" in snapshot)) {
    let contents;
    try {
      contents = Buffer.from(snapshot.contents, "base64");
    } catch {
      fail("旧版安装 journal 的 launcher 快照无法解码；已保留现场。");
    }
    if (contents.equals(Buffer.from(managedLauncherContents(), "utf8"))) {
      migrated.transaction.launcherBefore = {
        kind: "file",
        sha256: createHash("sha256").update(managedLauncherContents()).digest("hex"),
      };
    } else if (IS_WINDOWS && contents.equals(Buffer.from(legacyWindowsLauncherContents(), "utf8"))) {
      migrated.transaction.launcherBefore = {
        kind: "legacy_file",
        sha256: createHash("sha256").update(legacyWindowsLauncherContents()).digest("hex"),
      };
    } else {
      fail("旧版安装 journal 含未知 launcher 文件快照；无法安全迁移，已保留现场。");
    }
  }
  if (
    migrated.transaction?.toolsPromotionStarted === true &&
    typeof migrated.transaction.toolsTargetExisted !== "boolean"
  ) {
    fail(
      "旧版安装 journal 的工具提升现场缺少 toolsTargetExisted；无法证明 target/backup 所有权，" +
      "已保留现场且不会删除任何路径。",
    );
  }
  if (migrated.transaction?.toolsPromotionStarted === true) {
    migrated.transaction.toolsPending ??= path.join(TOOLS_PENDING_ROOT, migrated.transactionId);
    migrated.transaction.toolsTarget ??= path.join(TOOLS_ROOT, VERSION);
    migrated.transaction.toolsCandidate ??= path.join(TOOLS_ROOT, VERSION);
    migrated.transaction.toolsBackupMoved ??= false;
  }
  return migrated;
}

function validateState(state) {
  if (!state || typeof state !== "object" || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    fail("安装 journal 版本未知；为避免覆盖现有 Runtime，安装已停止。");
  }
  assertObjectKeys(state, new Set([
    "schemaVersion", "transactionId", "phase", "active", "previous", "pending",
    "transaction", "terminationFailure", "rollbackError", "updatedAt",
  ]), "root");
  const phases = new Set([
    "idle", "staged", "validated", "promoting", "switching", "health_check",
    "completed", "rolling_back", "rollback_failed", "termination_failed",
  ]);
  if (!phases.has(state.phase)) fail("安装 journal phase 无效。");
  if (state.transactionId !== null && !safeTransactionId(state.transactionId)) {
    fail("安装 journal transactionId 无效。");
  }
  if (typeof state.updatedAt !== "string" || !Number.isFinite(Date.parse(state.updatedAt))) {
    fail("安装 journal updatedAt 无效。");
  }
  validateRuntimeRef(state.active, "active", { allowNull: true });
  validateRuntimeRef(state.previous, "previous", { allowNull: true });
  validateRuntimeRef(state.pending, "pending", {
    allowNull: true,
    allowPending: true,
    transactionId: state.transactionId,
  });
  if (state.phase === "idle") {
    if (state.transactionId !== null || state.pending !== null || state.transaction !== null) {
      fail("安装 journal 的 idle 状态仍包含事务现场。");
    }
  } else {
    if (!safeTransactionId(state.transactionId)) fail("安装 journal 的非 idle 状态缺少 transactionId。");
    validateTransaction(state.transaction, state.transactionId);
  }
  if (state.phase === "rollback_failed") {
    if (typeof state.rollbackError !== "string" || !state.rollbackError) {
      fail("安装 journal 的 rollback_failed 状态缺少 rollbackError。");
    }
  } else if (state.rollbackError !== undefined) {
    fail("安装 journal 在非 rollback_failed 阶段包含 rollbackError。");
  }
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
    return validateState(migrateLegacyState(JSON.parse(readFileSync(STATE_PATH, "utf8"))));
  } catch (error) {
    if (error instanceof Error) throw error;
    fail("安装 journal 无法解析；安装已停止。");
  }
}

function writeState(state) {
  state.updatedAt = new Date().toISOString();
  validateState(state);
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
  assertSafeInstallRootPath(INSTALL_ROOT);
  if (!pathExists(INSTALL_ROOT)) mkdirSync(INSTALL_ROOT, { recursive: true, mode: 0o700 });
  lockedInstallRootCanonical = assertPlainDirectory(INSTALL_ROOT, "Product 受管安装根");
  assertInstallRootLayout();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertInstallRootLayout();
      mkdirSync(UPDATE_LOCK_PATH, { mode: 0o700 });
      assertPlainDirectory(UPDATE_LOCK_PATH, "Runtime 更新锁");
      assertCanonicalInside(UPDATE_LOCK_PATH, INSTALL_ROOT, "Runtime 更新锁");
      const pauseMilliseconds = Number(process.env.CHENGFENG_VIDEOCUT_TEST_PAUSE_AFTER_LOCK_DIRECTORY_MS || 0);
      if (Number.isFinite(pauseMilliseconds) && pauseMilliseconds > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMilliseconds);
      }
      const owner = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        transactionId: randomUUID(),
      };
      lockOwnerWriteInProgress = true;
      try {
        atomicWriteJson(path.join(UPDATE_LOCK_PATH, "owner.json"), owner, "lock_owner");
      } finally {
        lockOwnerWriteInProgress = false;
      }
      heldUpdateLockOwner = owner;
      assertInstallRootLayout({ requireHeldLock: true });
      return () => {
        assertInstallRootLayout({ requireHeldLock: true });
        const ownerPath = path.join(UPDATE_LOCK_PATH, "owner.json");
        assertSingleLinkRegularFile(ownerPath, "Runtime 更新锁 owner");
        const observed = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (stableJson(observed) !== stableJson(heldUpdateLockOwner)) {
          fail("Runtime 更新锁 owner 在释放前发生变化；不会删除未知锁。");
        }
        removeTreeWithoutFollowingLinks(UPDATE_LOCK_PATH);
        heldUpdateLockOwner = null;
        lockedInstallRootCanonical = null;
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      assertInstallRootLayout();
      let owner;
      try {
        const ownerPath = path.join(UPDATE_LOCK_PATH, "owner.json");
        assertSingleLinkRegularFile(ownerPath, "Runtime 更新锁 owner");
        owner = JSON.parse(readFileSync(ownerPath, "utf8"));
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
        assertInstallRootLayout();
        const ownerPath = path.join(UPDATE_LOCK_PATH, "owner.json");
        assertSingleLinkRegularFile(ownerPath, "Runtime 更新锁 owner");
        const observed = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (stableJson(observed) !== stableJson(owner) || processIsAlive(owner.pid)) {
          fail("Runtime 更新锁在回收前发生变化；不会删除未知锁。");
        }
        removeTreeWithoutFollowingLinks(UPDATE_LOCK_PATH);
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
  if (installerToolsDirectory) toolDirectories.unshift(installerToolsDirectory);
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
    ...(installerToolsDirectory
      ? { CHENGFENG_VIDEOCUT_CHROME_PATH: formalToolsExecutable(installerToolsDirectory, "chrome") }
      : {}),
    ...(launcher ? { CHENGFENG_VIDEOCUT_EXECUTABLE: launcher } : {}),
  };
}

function validateDownloadSize(size, { maxBytes, expectedBytes, label }) {
  if (expectedBytes !== null && size !== expectedBytes) {
    const error = new Error(`${label} 大小与安装 manifest 不一致：期望 ${expectedBytes}，实际 ${size} bytes。`);
    error.downloadRetryable = false;
    throw error;
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    const error = new Error(`${label} 超过允许的下载大小 ${maxBytes} bytes。`);
    error.downloadRetryable = false;
    throw error;
  }
}

async function download(url, destination, options = {}) {
  const label = options.label || "下载内容";
  const maxBytes = options.maxBytes ?? RELEASE_ASSET_DOWNLOAD_LIMIT_BYTES;
  const expectedBytes = options.expectedBytes ?? null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > RELEASE_ASSET_DOWNLOAD_LIMIT_BYTES) {
    fail(`${label} 下载上限无效。`);
  }
  if (
    expectedBytes !== null &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxBytes)
  ) fail(`${label} 的安装 manifest 大小无效。`);
  if (url.startsWith("file://")) {
    const source = fileURLToPath(url);
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      fail(`${label} 本地来源必须是单链接普通文件。`);
    }
    validateDownloadSize(metadata.size, { maxBytes, expectedBytes, label });
    copyFileSync(source, destination);
    validateDownloadSize(lstatSync(destination).size, { maxBytes, expectedBytes, label });
    return;
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor = null;
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const declaredSize = Number(contentLength);
        validateDownloadSize(declaredSize, { maxBytes, expectedBytes, label });
      }
      if (!response.body) throw new Error("response body is empty");
      descriptor = openSync(destination, "w", 0o600);
      const reader = response.body.getReader();
      let downloaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        validateDownloadSize(downloaded, { maxBytes, expectedBytes: null, label });
        if (expectedBytes !== null && downloaded > expectedBytes) {
          await reader.cancel();
          const error = new Error(`${label} 大小超过安装 manifest 声明的 ${expectedBytes} bytes。`);
          error.downloadRetryable = false;
          throw error;
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const written = writeSync(descriptor, value, offset, value.byteLength - offset, null);
          if (written <= 0) fail(`${label} 写入不完整。`);
          offset += written;
        }
      }
      validateDownloadSize(downloaded, { maxBytes, expectedBytes, label });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      return;
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(destination, { force: true });
      lastError = error;
      if (error && error.downloadRetryable === false) throw error;
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

function installerPlatformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(key)) {
    fail(`0.5.0 原生安装器不支持 ${key}。`);
  }
  return key;
}

function safeAssetRecord(value, label) {
  if (
    !value || typeof value !== "object" ||
    typeof value.asset !== "string" || !/^[^/\\]+$/.test(value.asset) ||
    typeof value.root !== "string" || !/^[^/\\]+$/.test(value.root) ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > RELEASE_ASSET_DOWNLOAD_LIMIT_BYTES
  ) fail(`安装 manifest 的 ${label} 资产无效。`);
  return value;
}

function safeInstallerRecord(value, expectedAsset, label) {
  if (
    !value || typeof value !== "object" || value.asset !== expectedAsset || value.root !== undefined ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > RELEASE_ASSET_DOWNLOAD_LIMIT_BYTES
  ) fail(`安装 manifest 的 ${label} installer 资产无效。`);
  return value;
}

function copyEmbeddedPayloadFile(source, destination, expectedBytes, label) {
  if (typeof source !== "string" || !source || source.includes("\0")) {
    fail(`${label} 内嵌 payload 路径无效。`);
  }
  let bytes;
  try {
    // Bun exposes compile-time assets through $bunfs paths.  Node-compatible
    // fs reads are deliberately used here so the same code remains testable
    // from the source installer.
    bytes = readFileSync(source);
  } catch (error) {
    fail(`${label} 无法读取内嵌 payload：${error instanceof Error ? error.message : String(error)}`);
  }
  validateDownloadSize(bytes.length, { maxBytes: RELEASE_ASSET_DOWNLOAD_LIMIT_BYTES, expectedBytes, label });
  let descriptor = null;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (written <= 0) fail(`${label} 内嵌 payload 写入不完整。`);
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function embeddedPayloadPath(payload, key, label) {
  const value = payload?.[key];
  if (typeof value !== "string" || !value || value.includes("\0")) {
    fail(`${label} 内嵌 payload 缺失。`);
  }
  return value;
}

function assertEmbeddedPayloadArgumentsAreClosed() {
  if (INSTALLER_OPTIONS.manifest || INSTALLER_OPTIONS.checksumFile ||
      process.env.CHENGFENG_VIDEOCUT_INSTALL_MANIFEST ||
      process.env.CHENGFENG_VIDEOCUT_MANIFEST_CHECKSUM_FILE ||
      process.env.CHENGFENG_VIDEOCUT_DOWNLOAD_BASE ||
      MANAGED_TOOLS_SOURCE_DIR) {
    fail("自包含 Product Runtime 安装器不接受外部 manifest、checksum、下载源或 tools 来源。");
  }
}

function loadEmbeddedInstallContext(payload) {
  assertEmbeddedPayloadArgumentsAreClosed();
  const platformKey = installerPlatformKey();
  if (payload.schemaVersion !== 1 || payload.platformKey !== platformKey) {
    fail("内嵌 payload 平台或 schema 与当前安装器不一致。");
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-embedded-installer-"));
  try {
    const manifestPath = path.join(tmpDir, EMBEDDED_PAYLOAD_MANIFEST_NAME);
    const checksumPath = path.join(tmpDir, EMBEDDED_PAYLOAD_CHECKSUM_NAME);
    copyEmbeddedPayloadFile(
      embeddedPayloadPath(payload, "manifestPath", "安装 manifest"),
      manifestPath,
      null,
      "安装 manifest",
    );
    copyEmbeddedPayloadFile(
      embeddedPayloadPath(payload, "checksumPath", "安装 checksum"),
      checksumPath,
      null,
      "安装 checksum",
    );
    const manifestSha256 = sha256(manifestPath);
    const expectedManifestSha256 = expectedHashFor(checksumPath, EMBEDDED_PAYLOAD_MANIFEST_NAME);
    if (!expectedManifestSha256 || expectedManifestSha256 !== manifestSha256) {
      fail("内嵌安装 manifest 与内嵌 checksum 不一致。");
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      fail("内嵌安装 manifest 不是合法 JSON。");
    }
    if (
      manifest?.schemaVersion !== 1 || manifest.product !== "chengfeng-videocut" ||
      manifest.productVersion !== VERSION || manifest.releaseTag !== `v${VERSION}` ||
      !["release-ready", "local-test-only"].includes(manifest.distributionMode) ||
      !manifest.platforms || typeof manifest.platforms !== "object"
    ) fail("内嵌安装 manifest 与当前 Runtime 版本不一致。");
    if (
      (manifest.licenseStatus !== "VERIFIED" || manifest.distributionMode !== "release-ready") &&
      !ALLOW_UNVERIFIED_LOCAL_TOOLS
    ) fail("内嵌安装 manifest 的第三方许可不是 VERIFIED；公开安装已阻止。");
    const platform = manifest.platforms[platformKey];
    if (!platform || typeof platform !== "object") fail(`内嵌安装 manifest 缺少 ${platformKey}。`);
    const runtime = safeAssetRecord(manifest.runtime, "runtime");
    const tools = safeAssetRecord(platform.tools, `${platformKey}.tools`);
    for (const asset of [runtime, tools]) {
      if (!expectedHashFor(checksumPath, asset.asset) || expectedHashFor(checksumPath, asset.asset) !== asset.sha256) {
        fail(`内嵌 checksum 未锁定 ${asset.asset}。`);
      }
    }
    return {
      tmpDir,
      manifest,
      manifestSha256,
      platformKey,
      runtime,
      tools,
      embeddedPayload: {
        runtimePath: embeddedPayloadPath(payload, "runtimePath", "Runtime bundle"),
        toolsPath: embeddedPayloadPath(payload, "toolsPath", "managed tools bundle"),
      },
    };
  } catch (error) {
    if (pathExists(tmpDir)) removeTreeWithoutFollowingLinks(tmpDir);
    throw error;
  }
}

async function loadFormalInstallContext() {
  const payload = embeddedPayload();
  if (payload) return loadEmbeddedInstallContext(payload);
  if (COMPILED_INSTALLER_VERSION) {
    fail("编译 Product Runtime 安装器缺少内嵌 payload；拒绝回退到远程依赖下载。");
  }
  const installManifestSource = externalInstallManifestSource();
  if (!installManifestSource) return null;
  const installManifestChecksumSource = externalInstallManifestChecksumSource();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-native-installer-"));
  try {
  const manifestPath = path.join(tmpDir, INSTALL_MANIFEST_NAME);
  const source = /^(?:https?|file):\/\//.test(installManifestSource)
    ? installManifestSource
    : pathToFileURL(path.resolve(installManifestSource)).href;
  await download(source, manifestPath, {
    label: "安装 manifest",
    maxBytes: SMALL_MANIFEST_DOWNLOAD_LIMIT_BYTES,
  });
  const manifestSha256 = sha256(manifestPath);
  if (!installManifestChecksumSource) {
    removeTreeWithoutFollowingLinks(tmpDir);
    fail("正式安装必须用 --checksum-file 将 manifest 绑定到已校验的 SHA256SUMS.txt。");
  }
  const checksumPath = path.join(tmpDir, "manifest-SHA256SUMS.txt");
  const checksumSource = /^(?:https?|file):\/\//.test(installManifestChecksumSource)
    ? installManifestChecksumSource
    : pathToFileURL(path.resolve(installManifestChecksumSource)).href;
  await download(checksumSource, checksumPath, {
    label: "安装 checksum",
    maxBytes: SMALL_MANIFEST_DOWNLOAD_LIMIT_BYTES,
  });
  const expectedManifestSha256 = expectedHashFor(checksumPath, INSTALL_MANIFEST_NAME);
  if (!expectedManifestSha256 || expectedManifestSha256 !== manifestSha256) {
    removeTreeWithoutFollowingLinks(tmpDir);
    fail("安装 manifest 与已校验 checksum 不一致。");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    removeTreeWithoutFollowingLinks(tmpDir);
    fail("安装 manifest 不是合法 JSON。");
  }
  if (
    manifest?.schemaVersion !== 1 || manifest.product !== "chengfeng-videocut" ||
    manifest.productVersion !== VERSION || manifest.releaseTag !== `v${VERSION}` ||
    !["release-ready", "local-test-only"].includes(manifest.distributionMode) ||
    !manifest.platforms || typeof manifest.platforms !== "object" ||
    Object.keys(manifest.platforms).sort().join(",") !==
      ["darwin-arm64", "darwin-x64", "win32-x64"].sort().join(",")
  ) {
    removeTreeWithoutFollowingLinks(tmpDir);
    fail("安装 manifest 与当前 Runtime 版本不一致。");
  }
  if (
    (manifest.licenseStatus !== "VERIFIED" || manifest.distributionMode !== "release-ready") &&
    !ALLOW_UNVERIFIED_LOCAL_TOOLS
  ) {
    removeTreeWithoutFollowingLinks(tmpDir);
    fail("安装 manifest 的第三方许可不是 VERIFIED；公开安装已阻止。");
  }
  const platformKey = installerPlatformKey();
  const platform = manifest.platforms[platformKey];
  if (!platform || typeof platform.installerAsset !== "string") {
    removeTreeWithoutFollowingLinks(tmpDir);
    fail(`安装 manifest 缺少 ${platformKey}。`);
  }
  safeInstallerRecord(platform.installer, platform.installerAsset, `${platformKey}.installer`);
  return {
    tmpDir,
    manifest,
    manifestSha256,
    platformKey,
    runtime: safeAssetRecord(manifest.runtime, "runtime"),
    tools: safeAssetRecord(platform.tools, `${platformKey}.tools`),
  };
  } catch (error) {
    if (pathExists(tmpDir)) removeTreeWithoutFollowingLinks(tmpDir);
    throw error;
  }
}

function validateArchiveEntries(archiveName, rootName, tmpDir, label) {
  const listing = runTar(["-tzf", archiveName], tmpDir);
  if (listing.status !== 0) fail(`${label} 无法读取：tar ${listing.status}。`);
  for (const entry of String(listing.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (
      normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").some((part) => part === "..") ||
      (normalized !== rootName && !normalized.startsWith(`${rootName}/`))
    ) fail(`${label} 包含不安全路径。`);
  }
  const verbose = runTar(["-tvzf", archiveName], tmpDir);
  if (verbose.status !== 0) fail(`${label} 类型清单无法读取。`);
  for (const line of String(verbose.stdout || "").split(/\r?\n/).filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d") fail(`${label} 包含链接或特殊条目。`);
  }
}

async function downloadAndExtractManifestAsset(context, asset, label) {
  const archivePath = path.join(context.tmpDir, asset.asset);
  if (context.embeddedPayload) {
    let source = null;
    if (asset.asset === context.runtime.asset && asset.sha256 === context.runtime.sha256) {
      source = context.embeddedPayload.runtimePath;
    } else if (asset.asset === context.tools.asset && asset.sha256 === context.tools.sha256) {
      source = context.embeddedPayload.toolsPath;
    }
    if (!source) fail(`${label} 不在当前自包含安装器 payload 中。`);
    copyEmbeddedPayloadFile(source, archivePath, asset.size, label);
  } else {
    await download(`${DOWNLOAD_BASE}/${asset.asset}`, archivePath, {
      label,
      maxBytes: asset.size,
      expectedBytes: asset.size,
    });
  }
  if (sha256(archivePath) !== asset.sha256) fail(`${label} SHA-256 与安装 manifest 不一致。`);
  validateArchiveEntries(asset.asset, asset.root, context.tmpDir, label);
  const extraction = runTar(["-xzf", asset.asset], context.tmpDir);
  if (extraction.status !== 0) fail(`${label} 解压失败：tar ${extraction.status}。`);
  const root = path.join(context.tmpDir, asset.root);
  validateRegularTree(root, context.tmpDir, label);
  return root;
}

function formalToolsExecutable(toolsRoot, key) {
  const manifest = JSON.parse(readFileSync(path.join(toolsRoot, "resources-manifest.json"), "utf8"));
  const relative = manifest?.executables?.[key];
  if (typeof relative !== "string") fail(`受管工具 manifest 缺少 ${key}。`);
  return path.join(toolsRoot, relative);
}

function writeManagedToolsState(context, toolsPath) {
  atomicWriteJson(TOOLS_STATE_PATH, {
    schemaVersion: 1,
    productVersion: VERSION,
    platformKey: context.platformKey,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.tools.sha256,
    path: toolsPath,
    treeDigest: regularTreeDigest(toolsPath),
    updatedAt: new Date().toISOString(),
  }, "managed_tools_state");
}

async function tryFastFormalReuse(context) {
  if (!pathExists(STATE_PATH) || !pathExists(TOOLS_STATE_PATH)) return false;
  const releaseLock = acquireUpdateLock();
  try {
    const state = readState();
    failIfTerminationRecoveryIsBlocked(state);
    if (state.phase !== "idle" || state.active?.version !== VERSION) return false;
    assertCurrentMatches(state);
    const observedLauncherKind = launcherKind();
    const toolsState = JSON.parse(readFileSync(TOOLS_STATE_PATH, "utf8"));
    const toolsTarget = readManagedToolsTarget();
    if (
      !toolsTarget || toolsState?.schemaVersion !== 1 || toolsState.productVersion !== VERSION ||
      toolsState.platformKey !== context.platformKey ||
      toolsState.manifestSha256 !== context.manifestSha256 ||
      toolsState.archiveSha256 !== context.tools.sha256 ||
      path.resolve(toolsState.path || "") !== path.resolve(toolsTarget) ||
      typeof toolsState.treeDigest !== "string" || !/^[0-9a-f]{64}$/.test(toolsState.treeDigest)
    ) return false;
    validateExternalToolsSource(toolsTarget, { allowManagedRoot: true });
    if (regularTreeDigest(toolsTarget) !== toolsState.treeDigest) fail("受管工具完整树摘要漂移。");
    if (state.active.archiveSha256 !== context.runtime.sha256) fail("已安装 Runtime 与 manifest 摘要不一致。");
    const activeInfo = validateCandidateLayout(state.active.path, APP_ROOT);
    if (activeInfo.treeDigest !== state.active.treeDigest || activeInfo.buildId !== state.active.buildId) {
      fail("已安装 Runtime 完整树身份漂移。");
    }
    const bunExecutable = formalToolsExecutable(toolsTarget, "bun");
    installerToolsDirectory = toolsTarget;
    await assertSupportedBun(bunExecutable);
    await selfTestCandidate(state.active.path, bunExecutable, state.active.buildId);
    if (ENSURE_MANAGED_SERVICE) {
      await verifyManagedService(
        state.active,
        bunExecutable,
        activeInfo.capabilities,
        activeInfo.buildId,
      );
    }
    if (observedLauncherKind !== "file") {
      // Missing or the one precisely-known legacy launcher is repairable only
      // after Runtime + tools + Bun + CLI (+ service when requested) all prove
      // the already-installed release. This stays on the zero-asset path.
      createLauncher();
      assertManagedLauncherExact();
    }
    reportSuccess("reused", 0, `chengfeng-videocut ${VERSION} 已复用；asset-downloads=0。\n`);
    return true;
  } finally {
    releaseLock();
  }
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
  assertManagedWriteBoundary(linkPath, "受管 current 临时链接");
  if (pathExists(linkPath)) fail(`内部错误：临时链接已存在 ${linkPath}`);
  symlinkSync(target, linkPath, kind);
}

function removeExpectedManagedLink(linkPath, label) {
  assertManagedWriteBoundary(linkPath, label);
  if (!pathExists(linkPath)) return;
  if (!lstatSync(linkPath).isSymbolicLink()) {
    fail(`${label} 不是受管链接；安装已停止。`);
  }
  removeLink(linkPath);
}

function switchCurrent(target, transactionId) {
  assertManagedPath(target, "候选 Runtime");
  assertCanonicalManagedDirectory(target, "候选 Runtime");
  const nextLink = path.join(APP_ROOT, `.current.next.${transactionId}`);
  const backupLink = path.join(APP_ROOT, `.current.previous.${transactionId}`);
  if (pathExists(nextLink)) removeExpectedManagedLink(nextLink, "Runtime next 链接");
  if (pathExists(backupLink)) removeExpectedManagedLink(backupLink, "Runtime backup 链接");
  if (IS_WINDOWS) {
    createLink(nextLink, path.resolve(target), "junction");
    // Windows Junction 不能 replace-in-place。这里是 journal 驱动的可恢复事务，
    // 而不是“原子切换”：任何中断都由 recoverInterruptedTransaction 恢复。
    try {
      if (pathExists(CURRENT_LINK)) {
        readCurrentTarget();
        assertManagedWriteBoundary(backupLink, "Runtime current backup 切换");
        renameSync(CURRENT_LINK, backupLink);
      }
      removeExpectedManagedLink(CURRENT_LINK, "Runtime current 链接");
      assertManagedWriteBoundary(CURRENT_LINK, "Runtime current 切换");
      renameSync(nextLink, CURRENT_LINK);
      if (pathExists(backupLink)) removeExpectedManagedLink(backupLink, "Runtime backup 链接");
    } catch (error) {
      try {
        if (!pathExists(CURRENT_LINK) && pathExists(backupLink)) {
          removeExpectedManagedLink(CURRENT_LINK, "Runtime current 链接");
          assertManagedWriteBoundary(CURRENT_LINK, "Runtime current 恢复");
          renameSync(backupLink, CURRENT_LINK);
        }
      } catch {
        // Journal recovery will retry from the durable phase.
      }
      throw error;
    } finally {
      if (pathExists(nextLink)) removeExpectedManagedLink(nextLink, "Runtime next 链接");
    }
    return;
  }
  createLink(nextLink, path.relative(APP_ROOT, target), "dir");
  try {
    if (pathExists(CURRENT_LINK)) readCurrentTarget();
    assertManagedWriteBoundary(CURRENT_LINK, "Runtime current 切换");
    renameSync(nextLink, CURRENT_LINK);
  } finally {
    if (pathExists(nextLink)) removeExpectedManagedLink(nextLink, "Runtime next 链接");
  }
}

function clearCurrentForFirstInstall(transactionId) {
  const nextLink = path.join(APP_ROOT, `.current.clear.${transactionId}`);
  if (!pathExists(CURRENT_LINK)) return;
  if (!isLink(CURRENT_LINK)) fail(`${CURRENT_LINK} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
  if (IS_WINDOWS) {
    readCurrentTarget();
    assertManagedWriteBoundary(nextLink, "Runtime current 清理暂存");
    renameSync(CURRENT_LINK, nextLink);
    removeExpectedManagedLink(nextLink, "Runtime current 清理暂存");
  } else {
    // POSIX rename of a fresh empty directory is not a replacement mechanism for
    // a link. unlink is safe here because the journal records active=null and
    // there is no old Runtime to preserve.
    readCurrentTarget();
    removeExpectedManagedLink(CURRENT_LINK, "Runtime current 链接");
  }
}

function switchManagedTools(target, transactionId, { injectFailure = true } = {}) {
  assertCanonicalManagedDirectory(target, "候选 Product 受管工具", TOOLS_ROOT);
  const next = path.join(TOOLS_ROOT, `.current.next.${transactionId}`);
  const backup = path.join(TOOLS_ROOT, `.current.previous.${transactionId}`);
  if (pathExists(next)) removeExpectedManagedLink(next, "tools next 链接");
  if (pathExists(backup)) removeExpectedManagedLink(backup, "tools backup 链接");
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
    assertManagedWriteBoundary(next, "tools next 链接");
    symlinkSync(path.resolve(target), next, "junction");
    try {
      maybeFailToolsPromotion("before_backup");
      if (pathExists(TOOLS_CURRENT_LINK)) {
        readManagedToolsTarget();
        assertManagedWriteBoundary(backup, "tools current backup 切换");
        renameSync(TOOLS_CURRENT_LINK, backup);
      }
      maybeFailToolsPromotion("after_backup");
      removeExpectedManagedLink(TOOLS_CURRENT_LINK, "tools/current 链接");
      assertManagedWriteBoundary(TOOLS_CURRENT_LINK, "tools/current 切换");
      renameSync(next, TOOLS_CURRENT_LINK);
      maybeFailToolsPromotion("after_current");
      if (pathExists(backup)) removeExpectedManagedLink(backup, "tools backup 链接");
    } catch (error) {
      try {
        if (!pathExists(TOOLS_CURRENT_LINK) && pathExists(backup)) {
          assertManagedWriteBoundary(TOOLS_CURRENT_LINK, "tools/current 恢复");
          renameSync(backup, TOOLS_CURRENT_LINK);
        }
      } catch {
        // The durable installer journal will retry recovery on the next launch.
      }
      throw error;
    } finally {
      if (pathExists(next)) removeExpectedManagedLink(next, "tools next 链接");
    }
    return;
  }
  assertManagedWriteBoundary(next, "tools next 链接");
  symlinkSync(path.relative(TOOLS_ROOT, target), next, "dir");
  try {
    if (pathExists(TOOLS_CURRENT_LINK)) readManagedToolsTarget();
    assertManagedWriteBoundary(TOOLS_CURRENT_LINK, "tools/current 切换");
    renameSync(next, TOOLS_CURRENT_LINK);
    maybeFailToolsPromotion("after_current");
  } finally {
    if (pathExists(next)) removeExpectedManagedLink(next, "tools next 链接");
  }
}

function restoreManagedTools(previous, transactionId) {
  if (previous) return switchManagedTools(previous, transactionId, { injectFailure: false });
  if (pathExists(TOOLS_CURRENT_LINK)) {
    readManagedToolsTarget();
    removeExpectedManagedLink(TOOLS_CURRENT_LINK, "tools/current 链接");
  }
}

function stageAndPromoteManagedTools(state, source, transactionId) {
  if (!source) return null;
  const pendingRoot = path.join(TOOLS_PENDING_ROOT, transactionId);
  const staged = path.join(pendingRoot, "tools");
  const target = path.join(TOOLS_ROOT, VERSION);
  const backup = path.join(TOOLS_ROOT, `.${VERSION}.previous.${transactionId}`);
  assertCanonicalManagedDirectory(source, "Product 受管工具外部来源", path.dirname(source));
  // Persist the pending location before the first managed-root write, so an
  // interruption during copy has a deterministic cleanup target.
  state.transaction.toolsPending = pendingRoot;
  state.transaction.toolsPromotionStarted = false;
  writeState(state);
  ensureManagedDirectory(TOOLS_PENDING_ROOT, "Product tools pending 目录");
  if (pathExists(pendingRoot)) fail("工具 pending 事务目录已存在；安装已停止。");
  ensureManagedDirectory(pendingRoot, "工具 pending 事务目录");
  assertManagedWriteBoundary(staged, "工具 pending 候选复制");
  cpSync(source, staged, { recursive: true, force: false });
  maybeCrashAt("tools_copied_pending");
  const stagedSource = validateExternalToolsSource(staged, { allowManagedRoot: true });
  if (canonicalPath(stagedSource) !== canonicalPath(staged)) fail("工具 pending 复制后路径身份异常。");
  state.transaction.toolsTarget = target;
  state.transaction.toolsTargetExisted = pathExists(target);
  state.transaction.toolsBackup = state.transaction.toolsTargetExisted ? backup : null;
  state.transaction.toolsCandidate = target;
  state.transaction.toolsPromotionStarted = true;
  state.transaction.toolsBackupMoved = false;
  writeState(state);
  maybeCrashAt("tools_promotion_planned");
  if (pathExists(backup)) removeManagedToolsDirectory(backup);
  if (state.transaction.toolsTargetExisted) {
    assertExactManagedPath(target, path.join(TOOLS_ROOT, VERSION), "transaction.toolsTarget");
    assertExactManagedPath(backup, path.join(TOOLS_ROOT, `.${VERSION}.previous.${transactionId}`), "transaction.toolsBackup");
    assertCanonicalManagedDirectory(target, "既有工具版本", TOOLS_ROOT);
    assertManagedWriteBoundary(backup, "工具版本 backup 切换");
    renameSync(target, backup);
    state.transaction.toolsBackupMoved = true;
    writeState(state);
    maybeCrashAt("tools_backup_moved");
  }
  try {
    if (process.env.CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_TARGET_RENAME === "1") {
      fail("TEST_FAIL_TOOLS_TARGET_RENAME");
    }
    assertCanonicalManagedDirectory(staged, "工具 pending 候选", pendingRoot);
    assertManagedWriteBoundary(target, "工具候选提升");
    renameSync(staged, target);
    // Deliberately leave toolsPromoted=false until the journal write below.
    // Recovery must therefore inspect target/backup rather than trusting it.
    maybeCrashAt("tools_target_renamed");
    state.transaction.toolsPromoted = true;
    writeState(state);
    return target;
  } catch (error) {
    if (!pathExists(target) && pathExists(backup)) {
      assertExactManagedPath(backup, path.join(TOOLS_ROOT, `.${VERSION}.previous.${transactionId}`), "transaction.toolsBackup");
      assertManagedWriteBoundary(target, "工具版本 backup 恢复");
      renameSync(backup, target);
    }
    state.transaction.toolsBackupMoved = false;
    state.transaction.toolsPromoted = false;
    writeState(state);
    throw error;
  }
}

function restoreManagedToolsVersion(transaction, transactionId) {
  if (!transaction) return;
  validateTransaction(transaction, transactionId);
  if (!transaction.toolsPromotionStarted) {
    if (transaction.toolsPending && pathExists(transaction.toolsPending)) {
      removeExpectedManagedTree(
        transaction.toolsPending,
        path.join(TOOLS_PENDING_ROOT, transactionId),
        "transaction.toolsPending",
      );
    }
    return;
  }
  const target = transaction.toolsTarget;
  const backup = transaction.toolsBackup;
  // target + backup proves the target is the uncommitted candidate.  A
  // planned promotion without a backup is not proof: target is either the old
  // version or a catch-restored old version and must stay untouched.
  const backupExists = Boolean(backup && pathExists(backup));
  if (
    process.env.CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_CLEANUP_UNTIL_SERVICE_STOPPED === "1" &&
    !candidateServiceStopAttempted
  ) {
    fail("TEST_FAIL_TOOLS_CLEANUP_UNTIL_SERVICE_STOPPED");
  }
  if (backupExists) {
    assertExactManagedPath(backup, path.join(TOOLS_ROOT, `.${VERSION}.previous.${transactionId}`), "transaction.toolsBackup");
    assertExactManagedPath(target, path.join(TOOLS_ROOT, VERSION), "transaction.toolsTarget");
    if (target && pathExists(target)) removeManagedToolsDirectory(target);
    assertInstallRootLayout({ requireHeldLock: true });
    renameSync(backup, target);
  } else if (transaction.toolsTargetExisted === false && target && pathExists(target)) {
    // First import has no old target.  Any target that exists here is the
    // candidate and can be removed to restore the original absent state.
    removeManagedToolsDirectory(target);
  }
  if (transaction.toolsPending && pathExists(transaction.toolsPending)) {
    removeExpectedManagedTree(
      transaction.toolsPending,
      path.join(TOOLS_PENDING_ROOT, transactionId),
      "transaction.toolsPending",
    );
  }
}

function finalizeManagedToolsVersion(transaction, transactionId) {
  if (!transaction?.toolsPromotionStarted) return;
  validateTransaction(transaction, transactionId);
  if (transaction.toolsBackup && pathExists(transaction.toolsBackup)) removeManagedToolsDirectory(transaction.toolsBackup);
  if (transaction.toolsPending && pathExists(transaction.toolsPending)) {
    removeExpectedManagedTree(
      transaction.toolsPending,
      path.join(TOOLS_PENDING_ROOT, transactionId),
      "transaction.toolsPending",
    );
  }
}

function managedLauncherContents() {
  if (IS_WINDOWS) {
    return `@echo off\r\nsetlocal\r\nset "CHENGFENG_VIDEOCUT_EXECUTABLE=%~f0"\r\nfor %%I in ("%~dp0..") do set "CHENGFENG_VIDEOCUT_DATA_DIR=%%~fI"\r\nset "APP_DIR=%~dp0..\\app\\current"\r\nset "MANAGED_TOOLS=%~dp0..\\tools\\current"\r\nset "BUN_EXE=%MANAGED_TOOLS%\\bun.exe"\r\nif not exist "%BUN_EXE%" (\r\n  echo chengfeng-videocut managed Bun is missing: "%BUN_EXE%" 1>&2\r\n  exit /b 127\r\n)\r\nset "PATH=%MANAGED_TOOLS%;%PATH%"\r\n"%BUN_EXE%" "%APP_DIR%\\cli.js" %*\r\nexit /b %ERRORLEVEL%\r\n`;
  }
  return `#!/bin/sh
set -eu
BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
INSTALL_ROOT=$(CDPATH= cd -- "$BIN_DIR/.." && pwd -P)
APP_DIR="$INSTALL_ROOT/app/current"
MANAGED_TOOLS="$INSTALL_ROOT/tools/current"
BUN_EXE="$MANAGED_TOOLS/bun"
if [ ! -x "$BUN_EXE" ]; then
  printf '%s\\n' "chengfeng-videocut managed Bun is missing: $BUN_EXE" >&2
  exit 127
fi
CHENGFENG_VIDEOCUT_EXECUTABLE="$BIN_DIR/chengfeng-videocut"
CHENGFENG_VIDEOCUT_DATA_DIR="$INSTALL_ROOT"
PATH="$MANAGED_TOOLS\${PATH:+:$PATH}"
export CHENGFENG_VIDEOCUT_EXECUTABLE CHENGFENG_VIDEOCUT_DATA_DIR PATH
exec "$BUN_EXE" "$APP_DIR/cli.js" "$@"
`;
}

function legacyWindowsLauncherContents() {
  return `@echo off\r\nsetlocal\r\nset "CHENGFENG_VIDEOCUT_EXECUTABLE=%~f0"\r\nfor %%I in ("%~dp0..") do set "CHENGFENG_VIDEOCUT_DATA_DIR=%%~fI"\r\nset "APP_DIR=%~dp0..\\app\\current"\r\nset "MANAGED_TOOLS=%~dp0..\\tools\\current"\r\nif exist "%MANAGED_TOOLS%" set "PATH=%MANAGED_TOOLS%;%PATH%"\r\nset "BUN_EXE="\r\nif exist "%MANAGED_TOOLS%\\bun.exe" set "BUN_EXE=%MANAGED_TOOLS%\\bun.exe"\r\nfor /f "delims=" %%B in ('where bun.exe 2^>nul') do if not defined BUN_EXE set "BUN_EXE=%%~fB"\r\nif not defined BUN_EXE if exist "%USERPROFILE%\\.bun\\bin\\bun.exe" set "BUN_EXE=%USERPROFILE%\\.bun\\bin\\bun.exe"\r\nfor /f "delims=" %%B in ('where bun.cmd 2^>nul') do if not defined BUN_EXE set "BUN_EXE=%%~fB"\r\nif not defined BUN_EXE (\r\n  echo chengfeng-videocut 需要 Bun 1.2 或更高版本：https://bun.sh/docs/installation 1>&2\r\n  exit /b 127\r\n)\r\n"%BUN_EXE%" "%APP_DIR%\\cli.js" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

const LEGACY_POSIX_LAUNCHER_TARGET = path.join("..", "app", "current", "chengfeng-videocut");

function assertExactLegacyLauncher() {
  if (IS_WINDOWS) fail("Windows 不接受 legacy symlink launcher。");
  const metadata = lstatSync(BIN_LINK);
  if (!metadata.isSymbolicLink() || readlinkSync(BIN_LINK) !== LEGACY_POSIX_LAUNCHER_TARGET) {
    fail("Product 稳定 launcher 是未知 symlink；安装已停止。");
  }
  const activeDirectory = readCurrentTarget();
  if (!activeDirectory) fail("legacy launcher 存在但 app/current 缺失；安装已停止。");
  const expectedTarget = path.join(activeDirectory, "chengfeng-videocut");
  const targetMetadata = assertSingleLinkRegularFile(expectedTarget, "legacy launcher 目标");
  if ((targetMetadata.mode & 0o111) === 0) fail("legacy launcher 目标不可执行；安装已停止。");
  for (const [relative, label] of [
    ["cli.js", "legacy Runtime cli.js"],
    [path.join("studio", "index.html"), "legacy Runtime Studio"],
    ["chengfeng-videocut", "legacy Runtime launcher"],
  ]) assertRequiredRegularFile(activeDirectory, relative, label);
  if (comparablePath(canonicalPath(BIN_LINK)) !== comparablePath(canonicalPath(expectedTarget))) {
    fail("legacy launcher 的 canonical 目标与 app/current 不一致；安装已停止。");
  }
  return metadata;
}

function launcherKind() {
  if (!pathExists(BIN_LINK)) return "missing";
  const metadata = lstatSync(BIN_LINK);
  if (metadata.isSymbolicLink()) {
    assertExactLegacyLauncher();
    return "legacy_link";
  }
  assertSingleLinkRegularFile(BIN_LINK, "Product 稳定 launcher");
  const actual = readFileSync(BIN_LINK);
  if (actual.equals(Buffer.from(managedLauncherContents(), "utf8"))) {
    assertManagedLauncherExact();
    return "file";
  }
  if (IS_WINDOWS && actual.equals(Buffer.from(legacyWindowsLauncherContents(), "utf8"))) {
    assertCanonicalInside(BIN_LINK, BIN_ROOT, "legacy Windows launcher");
    return "legacy_file";
  }
  fail("Product 稳定 launcher 内容不是当前或已知 legacy 精确内容；安装已停止。");
}

function assertManagedLauncherExact() {
  const metadata = assertSingleLinkRegularFile(BIN_LINK, "Product 稳定 launcher");
  const expected = Buffer.from(managedLauncherContents(), "utf8");
  const actual = readFileSync(BIN_LINK);
  if (!actual.equals(expected)) {
    fail("Product 稳定 launcher 内容不是当前 Runtime 管理的精确内容；安装已停止。");
  }
  if (!IS_WINDOWS && (metadata.mode & 0o777) !== 0o755) {
    fail("Product 稳定 launcher 权限不是 0755；安装已停止。");
  }
  assertCanonicalInside(BIN_LINK, BIN_ROOT, "Product 稳定 launcher");
  return metadata;
}

function atomicWriteManagedLauncher({ replaceExactLegacy = false } = {}) {
  assertManagedWriteBoundary(BIN_LINK, "Product 稳定 launcher");
  if (pathExists(BIN_LINK)) {
    if (!replaceExactLegacy || !["legacy_link", "legacy_file"].includes(launcherKind())) {
      fail("Product 稳定 launcher 写入目标已存在；安装已停止。");
    }
  }
  const temporary = path.join(BIN_ROOT, `.chengfeng-videocut.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(managedLauncherContents(), "utf8");
  let descriptor = null;
  try {
    descriptor = openSync(temporary, "wx", IS_WINDOWS ? 0o600 : 0o755);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(descriptor, bytes, written, bytes.length - written, null);
      if (count <= 0) fail("Product 稳定 launcher 写入不完整。");
      written += count;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    assertManagedWriteBoundary(BIN_LINK, "Product 稳定 launcher");
    if (pathExists(BIN_LINK)) {
      if (!replaceExactLegacy || !["legacy_link", "legacy_file"].includes(launcherKind())) {
        fail("Product 稳定 launcher 在提交前被替换；安装已停止。");
      }
    }
    renameSync(temporary, BIN_LINK);
    descriptor = openSync(BIN_LINK, "r+");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    flushDirectoryIfSupported(BIN_ROOT, "launcher");
    assertManagedLauncherExact();
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (pathExists(temporary)) {
      assertSingleLinkRegularFile(temporary, "Product 稳定 launcher 临时文件");
      unlinkSync(temporary);
    }
  }
}

function createLauncher() {
  assertManagedWriteBoundary(BIN_LINK, "Product 稳定 launcher");
  if (pathExists(BIN_LINK)) {
    if (["legacy_link", "legacy_file"].includes(launcherKind())) {
      atomicWriteManagedLauncher({ replaceExactLegacy: true });
    }
    return;
  }
  atomicWriteManagedLauncher();
}

function captureLauncher() {
  assertManagedWriteBoundary(BIN_LINK, "Product 稳定 launcher 快照");
  const kind = launcherKind();
  if (kind === "missing") return { kind: "missing" };
  if (kind === "legacy_link") {
    return { kind: "legacy_link", target: LEGACY_POSIX_LAUNCHER_TARGET };
  }
  if (kind === "legacy_file") {
    return {
      kind: "legacy_file",
      sha256: createHash("sha256").update(legacyWindowsLauncherContents()).digest("hex"),
    };
  }
  return {
    kind: "file",
    sha256: createHash("sha256").update(managedLauncherContents()).digest("hex"),
  };
}

function restoreLauncher(snapshot) {
  assertManagedWriteBoundary(BIN_LINK, "Product 稳定 launcher 恢复");
  if (!snapshot || !["missing", "file", "legacy_link", "legacy_file"].includes(snapshot.kind)) {
    fail("安装 journal 的启动器快照无效；安装已停止。");
  }
  if (snapshot.kind === "file") {
    const expectedSha = createHash("sha256").update(managedLauncherContents()).digest("hex");
    if (snapshot.sha256 !== expectedSha) fail("安装 journal 的 launcher 摘要无效；安装已停止。");
    if (pathExists(BIN_LINK)) assertManagedLauncherExact();
    else atomicWriteManagedLauncher();
    return;
  }
  if (snapshot.kind === "legacy_link") {
    if (IS_WINDOWS || snapshot.target !== LEGACY_POSIX_LAUNCHER_TARGET) {
      fail("安装 journal 的 legacy launcher 快照无效；安装已停止。");
    }
    if (pathExists(BIN_LINK)) {
      if (launcherKind() === "legacy_link") return;
      assertManagedLauncherExact();
      unlinkSync(BIN_LINK);
    }
    const temporary = path.join(BIN_ROOT, `.chengfeng-videocut.legacy.${process.pid}.${randomUUID()}.tmp`);
    assertManagedWriteBoundary(temporary, "legacy launcher 恢复临时链接");
    symlinkSync(LEGACY_POSIX_LAUNCHER_TARGET, temporary, "file");
    try {
      assertManagedWriteBoundary(BIN_LINK, "legacy launcher 恢复");
      if (pathExists(BIN_LINK)) fail("legacy launcher 恢复目标被替换；安装已停止。");
      renameSync(temporary, BIN_LINK);
      assertExactLegacyLauncher();
      flushDirectoryIfSupported(BIN_ROOT, "launcher_restore_legacy");
    } finally {
      if (pathExists(temporary)) removeExpectedManagedLink(temporary, "legacy launcher 恢复临时链接");
    }
    return;
  }
  if (snapshot.kind === "legacy_file") {
    const expectedSha = createHash("sha256").update(legacyWindowsLauncherContents()).digest("hex");
    if (!IS_WINDOWS || snapshot.sha256 !== expectedSha) {
      fail("安装 journal 的 legacy Windows launcher 快照无效；安装已停止。");
    }
    if (pathExists(BIN_LINK)) {
      if (launcherKind() === "legacy_file") return;
      assertManagedLauncherExact();
      unlinkSync(BIN_LINK);
    }
    const temporary = path.join(BIN_ROOT, `.chengfeng-videocut.legacy.${process.pid}.${randomUUID()}.tmp`);
    assertManagedWriteBoundary(temporary, "legacy Windows launcher 恢复临时文件");
    writeFileSync(temporary, legacyWindowsLauncherContents(), { flag: "wx", mode: 0o600 });
    try {
      assertSingleLinkRegularFile(temporary, "legacy Windows launcher 恢复临时文件");
      assertManagedWriteBoundary(BIN_LINK, "legacy Windows launcher 恢复");
      if (pathExists(BIN_LINK)) fail("legacy Windows launcher 恢复目标被替换；安装已停止。");
      renameSync(temporary, BIN_LINK);
      if (launcherKind() !== "legacy_file") fail("legacy Windows launcher 恢复后身份不一致。");
      flushDirectoryIfSupported(BIN_ROOT, "launcher_restore_legacy_windows");
    } finally {
      if (pathExists(temporary)) {
        assertSingleLinkRegularFile(temporary, "legacy Windows launcher 恢复临时文件");
        unlinkSync(temporary);
      }
    }
    return;
  }
  if (!pathExists(BIN_LINK)) return;
  assertManagedLauncherExact();
  unlinkSync(BIN_LINK);
  flushDirectoryIfSupported(BIN_ROOT, "launcher_restore");
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
  onEnsureStarted = null,
) {
  const budget = createServiceVerificationBudget("新 Runtime 服务验证");
  if (onEnsureStarted) onEnsureStarted();
  const service = parseCliJson(
    await runCliAt(
      candidate,
      bunExecutable,
      ["service", "ensure", "--json"],
      remainingServiceBudget(budget),
    ),
    "新 Runtime service ensure",
  );
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
  candidateServiceStopAttempted = true;
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
    // Windows Task Scheduler may retain candidate bun.exe.  Stop it while the
    // candidate tools are still present; only then may rollback remove them.
    if (state.transaction?.serviceEnsureStarted && candidate) {
      await stopCandidateService(candidate, bunExecutable);
    }
    if (old) switchCurrent(old.path, state.transactionId || randomUUID());
    else clearCurrentForFirstInstall(state.transactionId || randomUUID());
    if (state.transaction?.toolsSource || state.transaction?.toolsCandidate || state.transaction?.toolsBefore) {
      const toolsBefore = state.transaction?.toolsBefore || null;
      const toolsTransactionId = state.transactionId || randomUUID();
      // A same-version replacement first moves tools/<version> to its backup.
      // After a crash at that exact point, toolsBefore names the temporarily
      // absent target, so relinking it first would fail and strand the backup.
      // Other upgrades restore current away from the candidate before deleting
      // it, which also keeps Windows junction rollback conservative.
      if (toolsBefore && !pathExists(toolsBefore)) {
        restoreManagedToolsVersion(state.transaction, state.transactionId);
        restoreManagedTools(toolsBefore, toolsTransactionId);
      } else {
        restoreManagedTools(toolsBefore, toolsTransactionId);
        restoreManagedToolsVersion(state.transaction, state.transactionId);
      }
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

async function activateSameVersionManagedTools(state, bunExecutable, candidateInfo, managedTools) {
  const transactionId = randomUUID();
  state.pending = state.active;
  state.phase = "health_check";
  state.transactionId = transactionId;
  state.transaction = {
    oldActive: state.active,
    oldPrevious: state.previous,
    serviceBefore: null,
    serviceEnsureStarted: false,
    launcherBefore: captureLauncher(),
    toolsBefore: readManagedToolsTarget(),
    toolsSource: managedTools,
    toolsCandidate: null,
  };
  state.terminationFailure = null;
  writeState(state);
  try {
    // Even though app/current already names this verified Runtime, the stable
    // launcher and tools/current are still one Product-managed activation unit.
    createLauncher();
    state.transaction.serviceBefore = await inspectManagedService(state.active, bunExecutable);
    writeState(state);
    switchManagedTools(stageAndPromoteManagedTools(state, managedTools, transactionId), transactionId);
    if (state.transaction.serviceBefore || ENSURE_MANAGED_SERVICE) {
      await verifyManagedService(
        state.active,
        bunExecutable,
        candidateInfo.capabilities,
        candidateInfo.buildId,
        () => {
          state.transaction.serviceEnsureStarted = true;
          writeState(state);
        },
      );
    }
  } catch (error) {
    if (hasUnconfirmedProcessTree(error)) throw error;
    await rollbackActivatedTransaction(state, bunExecutable, { reason: "同版本 Product 受管工具激活自证失败" });
    throw error;
  }
  state.pending = null;
  state.phase = "completed";
  writeState(state);
  maybeCrashAt("tools_committed");
  finalizeManagedToolsVersion(state.transaction, state.transactionId);
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
    finalizeManagedToolsVersion(state.transaction, state.transactionId);
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
    let recoverableCandidatePath = candidate?.path ?? null;
    if (state.phase === "promoting" && candidate) {
      const stagedRoot = path.join(PENDING_ROOT, state.transactionId);
      const stagedCandidate = path.join(stagedRoot, "app");
      if (
        path.resolve(candidate.path) === path.resolve(stagedCandidate) &&
        !pathExists(stagedCandidate) && pathExists(TARGET_DIR)
      ) {
        // rename(pending/app, app/<version>) succeeded but the following
        // journal write did not. TARGET_DIR was proven absent before this
        // transaction; still require the exact verified tree identity before
        // treating the derived path as ours and deleting it.
        const promotedInfo = validateCandidateLayout(TARGET_DIR, APP_ROOT);
        if (
          promotedInfo.buildId !== candidate.buildId ||
          promotedInfo.treeDigest !== candidate.treeDigest
        ) fail("promoting 恢复发现未记账的 Runtime 目录身份不匹配；已保留现场。");
        recoverableCandidatePath = TARGET_DIR;
      }
    }
    if (
      candidate && recoverableCandidatePath && pathExists(recoverableCandidatePath) &&
      !sameRuntime({ ...candidate, path: recoverableCandidatePath }, state.active)
    ) removeManagedDirectory(recoverableCandidatePath);
    const stagedRoot = state.transactionId ? path.join(PENDING_ROOT, state.transactionId) : null;
    if (stagedRoot && pathExists(stagedRoot)) {
      assertCanonicalManagedDirectory(stagedRoot, "Runtime pending 恢复目录", PENDING_ROOT);
      if (readdirSync(stagedRoot).length !== 0) {
        fail("Runtime pending 恢复目录仍含未知内容；已保留现场。");
      }
      rmdirSync(stagedRoot);
    }
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

async function runInstaller(formalContext) {
  // Read-only diagnostic hold check precedes even the formal zero-download
  // path, which has its own lock. A termination_failed scene must not have a
  // dead owner lock reclaimed as a side effect of merely retrying install.
  if (pathExists(INSTALL_ROOT)) {
    assertSafeInstallRootPath(INSTALL_ROOT);
    assertInstallRootLayout();
    if (pathExists(STATE_PATH)) failIfTerminationRecoveryIsBlocked(readState());
  }
  if (formalContext && await tryFastFormalReuse(formalContext)) {
    return;
  }
  let formalRuntimeRoot = null;
  let formalToolsRoot = null;
  let bunExecutable = null;
  if (formalContext) {
    formalRuntimeRoot = await downloadAndExtractManifestAsset(
      formalContext,
      formalContext.runtime,
      "Runtime bundle",
    );
    formalToolsRoot = await downloadAndExtractManifestAsset(
      formalContext,
      formalContext.tools,
      "managed tools bundle",
    );
    validateExternalToolsSource(formalToolsRoot);
    installerToolsDirectory = formalToolsRoot;
    bunExecutable = formalToolsExecutable(formalToolsRoot, "bun");
  } else {
    bunExecutable = findBun();
    if (!bunExecutable) {
      const hint = IS_WINDOWS ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : "https://bun.sh/docs/installation";
      fail(`需要先安装 Bun 1.2 或更高版本：${hint}`);
    }
  }
  await assertSupportedBun(bunExecutable);
  // termination_failed is a diagnostic hold, not a stale-lock hint. Refuse
  // before creating, reclaiming, or replacing any update lock so the original
  // failure scene remains intact. Repeat after lock acquisition below to close
  // the read/acquire race.
  if (pathExists(INSTALL_ROOT)) {
    assertSafeInstallRootPath(INSTALL_ROOT);
    assertInstallRootLayout();
    if (pathExists(STATE_PATH)) failIfTerminationRecoveryIsBlocked(readState());
  }
  const releaseLock = acquireUpdateLock();
  let state = null;
  try {
    ensureManagedDirectory(APP_ROOT, "Product app 目录");
    ensureManagedDirectory(BIN_ROOT, "Product bin 目录");
    ensureManagedDirectory(TOOLS_ROOT, "Product tools 目录");
    // termination_failed 是人工诊断门禁。取得锁后仍须先停下，不能把
    // “原 updater 已退出”等同于“残余进程树已终止”。
    if (pathExists(STATE_PATH)) failIfTerminationRecoveryIsBlocked(readState());
    state = readState();
    state = await recoverInterruptedTransaction(state, bunExecutable);
    assertCurrentMatches(state);

    const tmpDir = formalContext?.tmpDir || mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-"));
    try {
      let archiveSha256;
      let extracted;
      if (formalContext) {
        archiveSha256 = formalContext.runtime.sha256;
        extracted = formalRuntimeRoot;
      } else {
        const archivePath = path.join(tmpDir, ARCHIVE_NAME);
        const checksumPath = path.join(tmpDir, CHECKSUM_NAME);
        progress(`正在下载 chengfeng-videocut ${VERSION}…\n`);
        await download(`${DOWNLOAD_BASE}/${ARCHIVE_NAME}`, archivePath, { label: "Runtime bundle" });
        await download(`${DOWNLOAD_BASE}/${CHECKSUM_NAME}`, checksumPath, {
          label: "Runtime checksum",
          maxBytes: SMALL_MANIFEST_DOWNLOAD_LIMIT_BYTES,
        });
        archiveSha256 = validateArchive(archivePath, checksumPath, tmpDir);
        extracted = path.join(tmpDir, `chengfeng-videocut-${VERSION}`);
      }
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
      const managedTools = validateExternalToolsSource(formalToolsRoot || MANAGED_TOOLS_SOURCE_DIR);

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
          await activateSameVersionManagedTools(state, bunExecutable, candidateInfo, managedTools);
          if (formalContext) writeManagedToolsState(formalContext, readManagedToolsTarget());
        } else if (ENSURE_MANAGED_SERVICE) {
          await verifyManagedService(
            state.active,
            bunExecutable,
            candidateInfo.capabilities,
            candidateInfo.buildId,
          );
        }
        reportSuccess(
          "current",
          formalContext?.embeddedPayload ? 0 : 2,
          `chengfeng-videocut ${VERSION} 已是当前 Runtime；未改写 current。\n`,
        );
        return;
      }
      if (pathExists(TARGET_DIR)) {
        fail(`${TARGET_DIR} 已存在；拒绝覆盖未受本事务控制的版本目录。`);
      }

      const transactionId = randomUUID();
      const stagedRoot = path.join(PENDING_ROOT, transactionId);
      const stagedCandidate = path.join(stagedRoot, "app");
      assertManagedPath(stagedCandidate, "pending 候选目录");
      ensureManagedDirectory(PENDING_ROOT, "Product app pending 目录");
      if (pathExists(stagedRoot)) fail("Runtime pending 事务目录已存在；安装已停止。");
      ensureManagedDirectory(stagedRoot, "Runtime pending 事务目录");
      let stagedInfo;
      try {
        assertManagedWriteBoundary(stagedCandidate, "Runtime pending 候选复制");
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
        serviceEnsureStarted: false,
        launcherBefore: captureLauncher(),
        toolsBefore: managedTools ? readManagedToolsTarget() : null,
        toolsSource: managedTools,
        toolsCandidate: null,
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
      maybeCrashAt("promoted_before_journal");
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
        if (state.transaction.toolsSource) {
          switchManagedTools(
            stageAndPromoteManagedTools(state, state.transaction.toolsSource, transactionId),
            transactionId,
          );
        }
        if (state.transaction.serviceBefore || ENSURE_MANAGED_SERVICE) {
          await verifyManagedService(
            candidate,
            bunExecutable,
            candidateInfo.capabilities,
            candidateInfo.buildId,
            () => {
              state.transaction.serviceEnsureStarted = true;
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
      maybeCrashAt("tools_committed");
      finalizeManagedToolsVersion(state.transaction, state.transactionId);
      if (formalContext) writeManagedToolsState(formalContext, readManagedToolsTarget());
      maybeCrashAt("completed");
      state.phase = "idle";
      state.transactionId = null;
      state.transaction = null;
      state.terminationFailure = null;
      writeState(state);
      reportSuccess(
        "installed",
        formalContext?.embeddedPayload ? 0 : 2,
        `chengfeng-videocut ${VERSION} 已验证并激活。\n`,
      );
      if (IS_WINDOWS) {
        progress("Windows junction 切换采用 journal 可恢复事务；异常中断会在下次安装启动时恢复。\n");
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

async function main() {
  let formalContext = null;
  try {
    assertManagedServiceUsesDefaultRoot();
    formalContext = await loadFormalInstallContext();
    return await runInstaller(formalContext);
  } finally {
    if (formalContext?.tmpDir && pathExists(formalContext.tmpDir)) {
      removeTreeWithoutFollowingLinks(formalContext.tmpDir);
    }
  }
}

function reportMainFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (INSTALLER_OPTIONS.json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      command: "runtime.install",
      ok: false,
      error: { code: "installation_failed", message },
    })}\n`);
  } else {
    process.stderr.write(`错误：${message}\n`);
  }
}

module.exports = { main, reportMainFailure };

if (require.main === module && !EMBEDDED_PAYLOAD_BUILD) {
  main().catch((error) => {
    reportMainFailure(error);
    process.exitCode = 1;
  });
}
