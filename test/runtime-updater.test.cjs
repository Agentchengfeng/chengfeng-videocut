"use strict";

// 这组不是函数 mock：每一例都启动真实 install.cjs 子进程，经过 file:// 下载、
// SHA-256、tar、pending 同卷提升、current 链接和 journal。最小 CLI 夹具只替代
// 便携包内不可在测试机注册的 launchd/Task Scheduler 服务。

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const { gzipSync } = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const INSTALLER = path.join(ROOT, "install.cjs");
const SHELL_INSTALLER = path.join(ROOT, "install.sh");
// 单一版本源：夹具版本必须跟 package.json 走，否则 install.cjs 会把
// chengfeng-videocut-<旧版本>/ 归档根当作「不安全的路径」拒绝（0.5.2–0.5.8 期间就是这么漂移的）。
const VERSION = require("../package.json").version;
const IS_WINDOWS = process.platform === "win32";
// Windows 上 JS 版 realpathSync 不展开 8.3 短名（RUNNER~1），native 版才展开；
// 夹具根统一走 native，避免与 install.cjs 的 canonicalPath 口径不一致。
const canonicalRealpath = realpathSync.native ?? realpathSync;
// Windows 上 os.homedir() 读 USERPROFILE 而不是 HOME；夹具改「用户目录」时两者必须一起改，
// 否则 install.cjs 会把夹具根当成自定义 --target-root 拒绝 --ensure-service / --recover-rollback。
function homeEnv(directory) {
  return IS_WINDOWS ? { HOME: directory, USERPROFILE: directory } : { HOME: directory };
}
const PROJECT_CONTENT = "project must survive update transaction\n";

function writeExecutable(destination, content) {
  writeFileSync(destination, content, { mode: 0o755 });
}

