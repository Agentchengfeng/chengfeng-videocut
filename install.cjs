#!/usr/bin/env node
"use strict";

// chengfeng-videocut 跨平台安装器（macOS / Windows 同一条代码路径）。
// 与 install.sh 同语义：下载 → SHA-256 校验 → tar 安全检查 → 原子落盘 →
// current 指针 → bin 启动器 → 版本自证。install.sh 保留服务 curl|sh 老用户，
// 本文件是 Runtime 合同（installerAsset）的新目标。

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const REPOSITORY = "Agentchengfeng/chengfeng-videocut";
const VERSION = "0.4.6";
const ARCHIVE_NAME = "chengfeng-videocut-portable.tar.gz";
const CHECKSUM_NAME = "SHA256SUMS.txt";
const IS_WINDOWS = process.platform === "win32";

const DOWNLOAD_BASE =
  process.env.CHENGFENG_VIDEOCUT_DOWNLOAD_BASE ||
  `https://github.com/${REPOSITORY}/releases/download/v${VERSION}`;
const INSTALL_ROOT =
  process.env.CHENGFENG_VIDEOCUT_HOME || path.join(os.homedir(), ".chengfeng-videocut");
const APP_ROOT = path.join(INSTALL_ROOT, "app");
const BIN_ROOT = path.join(INSTALL_ROOT, "bin");
const TARGET_DIR = path.join(APP_ROOT, VERSION);
const CURRENT_LINK = path.join(APP_ROOT, "current");
const BIN_LINK = path.join(BIN_ROOT, IS_WINDOWS ? "chengfeng-videocut.cmd" : "chengfeng-videocut");

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