function fixtureStudioBuildId(studioDir) {
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

function capabilitiesFor(version, marker) {
  return {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    studioVersion: version,
    features: { topLevelViews: [marker] },
  };
}

function fakeCli({
  version,
  service = "absent",
  buildId,
  hangVersion = false,
  spamVersion = false,
  inheritPipeVersion = false,
}) {
  const statusPresent = service === "managed" || service === "managed-restore-fail";
  const ensureHealthy = service !== "fail" && service !== "managed-restore-fail";
  const hangOnEnsure = service === "hang";
  const spamOnEnsure = service === "spam";
  const descendantScript = `
const pidFile = process.env.CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE;
if (pidFile) require("node:fs").writeFileSync(pidFile, String(process.pid));
process.on("SIGTERM", () => {});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
`;
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
function hangIgnoringTermination() {
  const pidFile = process.env.CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE;
  if (process.env.CHENGFENG_VIDEOCUT_TEST_DETACHED_RESIDUAL === '1') {
    const residual = require('node:child_process').spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    if (pidFile) require('node:fs').writeFileSync(pidFile, String(residual.pid));
    residual.unref();
  } else if (pidFile) {
    require('node:fs').writeFileSync(pidFile, String(process.pid));
  }
  process.on('SIGTERM', () => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}
function spamIgnoringTermination() {
  const pidFile = process.env.CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE;
  if (pidFile) require('node:fs').writeFileSync(pidFile, String(process.pid));
  process.on('SIGTERM', () => {});
  process.stdout.write('x'.repeat(262144));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}
if (args[0] === '--version') {
  if (${hangVersion}) hangIgnoringTermination();
  if (${spamVersion}) spamIgnoringTermination();
  if (${inheritPipeVersion}) {
    require('node:child_process').spawn(
      process.execPath,
      ['-e', ${JSON.stringify(descendantScript)}],
      { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
    );
  }
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (args[0] === 'service') {
  const action = args[1];
  const startsService = action === 'ensure' || action === 'restart';
  if (process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG) {
    require('node:fs').appendFileSync(
      process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG,
      ${JSON.stringify(version)} + ':' + action + '\\n',
    );
  }
  const isStatus = action === 'status';
  // The fault models the candidate lifecycle request itself. A timed-out
  // ensure/restart may still need a subsequent healthy service stop during
  // rollback.
  if (startsService && ${hangOnEnsure}) hangIgnoringTermination();
  if (startsService && ${spamOnEnsure}) spamIgnoringTermination();
  const failEnsureOncePath = process.env.CHENGFENG_VIDEOCUT_TEST_FAIL_ENSURE_ONCE_PATH;
  const failEnsureOnce = !isStatus && startsService && failEnsureOncePath &&
    !require('node:fs').existsSync(failEnsureOncePath);
  if (failEnsureOnce) require('node:fs').writeFileSync(failEnsureOncePath, 'failed');
  if (
    action === 'ensure' &&
    ${JSON.stringify(version !== VERSION)} &&
    process.env.CHENGFENG_VIDEOCUT_TEST_REQUIRE_LEGACY_LAUNCHER_ON_OLD_ENSURE === '1'
  ) {
    const launcher = process.env.CHENGFENG_VIDEOCUT_EXECUTABLE;
    let legacy = false;
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.dirname(path.dirname(launcher));
      const managedBun = path.join(root, 'tools', 'current', process.platform === 'win32' ? 'bun.exe' : 'bun');
      legacy = process.platform === 'win32'
        ? fs.readFileSync(launcher, 'utf8').includes('where bun.exe')
        : fs.lstatSync(launcher).isSymbolicLink() &&
          fs.readlinkSync(launcher) === '../app/current/chengfeng-videocut';
      legacy = legacy && fs.existsSync(managedBun);
    } catch {
      legacy = false;
    }
    if (!legacy) {
      console.error('old service was restored before its legacy stable launcher');
      process.exit(42);
    }
  }
  const present = isStatus ? ${statusPresent} : true;
  const healthy = isStatus ? ${statusPresent} : (${ensureHealthy} && !failEnsureOnce);
  const pid = Number(process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_PID || process.pid);
  const specificUrl = ${version === VERSION}
    ? process.env.CHENGFENG_VIDEOCUT_TEST_NEW_SERVICE_URL
    : process.env.CHENGFENG_VIDEOCUT_TEST_OLD_SERVICE_URL;
  const url = specificUrl || process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_URL || 'http://127.0.0.1:1';
  const runtimeMode = 'fixture-task';
  const studioBuildId = ${JSON.stringify(buildId)};
  const data = {
    installed: present,
    loaded: present,
    configured: present,
    ready: healthy,
    healthy,
    pid,
    runtimeMode,
    productVersion: ${JSON.stringify(version)},
    studioBuildId,
    url,
    identity: {
      product: 'chengfeng-videocut',
      productVersion: ${JSON.stringify(version)},
      pid,
      runtimeMode,
      studioBuildId,
    },
  };
  if (!isStatus && startsService && ${version === VERSION} &&
    process.env.CHENGFENG_VIDEOCUT_TEST_ENSURE_INVALID_AFTER_START === '1') {
    console.log('candidate service started but installer reply is invalid');
    process.exit(17);
  }
  console.log(JSON.stringify({ schemaVersion: 1, product: 'chengfeng-videocut', command: 'service.' + action, ok: true, data }));
  process.exit(0);
}
console.error('unexpected fixture CLI command', args.join(' ')); process.exit(64);
`;
}

function writeRuntimeLayout(bundle, {
  version,
  cliVersion = version,
  service = "absent",
  marker,
  portable = true,
  launcherMode = 0o755,
  hangVersion = false,
  spamVersion = false,
  inheritPipeVersion = false,
}) {
  mkdirSync(path.join(bundle, "studio"), { recursive: true });
  mkdirSync(path.join(bundle, "legal"), { recursive: true });
  const capabilities = capabilitiesFor(version, marker);
  writeFileSync(path.join(bundle, "studio", "index.html"), `<html><body>${marker}</body></html>\n`);
  writeFileSync(
    path.join(bundle, "studio", "chengfeng-videocut-capabilities.json"),
    JSON.stringify(capabilities),
  );
  const buildId = fixtureStudioBuildId(path.join(bundle, "studio"));
  writeExecutable(path.join(bundle, "cli.js"), fakeCli({
    version: cliVersion,
    service,
    buildId,
    hangVersion,
    spamVersion,
    inheritPipeVersion,
  }));
  if (portable) {
    writeExecutable(path.join(bundle, "chengfeng-videocut"), "#!/bin/sh\nexit 0\n");
    if (!IS_WINDOWS) chmodSync(path.join(bundle, "chengfeng-videocut"), launcherMode);
    writeFileSync(path.join(bundle, "VERSION"), `${version}\n`);
    writeFileSync(path.join(bundle, "legal", "LICENSE"), "fixture\n");
  }
  return { buildId, capabilities };
}

function makePackage(root, {
  version = VERSION,
  cliVersion = VERSION,
  service = "absent",
  launcherMode = 0o755,
  hangVersion = false,
  spamVersion = false,
  inheritPipeVersion = false,
} = {}) {
  const bundle = path.join(root, `chengfeng-videocut-${VERSION}`);
  const identity = writeRuntimeLayout(bundle, {
    version,
    cliVersion,
    service,
    marker: `fixture-${version}`,
    launcherMode,
    hangVersion,
    spamVersion,
    inheritPipeVersion,
  });
  return { bundle, ...identity };
}

function packageRelease(root, release, bundle) {
  mkdirSync(release, { recursive: true });
  const archive = path.join(release, "chengfeng-videocut-portable.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, path.basename(bundle)]);
  const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(path.join(release, "SHA256SUMS.txt"), `${checksum}  chengfeng-videocut-portable.tar.gz\n`);
}

function writeSymlinkRootRelease(release, linkTarget) {
  mkdirSync(release, { recursive: true });
  const header = Buffer.alloc(512);
  const writeField = (offset, length, value) => {
    header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
  };
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeField(0, 100, `chengfeng-videocut-${VERSION}`);
  writeField(100, 8, octal(0o777, 8));
  writeField(108, 8, octal(0, 8));
  writeField(116, 8, octal(0, 8));
  writeField(124, 12, octal(0, 12));
  writeField(136, 12, octal(Math.floor(Date.now() / 1_000), 12));
  header.fill(0x20, 148, 156);
  writeField(156, 1, "2");
  writeField(157, 100, linkTarget);
  writeField(257, 6, "ustar\0");
  writeField(263, 2, "00");
  writeField(265, 32, "fixture");
  writeField(297, 32, "fixture");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const archive = path.join(release, "chengfeng-videocut-portable.tar.gz");
  writeFileSync(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1_024)])));
  const archiveHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(path.join(release, "SHA256SUMS.txt"), `${archiveHash}  chengfeng-videocut-portable.tar.gz\n`);
}

function makeRelease(root, options = {}) {
  const release = path.join(root, "release");
  const packageInfo = makePackage(root, options);
  packageRelease(root, release, packageInfo.bundle);
  return { release, ...packageInfo };
}

function makeFormalRelease(root, release, bundle, {
  toolsSchema = 4,
} = {}) {
  const platformKey = `${process.platform}-${process.arch}`;
  const [platform, arch] = platformKey.split("-");
  const runtimeAsset = `chengfeng-videocut-runtime-${VERSION}.tar.gz`;
  copyFileSync(path.join(release, "chengfeng-videocut-portable.tar.gz"), path.join(release, runtimeAsset));
  const toolsRootName = `chengfeng-videocut-tools-${VERSION}-${platformKey}`;
  const toolsRoot = path.join(root, toolsRootName);
  if (![2, 3, 4].includes(toolsSchema)) throw new Error(`unsupported tools schema fixture: ${toolsSchema}`);
  mkdirSync(toolsRoot, { recursive: true });
  if (toolsSchema === 2) mkdirSync(path.join(toolsRoot, "chrome"), { recursive: true });
  if (toolsSchema === 3) mkdirSync(path.join(toolsRoot, "resources"), { recursive: true });
  const suffix = IS_WINDOWS ? ".exe" : "";
  copyFileSync(process.execPath, path.join(toolsRoot, `bun${suffix}`));
  if (!IS_WINDOWS) chmodSync(path.join(toolsRoot, "bun"), 0o755);
  writeExecutable(path.join(toolsRoot, `ffmpeg${suffix}`), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(toolsRoot, `ffprobe${suffix}`), "#!/bin/sh\nexit 0\n");
  if (toolsSchema === 2) writeExecutable(path.join(toolsRoot, "chrome", `chrome${suffix}`), "#!/bin/sh\nexit 0\n");
  const executableNames = {
    bun: `bun${suffix}`,
    ffmpeg: `ffmpeg${suffix}`,
    ffprobe: `ffprobe${suffix}`,
  };
  if (toolsSchema === 2) executableNames.chrome = `chrome/chrome${suffix}`;
  const rendererArchiveRelative = "resources/export-renderer.tar.gz";
  if (toolsSchema === 3) writeFileSync(path.join(toolsRoot, rendererArchiveRelative), "opaque Electron renderer fixture\n");
  const files = [
    ...Object.values(executableNames),
    ...(toolsSchema === 3 ? [rendererArchiveRelative] : []),
  ].map((relative) => {
    const bytes = readFileSync(path.join(toolsRoot, relative));
    return { path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const rendererFile = files.find((record) => record.path === rendererArchiveRelative);
  writeFileSync(path.join(toolsRoot, "resources-manifest.json"), `${JSON.stringify({
    schemaVersion: toolsSchema,
    product: "chengfeng-videocut-managed-tools",
    productVersion: VERSION,
    platform,
    arch,
    executables: executableNames,
    versions: {
      bun: "fixture",
      ffmpeg: "fixture",
      ffprobe: "fixture",
      ...(toolsSchema === 2 ? { chrome: "fixture" } : {}),
    },
    ...(toolsSchema === 3 ? {
      resources: {
        exportRenderer: {
          archive: rendererArchiveRelative,
          sha256: rendererFile.sha256,
          size: rendererFile.size,
          root: "chengfeng-videocut-export-renderer-fixture",
          rendererManifestSha256: "a".repeat(64),
          worker: {
            executable: IS_WINDOWS ? "electron/electron.exe" : "electron/Electron.app/Contents/MacOS/Electron",
            arguments: ["app/main.mjs"],
          },
        },
      },
    } : {}),
    distributionMode: "local-test-only",
    files,
    licenseStatus: "UNVERIFIED",
    licenseNote: "test fixture only",
  })}\n`);
  const toolsAsset = `${toolsRootName}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(release, toolsAsset), "-C", root, toolsRootName]);
  const toolsArchivePath = path.join(release, toolsAsset);
  const toolsArchiveBytes = readFileSync(toolsArchivePath);
  writeFileSync(`${toolsArchivePath}.json`, `${JSON.stringify({
    platformKey,
    asset: toolsAsset,
    root: toolsRootName,
    sha256: createHash("sha256").update(toolsArchiveBytes).digest("hex"),
    size: toolsArchiveBytes.length,
    resourcesManifestSha256: createHash("sha256")
      .update(readFileSync(path.join(toolsRoot, "resources-manifest.json")))
      .digest("hex"),
    distributionMode: "local-test-only",
    licenseStatus: "UNVERIFIED",
  })}\n`);
  const fileRecord = (name, withRoot = false) => {
    const bytes = readFileSync(path.join(release, name));
    return {
      asset: name,
      ...(withRoot ? { root: name.slice(0, -".tar.gz".length) } : {}),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  };
  const installerNames = {
    "darwin-arm64": "chengfeng-videocut-installer-macos-arm64",
    "darwin-x64": "chengfeng-videocut-installer-macos-x64",
    "win32-x64": "chengfeng-videocut-installer-windows-x64.exe",
  };
  for (const name of Object.values(installerNames)) writeFileSync(path.join(release, name), "fixture-installer\n");
  const runtimeBytes = readFileSync(path.join(release, runtimeAsset));
  const platforms = Object.fromEntries(Object.entries(installerNames).map(([key, installerAsset]) => [key, {
    installerAsset,
    installer: fileRecord(installerAsset),
    tools: key === platformKey
      ? fileRecord(toolsAsset, true)
      : { asset: `unused-${key}.tar.gz`, root: `unused-${key}`, sha256: "0".repeat(64), size: 1 },
  }]));
  const manifest = {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    productVersion: VERSION,
    releaseTag: `v${VERSION}`,
    distributionMode: "local-test-only",
    runtime: {
      asset: runtimeAsset,
      root: path.basename(bundle),
      sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
      size: runtimeBytes.length,
    },
    platforms,
    licenseStatus: "UNVERIFIED",
    licenseNote: "test fixture only",
  };
  const manifestPath = path.join(release, "chengfeng-videocut-install-manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  writeFileSync(manifestPath, manifestBytes);
  const checksumPath = path.join(release, "formal-SHA256SUMS.txt");
  writeFileSync(
    checksumPath,
    `${createHash("sha256").update(manifestBytes).digest("hex")}  chengfeng-videocut-install-manifest.json\n`,
  );
  return { manifestPath, checksumPath };
}

function invokeFormal(executable, home, release, formal, extraArgs = [], extraEnv = {}) {
  return spawnSync(executable, [
    ...(executable === process.execPath ? [INSTALLER] : []),
    "--manifest", formal.manifestPath,
    "--checksum-file", formal.checksumPath,
    "--target-root", home,
    "--allow-unverified-local-fixture",
    "--json",
    ...extraArgs,
  ], {
    env: {
      ...process.env,
      ...homeEnv(path.dirname(home)),
      CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(release).href.replace(/\/$/, ""),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function invokeEmbedded(executable, home, extraArgs = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    "CHENGFENG_VIDEOCUT_INSTALL_MANIFEST",
    "CHENGFENG_VIDEOCUT_MANIFEST_CHECKSUM_FILE",
    "CHENGFENG_VIDEOCUT_DOWNLOAD_BASE",
    "CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR",
  ]) delete env[key];
  return spawnSync(executable, [
    "--target-root", home,
    "--allow-unverified-local-fixture",
    "--json",
    ...extraArgs,
  ], {
    env: {
      ...env,
      CHENGFENG_VIDEOCUT_ALLOW_UNVERIFIED_LOCAL_TOOLS: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function makeEmbeddedPayload(root, formal, { missingRuntimePayload = false } = {}) {
  const manifest = JSON.parse(readFileSync(formal.manifestPath, "utf8"));
  const platformKey = `${process.platform}-${process.arch}`;
  const embeddedChecksum = path.join(root, "embedded-installer-payload-SHA256SUMS.txt");
  const manifestBytes = readFileSync(formal.manifestPath);
  writeFileSync(
    embeddedChecksum,
    [
      `${createHash("sha256").update(manifestBytes).digest("hex")}  chengfeng-videocut-installer-payload-manifest.json`,
      `${manifest.runtime.sha256}  ${manifest.runtime.asset}`,
      `${manifest.platforms[platformKey].tools.sha256}  ${manifest.platforms[platformKey].tools.asset}`,
    ].join("\n") + "\n",
  );
  return {
    schemaVersion: 1,
    platformKey,
    manifestPath: formal.manifestPath,
    checksumPath: embeddedChecksum,
    runtimePath: missingRuntimePayload
      ? path.join(root, "runtime-payload-must-not-be-read.tar.gz")
      : path.join(path.dirname(formal.manifestPath), manifest.runtime.asset),
    toolsPath: path.join(
      path.dirname(formal.manifestPath),
      manifest.platforms[platformKey].tools.asset,
    ),
  };
}

function invokeEmbeddedPayload(home, payload, extraArgs = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    "CHENGFENG_VIDEOCUT_INSTALL_MANIFEST",
    "CHENGFENG_VIDEOCUT_MANIFEST_CHECKSUM_FILE",
    "CHENGFENG_VIDEOCUT_DOWNLOAD_BASE",
    "CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR",
  ]) delete env[key];
  return spawnSync(process.execPath, [
    "-e",
    `globalThis.__CHENGFENG_VIDEOCUT_EMBEDDED_PAYLOAD__ = Object.freeze(JSON.parse(process.env.CHENGFENG_VIDEOCUT_TEST_EMBEDDED_PAYLOAD));
const installer = require(process.env.CHENGFENG_VIDEOCUT_TEST_INSTALLER);
Promise.resolve(installer.main()).catch((error) => {
  installer.reportMainFailure(error);
  process.exitCode = 1;
});`,
    "--",
    "--target-root", home,
    "--allow-unverified-local-fixture",
    "--json",
    ...extraArgs,
  ], {
    env: {
      ...env,
      ...homeEnv(path.dirname(home)),
      CHENGFENG_VIDEOCUT_TEST_EMBEDDED_PAYLOAD: JSON.stringify(payload),
      CHENGFENG_VIDEOCUT_TEST_INSTALLER: INSTALLER,
      CHENGFENG_VIDEOCUT_ALLOW_UNVERIFIED_LOCAL_TOOLS: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function invokeStableLauncher(launcher, args, options = {}) {
  if (!IS_WINDOWS) return spawnSync(launcher, args, options);
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  // 与 install.cjs 的 runExecutable 一致：整条命令行已按 cmd 规则加好引号，
  // 必须 windowsVerbatimArguments，否则 Node 会再包一层引号并把内部 " 转成 \"，cmd.exe 无法解析。
  return spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/v:off", "/s", "/c", `"${quote(launcher)} ${args.map(quote).join(" ")}"`],
    { ...options, windowsVerbatimArguments: true },
  );
}

function addInstallerBootstrapAssets(release, { tamperInstaller = false } = {}) {
  const releaseInstaller = path.join(release, "install.cjs");
  copyFileSync(INSTALLER, releaseInstaller);
  const checksum = createHash("sha256").update(readFileSync(releaseInstaller)).digest("hex");
  writeFileSync(
    path.join(release, "SHA256SUMS.txt"),
    `${readFileSync(path.join(release, "SHA256SUMS.txt"), "utf8")}${checksum}  install.cjs\n`,
  );
  if (tamperInstaller) {
    writeFileSync(releaseInstaller, `${readFileSync(releaseInstaller, "utf8")}\n// tampered after checksums\n`);
  }
}

// Windows 上 install.cjs 先在全部 PATH 目录里找 bun.exe，再找 bun.cmd；
// 测试要用假 Bun 版本时必须把 runner 上真 bun.exe 所在目录剔掉，假 bun.cmd 才能生效。
function inheritedPathForFakeBun(reportedBunVersion) {
  const inherited = process.env.PATH || "";
  if (!IS_WINDOWS || !reportedBunVersion) return inherited;
  return inherited
    .split(path.delimiter)
    .filter((entry) => entry && !existsSync(path.join(entry, "bun.exe")))
    .join(path.delimiter);
}

function installEnv(home, release, extra = {}) {
  const fakeBin = path.join(path.dirname(home), "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const reportedBunVersion = extra.CHENGFENG_VIDEOCUT_TEST_BUN_VERSION;
  if (IS_WINDOWS) {
    writeFileSync(
      path.join(fakeBin, "bun.cmd"),
      reportedBunVersion
        ? reportedBunVersion === "hang"
          ? "@echo off\r\nping -n 60 127.0.0.1 >nul\r\n"
          : `@echo off\r\necho ${reportedBunVersion}\r\n`
        : `@echo off\r\n"${process.execPath}" %*\r\n`,
    );
  } else {
    writeExecutable(
      path.join(fakeBin, "bun"),
      reportedBunVersion
        ? reportedBunVersion === "hang"
          ? "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n"
          : `#!/bin/sh\necho ${JSON.stringify(reportedBunVersion)}\n`
        : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
  }
  return {
    ...process.env,
    ...homeEnv(path.dirname(home)),
    PATH: `${fakeBin}${path.delimiter}${inheritedPathForFakeBun(reportedBunVersion)}`,
    CHENGFENG_VIDEOCUT_HOME: home,
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(release).href.replace(/\/$/, ""),
    ...extra,
  };
}

function invokeWithArgs(home, release, args = [], extra = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    env: installEnv(home, release, extra),
    encoding: "utf8",
  });
}

function invoke(home, release, extra = {}) {
  return invokeWithArgs(home, release, [], extra);
}

async function waitForPath(candidate, predicate = () => true, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(candidate) && predicate(candidate)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${candidate}`);
}

async function childResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status, signal] = await once(child, "close");
  return { status, signal, stdout, stderr };
}

async function startCapabilityServer(t, root, home, {
  stallPath = "",
  stallVersion = VERSION,
  redirectPath = "",
  redirectVersion = VERSION,
} = {}) {
  const serverScript = path.join(root, "capability-server.cjs");
  const readyPath = path.join(root, "capability-server.json");
  writeFileSync(serverScript, `"use strict";
const http = require("node:http");
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const home = process.argv[2];
const ready = process.argv[3];
const stallPath = process.argv[4];
const stallVersion = process.argv[5];
const redirectPath = process.argv[6];
const redirectVersion = process.argv[7];
const redirectHitPath = ready + ".redirect-hit";
function buildId(studioDir) {
  const digest = createHash("sha256");
  const walk = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile() && !relative.endsWith(".tsbuildinfo")) {
        digest.update("/" + relative);
        digest.update(readFileSync(absolute));
      }
    }
  };
  walk(studioDir);
  return digest.digest("hex").slice(0, 16);
}
const server = http.createServer((request, response) => {
  try {
    const studio = path.join(home, "app", "current", "studio");
    const capabilities = JSON.parse(readFileSync(path.join(studio, "chengfeng-videocut-capabilities.json"), "utf8"));
    if (request.url === stallPath && capabilities.studioVersion === stallVersion) return;
    if (request.url === "/redirect-target") {
      writeFileSync(redirectHitPath, "followed");
      response.writeHead(418).end();
      return;
    }
    if (request.url === redirectPath && capabilities.studioVersion === redirectVersion) {
      response.writeHead(302, { Location: "/redirect-target" }).end();
      return;
    }
    let body;
    if (request.url === "/chengfeng-videocut-capabilities.json") {
      body = JSON.stringify(capabilities);
    } else if (request.url === "/api/health") {
      body = JSON.stringify({
        schemaVersion: 1,
        ok: true,
        product: "chengfeng-videocut",
        productVersion: capabilities.studioVersion,
        pid: process.pid,
        runtimeMode: "fixture-task",
        studioBuildId: buildId(studio),
      });
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const receipt = ready + ".tmp";
  writeFileSync(receipt, JSON.stringify({
    url: "http://127.0.0.1:" + address.port,
    pid: process.pid,
    redirectHitPath,
  }));
  renameSync(receipt, ready);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
`);
  const child = spawn(
    process.execPath,
    [serverScript, home, readyPath, stallPath, stallVersion, redirectPath, redirectVersion],
    { stdio: "ignore" },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), delay(1_000)]);
    }
  });
  await waitForPath(readyPath);
  return JSON.parse(readFileSync(readyPath, "utf8"));
}

function currentTarget(home) {
  const link = path.join(home, "app", "current");
  return path.resolve(path.dirname(link), readlinkSync(link));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for process ${pid} to exit`);
}

function createLegacyRuntime(home, { version = "0.4.7", service = "absent" } = {}) {
  const runtime = path.join(home, "app", version);
  const identity = writeRuntimeLayout(runtime, {
    version,
    service,
    marker: `legacy-${version}`,
    portable: false,
  });
  symlinkSync(
    IS_WINDOWS ? runtime : version,
    path.join(home, "app", "current"),
    IS_WINDOWS ? "junction" : "dir",
  );
  const project = path.join(home, "projects", "keep-me.txt");
  mkdirSync(path.dirname(project), { recursive: true });
  writeFileSync(project, PROJECT_CONTENT);
  return { runtime, ...identity };
}

function createLegacyStableLauncher(home, runtime) {
  const packagedLauncher = path.join(runtime, "chengfeng-videocut");
  writeExecutable(packagedLauncher, "#!/bin/sh\nexit 0\n");
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = path.join(bin, "chengfeng-videocut");
  symlinkSync(path.join("..", "app", "current", "chengfeng-videocut"), launcher, "file");
  return launcher;
}

function assertProjectPreserved(home) {
  assert.equal(readFileSync(path.join(home, "projects", "keep-me.txt"), "utf8"), PROJECT_CONTENT);
}

function createManagedTools(home, { oldVersion = "0.4.7", candidateVersion = VERSION } = {}) {
  const toolsRoot = path.join(home, "tools");
  const oldTools = path.join(toolsRoot, oldVersion);
  const candidateTools = path.join(path.dirname(home), "desktop-tools-source", candidateVersion);
  const suffix = IS_WINDOWS ? ".exe" : "";
  for (const directory of [oldTools, candidateTools]) {
    mkdirSync(directory, { recursive: true });
    const executables = Object.fromEntries(
      ["bun", "ffmpeg", "ffprobe"].map((name) => [name, `${name}${suffix}`]),
    );
    for (const [name, relative] of Object.entries(executables)) {
      writeExecutable(
        path.join(directory, relative),
        name === "bun"
          ? `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`
          : "#!/bin/sh\nexit 0\n",
      );
    }
    const files = Object.values(executables).map((relative) => {
      const bytes = readFileSync(path.join(directory, relative));
      return {
        path: relative,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    writeFileSync(path.join(directory, "resources-manifest.json"), `${JSON.stringify({
      schemaVersion: 4,
      product: "chengfeng-videocut-managed-tools",
      productVersion: VERSION,
      platform: process.platform,
      arch: process.arch,
      executables,
      versions: { bun: "fixture", ffmpeg: "fixture", ffprobe: "fixture" },
      files,
      licenseStatus: "VERIFIED",
    })}\n`);
  }
  symlinkSync(oldVersion, path.join(toolsRoot, "current"));
  return { toolsRoot, oldTools, candidateTools };
}

test("Windows stable launcher calls only managed tools/current Bun", () => {
  const source = readFileSync(INSTALLER, "utf8");
  const start = source.indexOf("function managedLauncherContents()");
  const end = source.indexOf("function legacyWindowsLauncherContents()");
  assert.ok(start >= 0 && end > start);
  const launcher = source.slice(start, end);
  assert.match(launcher, /set "MANAGED_TOOLS=%~dp0\.\.\\\\tools\\\\current"/);
  assert.match(launcher, /set "BUN_EXE=%MANAGED_TOOLS%\\\\bun\.exe"/);
  assert.match(launcher, /set "PATH=%MANAGED_TOOLS%;%PATH%"/);
  assert.doesNotMatch(launcher, /where bun|USERPROFILE|bun\.cmd/);
});

test("install.cjs embedded VERSION matches package.json so fixtures cannot drift", () => {
  const source = readFileSync(INSTALLER, "utf8");
  const match = source.match(/^const VERSION = "([^"]+)";$/m);
  assert.ok(match, "install.cjs must declare a single hardcoded VERSION");
  assert.equal(
    match[1],
    VERSION,
    `install.cjs VERSION ${match[1]} != package.json version ${VERSION}; bump both together`,
  );
});

// Windows 8.3 短名回归：GitHub runner 的 %TEMP% 是 C:\Users\RUNNER~1\...，
// 安装根含短名组件时 realpathSync.native 展开为长名，不能被误判成「规范路径跳转」。
test("Windows 8.3 short-name install root is a legal alias, not a canonical-path jump", {
  skip: !IS_WINDOWS,
}, (t) => {
  const { root, release } = fixture(t);
  const longDir = path.join(root, "updater-shortname-regression-longname");
  mkdirSync(longDir, { recursive: true });
  const shortDir = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longDir.replaceAll("'", "''")}').ShortPath`,
  ], { encoding: "utf8" }).trim();
  if (!shortDir || shortDir.toLowerCase() === longDir.toLowerCase()) {
    t.skip("8.3 short names are disabled on this volume; nothing to regress");
    return;
  }
  assert.notEqual(canonicalRealpath(shortDir).toLowerCase(), shortDir.toLowerCase(), "fixture must be a real short-name alias");
  const home = path.join(shortDir, "user", ".chengfeng-videocut");
  const result = invoke(home, release);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /规范路径跳转|reparse point/);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, VERSION);
  assert.equal(
    canonicalRealpath(currentTarget(home)).toLowerCase(),
    canonicalRealpath(path.join(home, "app", VERSION)).toLowerCase(),
  );
});

test("macOS shell bootstrap downloads and verifies install.cjs before a real local Release install", {
  skip: IS_WINDOWS,
}, (t) => {
  const { root, home, release } = fixture(t);
  addInstallerBootstrapAssets(release);
  const result = spawnSync("sh", [SHELL_INSTALLER], {
    env: {
      ...installEnv(home, release),
      ...homeEnv(path.join(root, "bootstrap-home")),
      TMPDIR: root,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已验证并激活/);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, VERSION);
});

test("macOS shell bootstrap rejects install.cjs changed after SHA256SUMS", {
  skip: IS_WINDOWS,
}, (t) => {
  const { root, home, release } = fixture(t);
  addInstallerBootstrapAssets(release, { tamperInstaller: true });
  const result = spawnSync("sh", [SHELL_INSTALLER], {
    env: {
      ...installEnv(home, release),
      ...homeEnv(path.join(root, "bootstrap-home")),
      TMPDIR: root,
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install\.cjs SHA-256 校验失败/);
  assert.equal(existsSync(path.join(home, "installer-state.json")), false);
  assert.equal(existsSync(path.join(home, "app", "current")), false);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
});

const COMPILED_EMBEDDED_INSTALLER_TARGETS = {
  "darwin-arm64": "chengfeng-videocut-installer-macos-arm64",
  "win32-x64": "chengfeng-videocut-installer-windows-x64.exe",
};

test("real compiled installer embeds one Runtime/tools payload, rejects an external source, and reuses with zero downloads", {
  skip: !Object.hasOwn(COMPILED_EMBEDDED_INSTALLER_TARGETS, `${process.platform}-${process.arch}`),
}, (t) => {
  const { root, home, release, bundle } = fixture(t);
  makeFormalRelease(root, release, bundle);
  const platformKey = `${process.platform}-${process.arch}`;
  const installerAsset = COMPILED_EMBEDDED_INSTALLER_TARGETS[platformKey];
  // Compile the real standalone artifact on the workspace release volume,
  // not inside the disposable Runtime fixture under the system temp volume.
  mkdirSync(path.join(ROOT, "release"), { recursive: true });
  const compiledRoot = mkdtempSync(path.join(ROOT, "release", "native-installer-test-"));
  // Windows filesystem filters can briefly keep a compiled staging entry in
  // use after the child exits. Let Node's bounded recursive retry absorb that
  // window; a persistent leak still fails instead of being hidden.
  t.after(() => rmSync(compiledRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  }));
  for (const asset of [
    `chengfeng-videocut-runtime-${VERSION}.tar.gz`,
    `chengfeng-videocut-tools-${VERSION}-${platformKey}.tar.gz`,
    `chengfeng-videocut-tools-${VERSION}-${platformKey}.tar.gz.json`,
  ]) copyFileSync(path.join(release, asset), path.join(compiledRoot, asset));
  const compiled = path.join(compiledRoot, installerAsset);
  const built = spawnSync("bun", [path.join(ROOT, "scripts/build-native-installer.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CHENGFENG_VIDEOCUT_RELEASE_DIR: compiledRoot,
      CHENGFENG_VIDEOCUT_INSTALLER_TARGETS: platformKey,
      CHENGFENG_VIDEOCUT_MANAGED_TOOLS_LOCK: path.join(ROOT, "installer/managed-tools.lock.json"),
    },
  });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  if (IS_WINDOWS) {
    assert.equal(readFileSync(compiled).subarray(0, 2).toString("ascii"), "MZ");
  } else {
    chmodSync(compiled, 0o755);
    assert.match(execFileSync("file", [compiled], { encoding: "utf8" }), /Mach-O 64-bit executable arm64/);
  }
  const rejectedHome = path.join(root, "external-source-rejected");
  const rejected = invokeEmbedded(compiled, rejectedHome, [], {
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: "https://invalid.example.test/release",
  });
  assert.ok(
    Number.isInteger(rejected.status) && rejected.status !== 0,
    `${rejected.error?.message || ""}\n${rejected.stderr || ""}`,
  );
  assert.match(
    `${rejected.stdout || ""}\n${rejected.stderr || ""}`,
    /自包含 Product Runtime 安装器不接受外部 manifest、checksum、下载源或 tools 来源/,
  );
  assert.equal(existsSync(rejectedHome), false);
  const first = invokeEmbedded(compiled, home);
  assert.equal(first.status, 0, `${first.error?.message || ""}\n${first.stderr}`);
  const firstPayload = JSON.parse(first.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(firstPayload.data.assetDownloads, 0);
  const launcher = path.join(home, "bin", IS_WINDOWS ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
  const metadata = lstatSync(launcher);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  if (!IS_WINDOWS) {
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.mode & 0o777, 0o755);
  }
  const version = invokeStableLauncher(launcher, ["--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: IS_WINDOWS ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin",
    },
  });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, new RegExp(VERSION.replaceAll(".", "\\.")));
  const managedBun = path.join(home, "tools", VERSION, IS_WINDOWS ? "bun.exe" : "bun");
  const hiddenManagedBun = `${managedBun}.missing`;
  renameSync(managedBun, hiddenManagedBun);
  const noFallback = invokeStableLauncher(launcher, ["--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: IS_WINDOWS ? `${process.env.SystemRoot}\\System32` : path.dirname(process.execPath),
    },
  });
  renameSync(hiddenManagedBun, managedBun);
  assert.equal(noFallback.status, 127);
  assert.match(noFallback.stderr, /managed Bun is missing/);
  if (!IS_WINDOWS) {
    unlinkSync(launcher);
    symlinkSync(path.join("..", "app", "current", "chengfeng-videocut"), launcher, "file");
  }
  const second = invokeEmbedded(compiled, home);
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(secondPayload.data.status, "reused");
  assert.equal(secondPayload.data.assetDownloads, 0);
  assert.equal(lstatSync(launcher).isSymbolicLink(), false);
  if (!IS_WINDOWS) assert.equal(lstatSync(launcher).nlink, 1);
  unlinkSync(path.join(home, "managed-tools-state.json"));
  const current = invokeEmbedded(compiled, home);
  assert.equal(current.status, 0, current.stderr);
  const currentPayload = JSON.parse(current.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(currentPayload.data.status, "current");
  assert.equal(currentPayload.data.assetDownloads, 0);
  const ffmpeg = path.join(home, "tools", VERSION, IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg");
  writeFileSync(ffmpeg, `${readFileSync(ffmpeg, "utf8")}drift\n`);
  const damaged = invokeEmbedded(compiled, home);
  assert.notEqual(damaged.status, 0);
  assert.doesNotMatch(damaged.stdout, /"status":"reused"/);
  const damagedPayload = JSON.parse(damaged.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(damagedPayload.ok, false);
  assert.match(damagedPayload.error.message, /文件校验失败|完整树摘要漂移/);
});

function readState(home) {
  return JSON.parse(readFileSync(path.join(home, "installer-state.json"), "utf8"));
}

function fixture(t, releaseOptions) {
  const root = canonicalRealpath(mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-updater-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "user", ".chengfeng-videocut");
  const releaseInfo = makeRelease(root, releaseOptions);
  return { root, home, ...releaseInfo };
}

test("formal schema 4 tools install accepts only Bun, FFmpeg and FFprobe", (t) => {
  const { root, home, release, bundle } = fixture(t);
  const formal = makeFormalRelease(root, release, bundle, { toolsSchema: 4 });
  const result = invokeFormal(process.execPath, home, release, formal);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.ok, true);
  const toolsManifest = JSON.parse(readFileSync(
    path.join(home, "tools", VERSION, "resources-manifest.json"),
    "utf8",
  ));
  assert.equal(toolsManifest.schemaVersion, 4);
  assert.equal(Object.hasOwn(toolsManifest, "resources"), false);
  assert.equal(Object.hasOwn(toolsManifest.executables, "chrome"), false);
});

test("formal legacy Chrome and Electron tool archives do not activate", (t) => {
  for (const toolsSchema of [2, 3]) {
    const { root, home, release, bundle } = fixture(t);
    const formal = makeFormalRelease(root, release, bundle, { toolsSchema });
    const result = invokeFormal(process.execPath, home, release, formal);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /schemaVersion 4；旧 Chrome\/Electron 工具包不会被激活/);
    assert.equal(existsSync(path.join(home, "app", "current")), false);
    assert.equal(existsSync(path.join(home, "tools", "current")), false);
  }
});

test("upgrade validates pending candidate before current, preserves projects, then activates", (t) => {
  const { home, release } = fixture(t);
  createLegacyRuntime(home);
  const result = invoke(home, release);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assertProjectPreserved(home);
  assert.deepEqual(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, VERSION);
  assert.equal(readState(home).previous.version, "0.4.7");
  assert.equal(existsSync(path.join(home, "app", ".pending")), true);
});

test("0.4.7 exact legacy symlink migrates to a single-link regular managed launcher", {
  skip: IS_WINDOWS,
}, (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const launcher = createLegacyStableLauncher(home, old.runtime);
  assert.equal(lstatSync(launcher).isSymbolicLink(), true);
  const result = invoke(home, release);
  assert.equal(result.status, 0, result.stderr);
  const metadata = lstatSync(launcher);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o755);
  const contents = readFileSync(launcher, "utf8");
  assert.match(contents, /BUN_EXE="\$MANAGED_TOOLS\/bun"/);
  assert.doesNotMatch(contents, /command -v bun|\.bun\/bin|homebrew/);
});

test("unknown stable launcher symlink is rejected without touching its target", {
  skip: IS_WINDOWS,
}, (t) => {
  const { root, home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const outside = path.join(root, "outside-launcher");
  writeExecutable(outside, "#!/bin/sh\nexit 0\n");
  mkdirSync(path.join(home, "bin"), { recursive: true });
  symlinkSync(outside, path.join(home, "bin", "chengfeng-videocut"));
  const before = readFileSync(outside, "utf8");
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知 symlink/);
  assert.equal(readFileSync(outside, "utf8"), before);
  assert.equal(currentTarget(home), old.runtime);
});

test("installer rejects Bun older than 1.2 before changing Runtime state", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const result = invoke(home, release, { CHENGFENG_VIDEOCUT_TEST_BUN_VERSION: "1.1.35" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /需要 Bun 1\.2 或更高版本/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(existsSync(path.join(home, "installer-state.json")), false);
  assertProjectPreserved(home);
});

test("installer bounds a hung Bun version probe before changing Runtime state", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const startedAt = Date.now();
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_BUN_VERSION: "hang",
    CHENGFENG_VIDEOCUT_TEST_BUN_VERSION_PROBE_TIMEOUT_MS: "100",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无法验证 Bun 版本.*ETIMEDOUT/);
  assert.ok(Date.now() - startedAt < 5_000, result.stderr);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(existsSync(path.join(home, "installer-state.json")), false);
  assertProjectPreserved(home);
});

test("candidate self-test failure deletes pending and leaves old current and projects intact", (t) => {
  const { home, release } = fixture(t, { cliVersion: "0.4.7" });
  const old = createLegacyRuntime(home);
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /候选 Runtime 版本不一致/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, "0.4.7");
  assert.equal(existsSync(path.join(home, "app", ".pending")), true);
  assert.deepEqual(readdirSync(path.join(home, "app", ".pending")), []);
  assertProjectPreserved(home);
});

test("candidate version self-test that ignores SIGTERM is hard-bounded before activation", async (t) => {
  const { root, home, release } = fixture(t, { hangVersion: true });
  const old = createLegacyRuntime(home);
  const pidFile = path.join(root, "hanging-self-test.pid");
  const startedAt = Date.now();
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SELF_TEST_TIMEOUT_MS: "5000",
    CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE: pidFile,
  });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /候选 Runtime 版本自证失败.*ETIMEDOUT/);
  assert.ok(elapsed < 8_000, `candidate self-test timeout exceeded outer bound: ${elapsed}ms`);
  assert.equal(existsSync(pidFile), true, `missing hang pid; stderr=${result.stderr}; stdout=${result.stdout}`);
  const hangingPid = Number(readFileSync(pidFile, "utf8"));
  await waitForProcessExit(hangingPid);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.deepEqual(readdirSync(path.join(home, "app", ".pending")), []);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
  assertProjectPreserved(home);
});

test("formal retry preserves a termination_failed journal and dead-owner lock before fast reuse", (t) => {
  const { root, home, release, bundle } = fixture(t);
  const formal = makeFormalRelease(root, release, bundle);
  const old = createLegacyRuntime(home, { service: "absent" });
  const transactionId = "blocked-formal-retry";
  const pending = path.join(home, "app", ".pending", transactionId, "app");
  mkdirSync(pending, { recursive: true });
  const blockedState = {
    schemaVersion: 2,
    transactionId,
    phase: "termination_failed",
    active: { version: "0.4.7", path: old.runtime },
    previous: null,
    pending: { version: VERSION, path: pending },
    transaction: {
      oldActive: { version: "0.4.7", path: old.runtime },
      oldPrevious: null,
      serviceBefore: null,
      serviceEnsureStarted: false,
      launcherBefore: { kind: "missing" },
      toolsBefore: null,
      toolsSource: null,
      toolsCandidate: null,
    },
    terminationFailure: {
      rootPid: process.pid,
      observedRootAlive: true,
      duringPhase: "staged",
      failedAt: new Date().toISOString(),
      method: IS_WINDOWS ? "taskkill" : "process_group_sigkill",
      detailCode: "fixture_unconfirmed",
      reasonCode: "ETIMEDOUT",
    },
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(home, "installer-state.json"), `${JSON.stringify(blockedState)}\n`);
  writeFileSync(path.join(home, "managed-tools-state.json"), "{}\n");
  const lock = path.join(home, "runtime-update.lock");
  mkdirSync(lock);
  const owner = {
    pid: 2_147_483_647,
    acquiredAt: new Date().toISOString(),
    transactionId: "dead-owner-diagnostic",
  };
  writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify(owner)}\n`);
  const serializedState = readFileSync(path.join(home, "installer-state.json"), "utf8");
  const serializedOwner = readFileSync(path.join(lock, "owner.json"), "utf8");

  const retry = invokeFormal(process.execPath, home, release, formal);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stdout, /termination_failed.*阻止后续安装/s);
  assert.equal(readFileSync(path.join(home, "installer-state.json"), "utf8"), serializedState);
  assert.equal(readFileSync(path.join(lock, "owner.json"), "utf8"), serializedOwner);
  assert.equal(existsSync(pending), true);
});

test("missing Windows taskkill fail-closes the journal while a residual process is alive", {
  skip: !IS_WINDOWS,
}, async (t) => {
  let hangingPid = null;
  let rootPid = null;
  t.after(async () => {
    if (hangingPid && processIsAlive(hangingPid)) {
      process.kill(hangingPid, "SIGKILL");
      await waitForProcessExit(hangingPid);
    }
    if (rootPid && processIsAlive(rootPid)) {
      process.kill(rootPid, "SIGKILL");
      await waitForProcessExit(rootPid);
    }
  });
  const { root, home, release } = fixture(t, { hangVersion: true });
  const old = createLegacyRuntime(home);
  const oldIndex = readFileSync(path.join(old.runtime, "studio", "index.html"), "utf8");
  const pidFile = path.join(root, "taskkill-fallback-child.pid");
  const startedAt = Date.now();
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SELF_TEST_TIMEOUT_MS: "3000",
    CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE: pidFile,
    CHENGFENG_VIDEOCUT_TEST_DETACHED_RESIDUAL: "1",
    CHENGFENG_VIDEOCUT_TEST_TASKKILL_PATH: "C:\\definitely-missing\\taskkill.exe",
  });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /候选 Runtime 版本自证失败.*ETIMEDOUT.*termination_failed/s);
  assert.ok(elapsed < 6_000, `taskkill fallback did not settle: ${elapsed}ms`);
  hangingPid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(processIsAlive(hangingPid), true, "fixture must prove the unconfirmed descendant is still alive");
  const blockedState = readState(home);
  rootPid = blockedState.terminationFailure.rootPid;
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(
    readFileSync(path.join(old.runtime, "studio", "index.html"), "utf8"),
    oldIndex,
  );
  assert.equal(blockedState.phase, "termination_failed");
  assert.equal(blockedState.active.version, "0.4.7");
  assert.equal(blockedState.pending.version, VERSION);
  assert.equal(existsSync(blockedState.pending.path), true);
  assert.equal(blockedState.terminationFailure.duringPhase, "staged");
  assert.equal(blockedState.terminationFailure.method, "taskkill");
  assert.match(blockedState.terminationFailure.detailCode, /^taskkill_(?:spawn|error)_ENOENT$/);
  assert.equal(blockedState.terminationFailure.reasonCode, "ETIMEDOUT");
  assert.equal(Number.isFinite(Date.parse(blockedState.terminationFailure.failedAt)), true);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
  assertProjectPreserved(home);

  const serializedState = readFileSync(path.join(home, "installer-state.json"), "utf8");
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /termination_failed.*阻止后续安装/s);
  assert.equal(
    readFileSync(path.join(home, "installer-state.json"), "utf8"),
    serializedState,
    "blocked retry must not rewrite or clear the journal",
  );
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(
    readFileSync(path.join(old.runtime, "studio", "index.html"), "utf8"),
    oldIndex,
  );
  assert.equal(existsSync(blockedState.pending.path), true);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
});

test("candidate version output is bounded and spam cannot OOM or retain the lock", async (t) => {
  const { root, home, release } = fixture(t, { spamVersion: true });
  const old = createLegacyRuntime(home);
  const pidFile = path.join(root, "spamming-self-test.pid");
  const startedAt = Date.now();
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_EXECUTABLE_OUTPUT_LIMIT_BYTES: "65536",
    CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE: pidFile,
  });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /候选 Runtime 版本自证失败.*ENOBUFS/);
  assert.ok(result.stderr.length < 10_000, `diagnostic output was not bounded: ${result.stderr.length}`);
  assert.ok(elapsed < 5_000, `candidate output overflow exceeded outer bound: ${elapsed}ms`);
  const spammingPid = Number(readFileSync(pidFile, "utf8"));
  await waitForProcessExit(spammingPid);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.deepEqual(readdirSync(path.join(home, "app", ".pending")), []);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
  assertProjectPreserved(home);
});

test(
  "exit-zero candidate with an inherited-pipe descendant still fails on timeout and kills the group",
  { skip: IS_WINDOWS },
  async (t) => {
    const { root, home, release } = fixture(t, { inheritPipeVersion: true });
    const old = createLegacyRuntime(home);
    const pidFile = path.join(root, "inherited-pipe-child.pid");
    const startedAt = Date.now();
    const result = invoke(home, release, {
      CHENGFENG_VIDEOCUT_TEST_SELF_TEST_TIMEOUT_MS: "3000",
      CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE: pidFile,
    });
    const elapsed = Date.now() - startedAt;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /候选 Runtime 版本自证失败.*spawn=ETIMEDOUT.*exit=0/);
    assert.ok(elapsed < 6_000, `inherited-pipe timeout exceeded outer bound: ${elapsed}ms`);
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    await waitForProcessExit(descendantPid);
    assert.equal(currentTarget(home), old.runtime);
    assert.equal(readState(home).phase, "idle");
    assert.deepEqual(readdirSync(path.join(home, "app", ".pending")), []);
    assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
    assertProjectPreserved(home);
  },
);

for (const [name, relativePath] of [
  ["launcher", "chengfeng-videocut"],
  ["Studio index", path.join("studio", "index.html")],
]) {
  test(`${name} directory cannot impersonate a required package file`, (t) => {
    const { root, home, release, bundle } = fixture(t);
    const old = createLegacyRuntime(home);
    const assetPath = path.join(bundle, relativePath);
    rmSync(assetPath);
    mkdirSync(assetPath);
    packageRelease(root, release, bundle);
    const result = invoke(home, release);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不是普通文件/);
    assert.equal(currentTarget(home), old.runtime);
    assert.equal(existsSync(path.join(home, "app", VERSION)), false);
    assertProjectPreserved(home);
  });
}

test("same-version content replacement is rejected without changing current", (t) => {
  const { home, release, bundle } = fixture(t);
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(path.join(bundle, "studio", "index.html"), "<html><body>changed</body></html>\n");
  packageRelease(path.dirname(bundle), release, bundle);
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /同版本 Release 内容/);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
  assert.equal(existsSync(path.join(home, "projects")), false);
});

test("same-version installed CLI tampering cannot short-circuit on --version output", (t) => {
  const { home, release } = fixture(t);
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const stateBefore = readState(home);
  const cliPath = path.join(home, "app", VERSION, "cli.js");
  const tampered = `${fakeCli({
    version: VERSION,
    service: "absent",
    buildId: stateBefore.active.buildId,
  })}\n// changed after activation but still reports the same version\n`;
  writeExecutable(cliPath, tampered);
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /完整内容\/build\/能力身份/);
  assert.equal(readFileSync(cliPath, "utf8"), tampered);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
});

test("same-version non-Studio package file tampering is detected by full tree digest", (t) => {
  const { home, release } = fixture(t);
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const licensePath = path.join(home, "app", VERSION, "legal", "LICENSE");
  writeFileSync(licensePath, "tampered legal payload\n");
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /完整内容\/build\/能力身份/);
  assert.equal(readFileSync(licensePath, "utf8"), "tampered legal payload\n");
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
});

test("same-version executable-mode damage is detected instead of accepting --version", { skip: IS_WINDOWS }, (t) => {
  const { home, release } = fixture(t);
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const launcherPath = path.join(home, "app", VERSION, "chengfeng-videocut");
  chmodSync(launcherPath, 0o644);
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /启动器缺少 POSIX 可执行位|完整内容\/build\/能力身份/);
  assert.equal((lstatSync(launcherPath).mode & 0o111), 0);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
});

test("noncanonical packaged launcher mode is normalized before identity is persisted", { skip: IS_WINDOWS }, (t) => {
  const { home, release } = fixture(t, { launcherMode: 0o700 });
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const launcherPath = path.join(home, "app", VERSION, "chengfeng-videocut");
  assert.equal(lstatSync(launcherPath).mode & 0o777, 0o755);
  const stateBefore = readState(home);
  const second = invoke(home, release);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readState(home).active.treeDigest, stateBefore.active.treeDigest);
  assert.equal(lstatSync(launcherPath).mode & 0o777, 0o755);
});