function findBun() {
  const names = IS_WINDOWS ? ["bun.exe", "bun.cmd"] : ["bun"];
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const fallbacks = IS_WINDOWS
    ? [path.join(os.homedir(), ".bun", "bin", "bun.exe")]
    : [
        path.join(os.homedir(), ".bun", "bin", "bun"),
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
      ];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(destination, bytes);
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

// PATH 上可能是 Git for Windows 的 GNU tar（Git Bash 下必然是），它把 `C:` 读成
// rsh 远程主机名（"Cannot connect to C: resolve failed"）。所以一律在归档所在目录
// 里用相对文件名调用，命令行里不出现盘符——bsdtar 与 GNU tar 都接受这种形式。
function runTar(args, cwd) {
  const result = spawnSync("tar", args, { encoding: "utf8", cwd });
  if (result.error) {
    fail(
      "找不到 tar：macOS 系统自带；Windows 10 1803+ 系统自带（C\\\\Windows\\\\System32\\\\tar.exe）。",
    );
  }
  return result;
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

function replaceLink(linkPath, target, kind) {
  if (existsSync(linkPath) || isLink(linkPath)) {
    if (!isLink(linkPath)) {
      fail(`${linkPath} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
    }
    removeLink(linkPath);
  }
  symlinkSync(target, linkPath, kind);
}

function isLink(candidate) {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

const WINDOWS_LAUNCHER = `@echo off
setlocal
set "CHENGFENG_VIDEOCUT_EXECUTABLE=%~f0"
for %%I in ("%~dp0..") do set "CHENGFENG_VIDEOCUT_DATA_DIR=%%~fI"
set "APP_DIR=%~dp0..\\app\\current"
set "BUN_EXE="
where bun >nul 2>nul && set "BUN_EXE=bun"
if not defined BUN_EXE if exist "%USERPROFILE%\\.bun\\bin\\bun.exe" set "BUN_EXE=%USERPROFILE%\\.bun\\bin\\bun.exe"
if not defined BUN_EXE (
  echo chengfeng-videocut 需要 Bun 1.2 或更高版本：https://bun.sh/docs/installation 1>&2
  exit /b 127
)
"%BUN_EXE%" "%APP_DIR%\\cli.js" %*
exit /b %ERRORLEVEL%
`;

async function main() {
  const bunExecutable = findBun();
  if (!bunExecutable) {
    const hint = IS_WINDOWS
      ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
      : "https://bun.sh/docs/installation";
    fail(`需要先安装 Bun 1.2 或更高版本：${hint}`);
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-"));
  const cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
  process.on("exit", cleanup);

  const archivePath = path.join(tmpDir, ARCHIVE_NAME);
  const checksumPath = path.join(tmpDir, CHECKSUM_NAME);

  process.stdout.write(`正在下载 chengfeng-videocut ${VERSION}…\n`);
  await download(`${DOWNLOAD_BASE}/${ARCHIVE_NAME}`, archivePath);
  await download(`${DOWNLOAD_BASE}/${CHECKSUM_NAME}`, checksumPath);

  const expected = expectedHashFor(checksumPath, ARCHIVE_NAME);
  if (!expected) fail(`${CHECKSUM_NAME} 中没有 ${ARCHIVE_NAME} 的校验值。`);
  if (sha256(archivePath) !== expected) {
    fail("SHA-256 校验失败；文件可能不完整，安装已停止。");
  }

  const listing = runTar(["-tzf", ARCHIVE_NAME], tmpDir);
  if (listing.status !== 0) {
    fail(`安装包无法读取，安装已停止。tar 退出码 ${listing.status}：${(listing.stderr || "").trim().slice(0, 300)}`);
  }
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
      fail("安装包包含不安全的路径，安装已停止。");
    }
  }
  const extraction = runTar(["-xzf", ARCHIVE_NAME], tmpDir);
  if (extraction.status !== 0) {
    fail(`安装包解压失败，安装已停止。tar 退出码 ${extraction.status}：${(extraction.stderr || "").trim().slice(0, 300)}`);
  }

  const packageDir = path.join(tmpDir, `chengfeng-videocut-${VERSION}`);
  for (const [relativePath, label] of [
    ["cli.js", "cli.js"],
    [path.join("studio", "index.html"), "Studio"],
    [path.join("legal", "LICENSE"), "许可证"],
    ["chengfeng-videocut", "可执行启动器"],
    ["VERSION", "版本信息"],
  ]) {
    if (!existsSync(path.join(packageDir, relativePath))) {
      fail(`安装包缺少 ${label}。`);
    }
  }
  const packagedVersion = readFileSync(path.join(packageDir, "VERSION"), "utf8").split(/\r?\n/)[0];
  if (packagedVersion !== VERSION) fail("安装包版本与安装器不一致。");

  mkdirSync(APP_ROOT, { recursive: true });
  mkdirSync(BIN_ROOT, { recursive: true });

  if (existsSync(CURRENT_LINK) && !isLink(CURRENT_LINK)) {
    fail(`${CURRENT_LINK} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
  }
  if (existsSync(BIN_LINK) && !isLink(BIN_LINK) && !IS_WINDOWS) {
    fail(`${BIN_LINK} 已存在且不是链接；为避免覆盖用户文件，安装已停止。`);
  }

  const newDir = path.join(APP_ROOT, `.${VERSION}.new.${process.pid}`);
  const backupDir = path.join(APP_ROOT, `.${VERSION}.backup.${process.pid}`);
  rmSync(newDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
  // 临时目录与安装根可能不在同一卷（Windows 上 C:\Temp → D:\），rename 会 EXDEV；
  // 与 install.sh 的 cp -R 同语义，复制进同卷暂存名后再原子 rename。
  cpSync(packageDir, newDir, { recursive: true });

  if (existsSync(TARGET_DIR)) renameSync(TARGET_DIR, backupDir);
  try {
    renameSync(newDir, TARGET_DIR);
    rmSync(backupDir, { recursive: true, force: true });
  } catch {
    if (existsSync(backupDir)) renameSync(backupDir, TARGET_DIR);
    fail("无法写入安装目录。");
  }

  if (IS_WINDOWS) {
    // junction 需要绝对目标，且普通用户免权限；.cmd 是真实文件而非链接。
    replaceLink(CURRENT_LINK, TARGET_DIR, "junction");
    writeFileSync(BIN_LINK, WINDOWS_LAUNCHER.replaceAll("\n", "\r\n"));
  } else {
    replaceLink(CURRENT_LINK, VERSION, "dir");
    replaceLink(BIN_LINK, path.join("..", "app", "current", "chengfeng-videocut"), "file");
    chmodSync(path.join(TARGET_DIR, "chengfeng-videocut"), 0o755);
  }

  process.stdout.write(`\nchengfeng-videocut ${VERSION} 已安装完成。\n`);
  process.stdout.write(`启动并打开：${BIN_LINK} service ensure --open\n`);
  process.stdout.write(`检查：${BIN_LINK} doctor\n`);
  process.stdout.write("安装器不会自动注册后台服务；首次 service ensure 时才会安装并启动。\n");
  if (IS_WINDOWS) {
    process.stdout.write(`如需直接输入命令，把 ${BIN_ROOT} 加入系统 PATH。\n`);
  } else {
    process.stdout.write('如需直接输入命令，把这一行加入 shell 配置：export PATH="$HOME/.chengfeng-videocut/bin:$PATH"\n');
  }

  const probe = spawnSync(bunExecutable, [path.join(TARGET_DIR, "cli.js"), "--version"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) fail("安装完成但版本自证失败，请上报 Issue。");
  process.stdout.write(probe.stdout);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