test("same-version non-launcher permission drift is rejected by tree digest", { skip: IS_WINDOWS }, (t) => {
  const { home, release } = fixture(t);
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const licensePath = path.join(home, "app", VERSION, "legal", "LICENSE");
  chmodSync(licensePath, 0o600);
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /完整内容\/build\/能力身份/);
  assert.equal(lstatSync(licensePath).mode & 0o777, 0o600);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
});

test("same-version CLI without journal identities is not accepted as installed", (t) => {
  const { home, release } = fixture(t);
  const fake = createLegacyRuntime(home, { version: VERSION });
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少已验证的 archive\/build\/tree 身份/);
  assert.equal(currentTarget(home), fake.runtime);
  assertProjectPreserved(home);
  assert.equal(existsSync(path.join(home, "installer-state.json")), false);
});

test("same-version Desktop activation promotes an absent or old tools/current through the journal", async (t) => {
  const { root, home, release } = fixture(t, { service: "managed" });
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const server = await startCapabilityServer(t, root, home);
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const installedCandidateTools = path.join(toolsRoot, VERSION);
  const toolsCurrent = path.join(toolsRoot, "current");
  unlinkSync(toolsCurrent);
  const common = {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
  };
  const absent = invoke(home, release, common);
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(path.resolve(toolsRoot, readlinkSync(toolsCurrent)), installedCandidateTools);
  unlinkSync(toolsCurrent);
  symlinkSync(IS_WINDOWS ? oldTools : "0.4.7", toolsCurrent, IS_WINDOWS ? "junction" : "dir");
  const old = invoke(home, release, common);
  assert.equal(old.status, 0, old.stderr);
  assert.equal(path.resolve(toolsRoot, readlinkSync(toolsCurrent)), installedCandidateTools);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
});

test("same-version Desktop service failure restores the old tools link and managed service", async (t) => {
  const { root, home, release } = fixture(t, { service: "managed" });
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const server = await startCapabilityServer(t, root, home);
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const serviceLog = path.join(root, "same-version-service-actions.log");
  const failOnce = path.join(root, "fail-ensure-once");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
    CHENGFENG_VIDEOCUT_TEST_FAIL_ENSURE_ONCE_PATH: failOnce,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime 服务.*health\/version\/build\/PID\/identity/);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.equal(readState(home).phase, "idle");
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    `${VERSION}:status`,
    `${VERSION}:restart`,
    `${VERSION}:stop`,
    `${VERSION}:ensure`,
  ]);
});

test("managed service success verifies new version, build, PID identity and served capabilities", async (t) => {
  const { root, home, release } = fixture(t);
  createLegacyRuntime(home, { service: "managed" });
  const server = await startCapabilityServer(t, root, home);
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(readState(home).phase, "idle");
  assertProjectPreserved(home);
});

test("Desktop-requested service verification rolls back a stopped legacy Runtime and stops the candidate service", (t) => {
  const { root, home, release } = fixture(t, { service: "fail" });
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const serviceLog = path.join(root, "service-actions.log");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime 服务.*health\/version\/build\/PID\/identity/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.equal(readState(home).phase, "idle");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    "0.4.7:status",
    `${VERSION}:ensure`,
    `${VERSION}:stop`,
  ]);
  assertProjectPreserved(home);
});

test("candidate ensure invalid reply still stops the first-run service and rolls back tools", (t) => {
  const { root, home, release } = fixture(t, { service: "managed" });
  const { toolsRoot, candidateTools } = createManagedTools(home);
  unlinkSync(path.join(toolsRoot, "current"));
  const serviceLog = path.join(root, "service-actions.log");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
    CHENGFENG_VIDEOCUT_TEST_ENSURE_INVALID_AFTER_START: "1",
    CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_CLEANUP_UNTIL_SERVICE_STOPPED: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime service ensure 失败/);
  assert.equal(existsSync(path.join(home, "app", "current")), false);
  assert.equal(existsSync(path.join(toolsRoot, "current")), false);
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    `${VERSION}:ensure`,
    `${VERSION}:stop`,
  ]);
});

test("candidate restart invalid reply stops the candidate and restores an existing service", async (t) => {
  const { root, home, release } = fixture(t, { service: "managed" });
  const old = createLegacyRuntime(home, { service: "managed" });
  const { oldTools, candidateTools, toolsRoot } = createManagedTools(home);
  const server = await startCapabilityServer(t, root, home);
  const serviceLog = path.join(root, "service-actions.log");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_ENSURE_INVALID_AFTER_START: "1",
    // This makes a premature tools rollback fail.  The existing-service path
    // must stop the candidate before it can remove candidate bun/FFmpeg.
    CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_CLEANUP_UNTIL_SERVICE_STOPPED: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime service restart 失败/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    "0.4.7:status",
    `${VERSION}:restart`,
    `${VERSION}:stop`,
    "0.4.7:ensure",
  ]);
});

test("rollback restores the legacy launcher and keeps candidate tools until the old service is healthy", {
  skip: IS_WINDOWS,
}, async (t) => {
  const { root, home, release } = fixture(t, { service: "fail" });
  const old = createLegacyRuntime(home, { service: "managed" });
  const launcher = createLegacyStableLauncher(home, old.runtime);
  const { toolsRoot, candidateTools } = createManagedTools(home);
  unlinkSync(path.join(toolsRoot, "current"));
  const server = await startCapabilityServer(t, root, home);
  const serviceLog = path.join(root, "legacy-rollback-service-actions.log");

  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
    CHENGFENG_VIDEOCUT_TEST_REQUIRE_LEGACY_LAUNCHER_ON_OLD_ENSURE: "1",
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /自动回滚不完整/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(lstatSync(launcher).isSymbolicLink(), true);
  assert.equal(readlinkSync(launcher), path.join("..", "app", "current", "chengfeng-videocut"));
  assert.equal(existsSync(path.join(toolsRoot, "current")), false);
  assert.equal(existsSync(path.join(toolsRoot, VERSION)), false);
  assert.equal(readState(home).phase, "idle");
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    "0.4.7:status",
    `${VERSION}:restart`,
    `${VERSION}:stop`,
    "0.4.7:ensure",
  ]);
});

test("copying external Desktop tools crashes into pending and recovery removes the partial pending tree", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const crashed = invoke(home, release, {
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "tools_copied_pending",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.ok(readdirSync(path.join(toolsRoot, ".pending")).length > 0);
  const recovered = invoke(home, release, {
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(path.join(path.dirname(home), "missing-release")).href,
  });
  assert.notEqual(recovered.status, 0);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.deepEqual(readdirSync(path.join(toolsRoot, ".pending")), []);
});

test("same-version crash after tools target rename restores old tools without a dangling link", (t) => {
  const { home, release } = fixture(t);
  const first = invoke(home, release);
  assert.equal(first.status, 0, first.stderr);
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const crashed = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "tools_target_renamed",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.equal(existsSync(path.join(toolsRoot, VERSION)), true);
  const recovered = invoke(home, release);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.equal(existsSync(path.join(toolsRoot, VERSION)), false);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
});

test("regular upgrade crash after completed journal preserves new tools and cleans its backup", (t) => {
  const { home, release } = fixture(t);
  createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, candidateTools } = createManagedTools(home);
  const previousVersion = path.join(toolsRoot, VERSION);
  mkdirSync(previousVersion, { recursive: true });
  const suffix = IS_WINDOWS ? ".exe" : "";
  for (const name of ["bun", "ffmpeg", "ffprobe"]) writeFileSync(path.join(previousVersion, `${name}${suffix}`), "previous");
  writeFileSync(path.join(previousVersion, "resources-manifest.json"), "{}\n");
  const crashed = invoke(home, release, {
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "tools_committed",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), path.join(toolsRoot, VERSION));
  assert.equal(readdirSync(toolsRoot).filter((name) => name.includes(".previous.")).length, 1);
  const recovered = invoke(home, release);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), path.join(toolsRoot, VERSION));
  assert.equal(readdirSync(toolsRoot).filter((name) => name.includes(".previous.")).length, 0);
});

test("planned tools promotion crash preserves an existing target before backup move", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const previousTarget = path.join(toolsRoot, VERSION);
  mkdirSync(previousTarget, { recursive: true });
  const suffix = IS_WINDOWS ? ".exe" : "";
  for (const name of ["bun", "ffmpeg", "ffprobe"]) writeFileSync(path.join(previousTarget, `${name}${suffix}`), "previous");
  writeFileSync(path.join(previousTarget, "resources-manifest.json"), "{}\n");
  const crashed = invoke(home, release, {
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "tools_promotion_planned",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const recovered = invoke(home, release, {
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(path.join(path.dirname(home), "missing-release")).href,
  });
  assert.notEqual(recovered.status, 0);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readFileSync(path.join(previousTarget, `bun${suffix}`), "utf8"), "previous");
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
});

test("legacy intermediate tools journal without ownership proof fails closed and preserves every path", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const target = path.join(toolsRoot, VERSION);
  const backup = path.join(toolsRoot, `.${VERSION}.previous.legacy-intermediate`);
  const suffix = IS_WINDOWS ? ".exe" : "";
  mkdirSync(target, { recursive: true });
  for (const name of ["bun", "ffmpeg", "ffprobe"]) writeFileSync(path.join(target, `${name}${suffix}`), "old-target");
  writeFileSync(path.join(target, "resources-manifest.json"), "{}\n");

  // This represents a journal written by the schema before toolsTargetExisted
  // was persisted: promotion had been planned, but the old target has not
  // moved to its backup.  The target therefore cannot be proven candidate.
  writeFileSync(path.join(home, "installer-state.json"), JSON.stringify({
    schemaVersion: 1,
    transactionId: "legacy-intermediate",
    phase: "health_check",
    active: { version: "0.4.7", path: old.runtime },
    previous: null,
    pending: { version: VERSION, path: path.join(home, "app", VERSION) },
    transaction: {
      oldActive: { version: "0.4.7", path: old.runtime },
      oldPrevious: null,
      serviceBefore: null,
      serviceEnsureStarted: false,
      launcherBefore: { kind: "missing" },
      toolsBefore: oldTools,
      toolsSource: candidateTools,
      toolsCandidate: target,
      toolsPending: path.join(toolsRoot, ".pending", "legacy-intermediate"),
      toolsTarget: target,
      toolsBackup: backup,
      toolsPromotionStarted: true,
      toolsBackupMoved: false,
      // Intentionally no toolsTargetExisted: old schema / interrupted write.
    },
    terminationFailure: null,
    updatedAt: new Date().toISOString(),
  }));

  const recovered = invoke(home, release, {
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(path.join(path.dirname(home), "missing-release")).href,
  });
  assert.notEqual(recovered.status, 0);
  assert.match(recovered.stderr, /缺少 toolsTargetExisted.*不会删除任何路径/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readFileSync(path.join(target, `bun${suffix}`), "utf8"), "old-target");
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  const state = readState(home);
  assert.equal(state.phase, "health_check");
  assert.equal(state.active.version, "0.4.7");
  assert.equal(state.transaction.toolsTargetExisted, undefined);
});

test("explicit first-run toolsTargetExisted false still removes the promoted candidate during recovery", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, candidateTools } = createManagedTools(home);
  const target = path.join(toolsRoot, VERSION);
  const suffix = IS_WINDOWS ? ".exe" : "";
  mkdirSync(target, { recursive: true });
  for (const name of ["bun", "ffmpeg", "ffprobe"]) writeFileSync(path.join(target, `${name}${suffix}`), "candidate-target");
  writeFileSync(path.join(target, "resources-manifest.json"), "{}\n");

  writeFileSync(path.join(home, "installer-state.json"), JSON.stringify({
    schemaVersion: 1,
    transactionId: "explicit-first-run",
    phase: "health_check",
    active: { version: "0.4.7", path: old.runtime },
    previous: null,
    pending: { version: VERSION, path: path.join(home, "app", VERSION) },
    transaction: {
      oldActive: { version: "0.4.7", path: old.runtime },
      oldPrevious: null,
      serviceBefore: null,
      serviceEnsureStarted: false,
      launcherBefore: { kind: "missing" },
      toolsBefore: null,
      toolsSource: candidateTools,
      toolsCandidate: target,
      toolsTarget: target,
      toolsBackup: null,
      toolsPromotionStarted: true,
      toolsBackupMoved: false,
      toolsTargetExisted: false,
    },
    terminationFailure: null,
    updatedAt: new Date().toISOString(),
  }));

  const recovered = invoke(home, release, {
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(path.join(path.dirname(home), "missing-release")).href,
  });
  assert.notEqual(recovered.status, 0);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(path.join(toolsRoot, "current")), false);
  assert.equal(readState(home).phase, "idle");
});

test("forged journal paths never delete an external tools pending directory", (t) => {
  const { root, home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const outside = path.join(root, "outside-owned-by-user");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "keep.txt"), "keep\n");
  const transactionId = "forged-external-path";
  writeFileSync(path.join(home, "installer-state.json"), JSON.stringify({
    schemaVersion: 2,
    transactionId,
    phase: "health_check",
    active: { version: "0.4.7", path: old.runtime },
    previous: null,
    pending: { version: VERSION, path: path.join(home, "app", VERSION) },
    transaction: {
      oldActive: { version: "0.4.7", path: old.runtime },
      oldPrevious: null,
      serviceBefore: null,
      serviceEnsureStarted: false,
      launcherBefore: { kind: "missing" },
      toolsBefore: null,
      toolsSource: null,
      toolsCandidate: null,
      toolsPending: outside,
      toolsPromotionStarted: false,
    },
    terminationFailure: null,
    updatedAt: new Date().toISOString(),
  }));
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /toolsPending.*约定的受管路径/);
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep\n");
  assert.equal(currentTarget(home), old.runtime);
});

test("backup-moved crash restores the version before relinking a dangling tools/current", (t) => {
  const { home, release } = fixture(t);
  createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, candidateTools } = createManagedTools(home);
  const previousTarget = path.join(toolsRoot, VERSION);
  mkdirSync(previousTarget, { recursive: true });
  const suffix = IS_WINDOWS ? ".exe" : "";
  for (const name of ["bun", "ffmpeg", "ffprobe"]) writeFileSync(path.join(previousTarget, `${name}${suffix}`), "previous");
  writeFileSync(path.join(previousTarget, "resources-manifest.json"), "{}\n");
  unlinkSync(path.join(toolsRoot, "current"));
  symlinkSync(IS_WINDOWS ? previousTarget : VERSION, path.join(toolsRoot, "current"), IS_WINDOWS ? "junction" : "dir");
  const crashed = invoke(home, release, {
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "tools_backup_moved",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const recovered = invoke(home, release, {
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(path.join(path.dirname(home), "missing-release")).href,
  });
  assert.notEqual(recovered.status, 0);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), previousTarget);
  assert.equal(readFileSync(path.join(previousTarget, `bun${suffix}`), "utf8"), "previous");
});

test("failed staged-to-target rename restores backup without an idle journal mismatch", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, candidateTools } = createManagedTools(home);
  const previousTarget = path.join(toolsRoot, VERSION);
  mkdirSync(previousTarget, { recursive: true });
  const suffix = IS_WINDOWS ? ".exe" : "";
  for (const name of ["bun", "ffmpeg", "ffprobe"]) writeFileSync(path.join(previousTarget, `${name}${suffix}`), "previous");
  writeFileSync(path.join(previousTarget, "resources-manifest.json"), "{}\n");
  unlinkSync(path.join(toolsRoot, "current"));
  symlinkSync(IS_WINDOWS ? previousTarget : VERSION, path.join(toolsRoot, "current"), IS_WINDOWS ? "junction" : "dir");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_TARGET_RENAME: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_FAIL_TOOLS_TARGET_RENAME/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), previousTarget);
  assert.equal(readFileSync(path.join(previousTarget, `bun${suffix}`), "utf8"), "previous");
  assert.equal(readState(home).phase, "idle");
});

test("Desktop tools/current failure after promotion restores the old Runtime and tools links", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_PROMOTION: "after_current",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_FAIL_TOOLS_PROMOTION=after_current/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assertProjectPreserved(home);
});

test("Windows tools/current failure after old junction backup restores the old links", {
  skip: !IS_WINDOWS,
}, (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "absent" });
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_FAIL_TOOLS_PROMOTION: "after_backup",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_FAIL_TOOLS_PROMOTION=after_backup/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(path.resolve(toolsRoot, readlinkSync(path.join(toolsRoot, "current"))), oldTools);
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assertProjectPreserved(home);
});

test("managed service health failure restores old version, build, PID identity and capabilities", async (t) => {
  const { root, home, release } = fixture(t, { service: "fail" });
  const old = createLegacyRuntime(home, { service: "managed" });
  const server = await startCapabilityServer(t, root, home);
  const serviceLog = path.join(root, "service-actions.log");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime 服务.*health\/version\/build\/PID\/identity/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, "0.4.7");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    "0.4.7:status",
    `${VERSION}:restart`,
    `${VERSION}:stop`,
    "0.4.7:ensure",
  ]);
  assertProjectPreserved(home);
});

test("noncanonical candidate service origin is rejected and rolls back before any fetch", async (t) => {
  const { root, home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "managed" });
  const server = await startCapabilityServer(t, root, home);
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_NEW_SERVICE_URL: "http://localhost:5190/path",
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime 服务返回的服务 URL 不是规范的本机 HTTP origin/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assertProjectPreserved(home);
});

test("candidate service redirect is not followed and the old service is restored", async (t) => {
  const { root, home, release } = fixture(t);
  const old = createLegacyRuntime(home, { service: "managed" });
  const server = await startCapabilityServer(t, root, home, {
    redirectPath: "/api/health",
    redirectVersion: VERSION,
  });
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime 服务\/api\/health 读取失败/);
  assert.equal(existsSync(server.redirectHitPath), false);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assertProjectPreserved(home);
});

test("rollback failure remains explicit but restores the legacy stable launcher before holding the journal", {
  skip: IS_WINDOWS,
}, async (t) => {
  const { root, home, release } = fixture(t, { service: "fail" });
  const old = createLegacyRuntime(home, { service: "managed-restore-fail" });
  const launcher = createLegacyStableLauncher(home, old.runtime);
  const server = await startCapabilityServer(t, root, home);
  const environment = {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
  };
  const result = invoke(home, release, environment);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /自动回滚不完整/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "rollback_failed");
  assert.equal(lstatSync(launcher).isSymbolicLink(), true);
  assert.equal(readlinkSync(launcher), path.join("..", "app", "current", "chengfeng-videocut"));
  const retry = invoke(home, release, environment);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /回滚未完成/);
});

test("explicit embedded rollback recovery restores a legacy Runtime after the old bug deleted candidate tools", {
  skip: IS_WINDOWS,
}, async (t) => {
  const { root, home, release, bundle } = fixture(t, { service: "fail" });
  const old = createLegacyRuntime(home, { service: "managed-restore-fail" });
  const launcher = createLegacyStableLauncher(home, old.runtime);
  const { toolsRoot, oldTools, candidateTools } = createManagedTools(home);
  // The 0.4.x Runtime had no managed tools. The candidate's tool tree was
  // temporary and, in the historical bad rollback order, got deleted before
  // the old service could be restarted.
  unlinkSync(path.join(toolsRoot, "current"));
  rmSync(oldTools, { recursive: true, force: true });
  const server = await startCapabilityServer(t, root, home);
  const serviceLog = path.join(root, "recover-rollback-service-actions.log");
  const environment = {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR: candidateTools,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
  };
  const failed = invoke(home, release, environment);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /自动回滚不完整/);
  assert.equal(readState(home).phase, "rollback_failed");
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(existsSync(path.join(toolsRoot, VERSION)), true);
  assert.equal(existsSync(path.join(toolsRoot, "current")), true);

  // Model the exact pre-fix residue: candidate tools have already been
  // removed, but candidate app/ and the rollback_failed journal remain.
  unlinkSync(path.join(toolsRoot, "current"));
  rmSync(path.join(toolsRoot, VERSION), { recursive: true, force: true });
  assert.equal(existsSync(path.join(toolsRoot, VERSION)), false);
  assert.equal(existsSync(path.join(toolsRoot, "current")), false);

  // The first old-service start was deliberately faulted. Its exact Studio
  // identity stays the same; only the test service operation is allowed to
  // succeed for the explicit repair pass.
  writeExecutable(path.join(old.runtime, "cli.js"), fakeCli({
    version: "0.4.7",
    service: "managed",
    buildId: old.buildId,
  }));
  const formal = makeFormalRelease(root, release, bundle);
  const embeddedPayload = makeEmbeddedPayload(root, formal, { missingRuntimePayload: true });
  const serializedFailedState = readFileSync(path.join(home, "installer-state.json"), "utf8");

  const noPayload = invokeWithArgs(home, release, [
    "--target-root", home,
    "--recover-rollback",
    "--json",
  ], {
    ...environment,
    ...homeEnv(path.dirname(home)),
  });
  assert.notEqual(noPayload.status, 0);
  assert.match(noPayload.stdout, /含已校验受管工具 payload/);
  assert.equal(readFileSync(path.join(home, "installer-state.json"), "utf8"), serializedFailedState);

  const unreadableExternalFormal = invokeFormal(
    process.execPath,
    home,
    release,
    {
      manifestPath: path.join(root, "manifest-must-not-be-read.json"),
      checksumPath: path.join(root, "checksum-must-not-be-read.txt"),
    },
    ["--recover-rollback"],
  );
  assert.notEqual(unreadableExternalFormal.status, 0);
  assert.match(unreadableExternalFormal.stdout, /含已校验受管工具 payload/);
  assert.equal(readFileSync(path.join(home, "installer-state.json"), "utf8"), serializedFailedState);

  const recoveryEnvironment = { ...environment };
  delete recoveryEnvironment.CHENGFENG_VIDEOCUT_MANAGED_TOOLS_SOURCE_DIR;
  const tamperedToolsPath = path.join(root, "tampered-embedded-tools.tar.gz");
  writeFileSync(
    tamperedToolsPath,
    Buffer.concat([readFileSync(embeddedPayload.toolsPath), Buffer.from("tampered")]),
  );
  const unverifiedToolsPayload = { ...embeddedPayload, toolsPath: tamperedToolsPath };
  const unverifiedTools = invokeEmbeddedPayload(
    home,
    unverifiedToolsPayload,
    ["--recover-rollback"],
    recoveryEnvironment,
  );
  assert.notEqual(unverifiedTools.status, 0);
  assert.match(unverifiedTools.stdout, /大小与安装 manifest 不一致|SHA-256 与安装 manifest 不一致/);
  assert.equal(readFileSync(path.join(home, "installer-state.json"), "utf8"), serializedFailedState);

  const recovered = invokeEmbeddedPayload(
    home,
    embeddedPayload,
    ["--recover-rollback"],
    recoveryEnvironment,
  );
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const payload = JSON.parse(recovered.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.command, "runtime.recover_rollback");
  assert.equal(payload.data.status, "rollback_recovered");
  assert.equal(payload.data.productVersion, "0.4.7");
  assert.equal(payload.data.assetDownloads, 0);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, "0.4.7");
  assert.equal(lstatSync(launcher).isSymbolicLink(), true);
  assert.equal(readlinkSync(launcher), path.join("..", "app", "current", "chengfeng-videocut"));
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.equal(existsSync(path.join(toolsRoot, VERSION)), false);
  assert.equal(existsSync(path.join(toolsRoot, "current")), false);
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    "0.4.7:status",
    `${VERSION}:restart`,
    `${VERSION}:stop`,
    "0.4.7:ensure",
    `${VERSION}:stop`,
    "0.4.7:ensure",
    "0.4.7:status",
  ]);
  assertProjectPreserved(home);
});

test("explicit rollback recovery rejects a tampered journal and custom target root without mutation", {
  skip: IS_WINDOWS,
}, (t) => {
  const { root, home, release, bundle } = fixture(t);
  const old = createLegacyRuntime(home, { service: "managed" });
  const formal = makeFormalRelease(root, release, bundle);
  const embeddedPayload = makeEmbeddedPayload(root, formal, { missingRuntimePayload: true });
  const tampered = {
    schemaVersion: 2,
    transactionId: "tampered-rollback",
    phase: "rollback_failed",
    active: { version: "0.4.7", path: old.runtime },
    previous: null,
    pending: null,
    transaction: {
      oldActive: { version: "0.4.7", path: old.runtime },
      oldPrevious: null,
      serviceBefore: null,
      serviceEnsureStarted: false,
      launcherBefore: { kind: "unknown" },
      toolsBefore: null,
      toolsSource: null,
      toolsCandidate: null,
    },
    terminationFailure: null,
    rollbackError: "fixture rollback failure",
    updatedAt: new Date().toISOString(),
  };
  const statePath = path.join(home, "installer-state.json");
  writeFileSync(statePath, `${JSON.stringify(tampered)}\n`);
  const serializedTamperedState = readFileSync(statePath, "utf8");

  const rejected = invokeEmbeddedPayload(home, embeddedPayload, ["--recover-rollback"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /launcherBefore 无效/);
  assert.equal(readFileSync(statePath, "utf8"), serializedTamperedState);
  assert.equal(currentTarget(home), old.runtime);

  const customRoot = path.join(root, "custom", ".chengfeng-videocut");
  const customRootRejected = invokeEmbeddedPayload(
    customRoot,
    embeddedPayload,
    ["--recover-rollback"],
    homeEnv(path.join(root, "another-user")),
  );
  assert.notEqual(customRootRejected.status, 0);
  assert.match(customRootRejected.stdout, /自定义 --target-root 不得接管全局/);
  assert.equal(existsSync(customRoot), false);
  assert.equal(readFileSync(statePath, "utf8"), serializedTamperedState);
});

for (const stalledPath of ["/api/health", "/chengfeng-videocut-capabilities.json"]) {
  test(`stalled new service ${stalledPath} is bounded and rolls back`, async (t) => {
    const { root, home, release } = fixture(t);
    const old = createLegacyRuntime(home, { service: "managed" });
    const server = await startCapabilityServer(t, root, home, { stallPath: stalledPath });
    const startedAt = Date.now();
    const result = invoke(home, release, {
      CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
      CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
      CHENGFENG_VIDEOCUT_TEST_SERVICE_REQUEST_TIMEOUT_MS: "200",
      CHENGFENG_VIDEOCUT_TEST_SERVICE_BUDGET_MS: "1000",
    });
    const elapsed = Date.now() - startedAt;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /读取失败：超过 200ms/);
    assert.ok(elapsed < 5_000, `service timeout exceeded outer bound: ${elapsed}ms`);
    assert.equal(currentTarget(home), old.runtime);
    assert.equal(readState(home).phase, "idle");
    assert.equal(readState(home).active.version, "0.4.7");
    assert.equal(existsSync(path.join(home, "app", VERSION)), false);
    assertProjectPreserved(home);
  });
}

test("new service restart that ignores SIGTERM is hard-bounded and rolls back", async (t) => {
  const { root, home, release } = fixture(t, { service: "hang" });
  const old = createLegacyRuntime(home, { service: "managed" });
  const server = await startCapabilityServer(t, root, home);
  const pidFile = path.join(root, "hanging-service.pid");
  const startedAt = Date.now();
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_SERVICE_BUDGET_MS: "500",
    CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE: pidFile,
  });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime service restart.*(?:ETIMEDOUT|SIGTERM)/);
  assert.ok(elapsed < 5_000, `service CLI timeout exceeded outer bound: ${elapsed}ms`);
  const hangingPid = Number(readFileSync(pidFile, "utf8"));
  await waitForProcessExit(hangingPid);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, "0.4.7");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
  assertProjectPreserved(home);
});

test("new service restart output is bounded and spam rolls back without retaining the lock", async (t) => {
  const { root, home, release } = fixture(t, { service: "spam" });
  const old = createLegacyRuntime(home, { service: "managed" });
  const server = await startCapabilityServer(t, root, home);
  const pidFile = path.join(root, "spamming-service.pid");
  const startedAt = Date.now();
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_SERVICE_URL: server.url,
    CHENGFENG_VIDEOCUT_TEST_SERVICE_PID: String(server.pid),
    CHENGFENG_VIDEOCUT_TEST_EXECUTABLE_OUTPUT_LIMIT_BYTES: "65536",
    CHENGFENG_VIDEOCUT_TEST_HANG_PID_FILE: pidFile,
  });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime service restart.*ENOBUFS/);
  assert.ok(result.stderr.length < 10_000, `diagnostic output was not bounded: ${result.stderr.length}`);
  assert.ok(elapsed < 5_000, `service output overflow exceeded outer bound: ${elapsed}ms`);
  const spammingPid = Number(readFileSync(pidFile, "utf8"));
  await waitForProcessExit(spammingPid);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(readState(home).active.version, "0.4.7");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.equal(existsSync(path.join(home, "runtime-update.lock")), false);
  assertProjectPreserved(home);
});

test("concurrent update lock with a live valid owner rejects without touching current", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const lock = path.join(home, "runtime-update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    transactionId: "live-owner",
  }));
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已有 Runtime 更新/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(existsSync(lock), true);
});

for (const [name, ownerContent, expected] of [
  ["missing owner", null, /尚未包含可验证 owner/],
  ["invalid owner JSON", "{", /尚未包含可验证 owner/],
  ["invalid owner fields", JSON.stringify({ pid: 123 }), /owner 无效/],
]) {
  test(`update lock ${name} fails closed and is never deleted`, (t) => {
    const { home, release } = fixture(t);
    const old = createLegacyRuntime(home);
    const lock = path.join(home, "runtime-update.lock");
    mkdirSync(lock, { recursive: true });
    if (ownerContent !== null) writeFileSync(path.join(lock, "owner.json"), ownerContent);
    const result = invoke(home, release);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(existsSync(lock), true);
    assert.equal(currentTarget(home), old.runtime);
  });
}

test("valid lock owner is reclaimed only after its PID is provably dead", (t) => {
  const { home, release } = fixture(t);
  createLegacyRuntime(home);
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const lock = path.join(home, "runtime-update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: exited.pid,
    acquiredAt: new Date().toISOString(),
    transactionId: "dead-owner",
  }));
  const result = invoke(home, release);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
});

for (const operation of ["write", "rename"]) {
  test(`lock owner ${operation} failure leaves an incomplete lock fail-closed`, (t) => {
    const { home, release } = fixture(t);
    const old = createLegacyRuntime(home);
    const lock = path.join(home, "runtime-update.lock");
    const result = invoke(home, release, {
      CHENGFENG_VIDEOCUT_TEST_FAIL_JOURNAL_AT: `lock_owner:${operation}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TEST_FAIL_JOURNAL_AT/);
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(path.join(lock, "owner.json")), false);
    const retry = invoke(home, release);
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /尚未包含可验证 owner/);
    assert.equal(existsSync(lock), true);
    assert.equal(currentTarget(home), old.runtime);
    assertProjectPreserved(home);
  });
}

test("lock owner post-rename flush failure leaves a valid dead owner that can be reclaimed", (t) => {
  const { home, release } = fixture(t);
  createLegacyRuntime(home);
  const lock = path.join(home, "runtime-update.lock");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_FAIL_JOURNAL_AT: "lock_owner:fsync_destination",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_FAIL_JOURNAL_AT/);
  assert.equal(existsSync(path.join(lock, "owner.json")), true);
  const owner = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
  assert.equal(Number.isInteger(owner.pid), true);
  const retry = invoke(home, release);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
});

test("lock mkdir-to-owner race never lets a second installer delete the live lock", async (t) => {
  const { home, release } = fixture(t);
  createLegacyRuntime(home);
  const lock = path.join(home, "runtime-update.lock");
  const first = spawn(process.execPath, [INSTALLER], {
    env: installEnv(home, release, {
      CHENGFENG_VIDEOCUT_TEST_PAUSE_AFTER_LOCK_DIRECTORY_MS: "800",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstResultPromise = childResult(first);
  await waitForPath(lock, () => !existsSync(path.join(lock, "owner.json")));
  const second = invoke(home, release);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /尚未包含可验证 owner/);
  assert.equal(existsSync(lock), true);
  const firstResult = await firstResultPromise;
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
});

test("crafted archive candidate root symlink is rejected and cannot escape into projects", (t) => {
  const root = canonicalRealpath(mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-updater-link-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const old = createLegacyRuntime(home);
  const release = path.join(root, "release");
  writeSymlinkRootRelease(release, "../home/projects");
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /链接或特殊条目/);
  assert.equal(currentTarget(home), old.runtime);
  assertProjectPreserved(home);
});

test("extracted candidate root symlink or junction cannot redirect validation into projects", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_TEST_REPLACE_EXTRACTED_ROOT_WITH_REPARSE: path.join(home, "projects"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不是普通目录|真实路径逃出/);
  assert.equal(currentTarget(home), old.runtime);
  assertProjectPreserved(home);
});

for (const targetKind of ["outside-app", "inside-app", "inside-candidate"]) {
  test(`recursive staged-tree scan rejects ${targetKind} symlink or junction`, (t) => {
    const { home, release } = fixture(t);
    const old = createLegacyRuntime(home);
    const target = targetKind === "outside-app"
      ? path.join(home, "projects")
      : targetKind === "inside-app"
        ? old.runtime
        : "inside";
    const result = invoke(home, release, {
      CHENGFENG_VIDEOCUT_TEST_ADD_STAGED_REPARSE: target,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /包含链接|reparse point/);
    assert.equal(currentTarget(home), old.runtime);
    assertProjectPreserved(home);
    assert.deepEqual(readdirSync(path.join(home, "app", ".pending")), []);
  });
}

test("archive hardlink is rejected before activation", (t) => {
  const { root, home, release, bundle } = fixture(t);
  const old = createLegacyRuntime(home);
  linkSync(
    path.join(bundle, "studio", "index.html"),
    path.join(bundle, "studio", "hardlink.html"),
  );
  packageRelease(root, release, bundle);
  const result = invoke(home, release);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /链接或特殊条目|hardlink/);
  assert.equal(currentTarget(home), old.runtime);
  assertProjectPreserved(home);
});

const JOURNAL_FAULTS = [
  "staged:write",
  "staged:fsync_temp",
  "promoting:rename",
  "switching:rename",
  "health_check:rename",
  "health_check:fsync_destination",
  "completed:fsync_destination",
  ...(!IS_WINDOWS ? ["completed:fsync_directory"] : []),
];

for (const fault of JOURNAL_FAULTS) {
  test(`journal ${fault} failure is recoverable without losing current or projects`, (t) => {
    const { home, release } = fixture(t);
    createLegacyRuntime(home);
    const failed = invoke(home, release, { CHENGFENG_VIDEOCUT_TEST_FAIL_JOURNAL_AT: fault });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /TEST_FAIL_JOURNAL_AT/);
    assertProjectPreserved(home);
    const recovered = invoke(home, release);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(currentTarget(home), path.join(home, "app", VERSION));
    assert.equal(readState(home).phase, "idle");
    assertProjectPreserved(home);
  });
}

for (const phase of [
  "staged",
  "validated",
  "promoting",
  "promoted_before_journal",
  "switching",
  "health_check",
  "completed",
]) {
  test(`startup recovery handles crash journal phase ${phase}`, (t) => {
    const { home, release } = fixture(t);
    createLegacyRuntime(home);
    const crashed = invoke(home, release, { CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: phase });
    assert.equal(crashed.status, 86, crashed.stderr);
    const recovered = invoke(home, release);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(currentTarget(home), path.join(home, "app", VERSION));
    assert.equal(readState(home).phase, "idle");
    assert.equal(readState(home).active.version, VERSION);
    assertProjectPreserved(home);
  });
}

test("lost journal after current switch fails closed and preserves both versions and projects", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const crashed = invoke(home, release, { CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "health_check" });
  assert.equal(crashed.status, 86, crashed.stderr);
  rmSync(path.join(home, "installer-state.json"));
  const retry = invoke(home, release);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /缺少已验证的 archive\/build\/tree 身份/);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(existsSync(old.runtime), true);
  assert.equal(existsSync(path.join(home, "app", VERSION)), true);
  assertProjectPreserved(home);
});

test("stale idle journal after current switch fails closed without destroying either version", (t) => {
  const { home, release } = fixture(t);
  const old = createLegacyRuntime(home);
  const crashed = invoke(home, release, { CHENGFENG_VIDEOCUT_TEST_CRASH_AT_PHASE: "health_check" });
  assert.equal(crashed.status, 86, crashed.stderr);
  writeFileSync(path.join(home, "installer-state.json"), JSON.stringify({
    schemaVersion: 1,
    transactionId: null,
    phase: "idle",
    active: { version: "0.4.7", path: old.runtime, archiveSha256: null, buildId: null },
    previous: null,
    pending: null,
    transaction: null,
    updatedAt: new Date().toISOString(),
  }));
  const retry = invoke(home, release);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /current 与安装 journal 不一致/);
  assert.equal(currentTarget(home), path.join(home, "app", VERSION));
  assert.equal(existsSync(old.runtime), true);
  assert.equal(existsSync(path.join(home, "app", VERSION)), true);
  assertProjectPreserved(home);
});

test("installer state is a regular private file, never a project transaction artifact", (t) => {
  const { home, release } = fixture(t);
  const result = invoke(home, release);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(path.join(home, "installer-state.json")).isFile(), true);
  assert.equal(existsSync(path.join(home, "projects")), false);
});
