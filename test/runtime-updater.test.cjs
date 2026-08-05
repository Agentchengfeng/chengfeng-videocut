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
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
const VERSION = "0.4.8";
const IS_WINDOWS = process.platform === "win32";
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
  if (process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG) {
    require('node:fs').appendFileSync(
      process.env.CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG,
      ${JSON.stringify(version)} + ':' + action + '\\n',
    );
  }
  const isStatus = action === 'status';
  if (!isStatus && ${hangOnEnsure}) hangIgnoringTermination();
  if (!isStatus && ${spamOnEnsure}) spamIgnoringTermination();
  const present = isStatus ? ${statusPresent} : true;
  const healthy = isStatus ? ${statusPresent} : ${ensureHealthy};
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

function installEnv(home, release, extra = {}) {
  const fakeBin = path.join(path.dirname(home), "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  if (IS_WINDOWS) {
    writeFileSync(
      path.join(fakeBin, "bun.cmd"),
      `@echo off\r\n"${process.execPath}" %*\r\n`,
    );
  } else {
    writeExecutable(path.join(fakeBin, "bun"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  }
  return {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    CHENGFENG_VIDEOCUT_HOME: home,
    CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(release).href.replace(/\/$/, ""),
    ...extra,
  };
}

function invoke(home, release, extra = {}) {
  return spawnSync(process.execPath, [INSTALLER], {
    env: installEnv(home, release, extra),
    encoding: "utf8",
  });
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
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
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
  writeFileSync(ready, JSON.stringify({
    url: "http://127.0.0.1:" + address.port,
    pid: process.pid,
    redirectHitPath,
  }));
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

function assertProjectPreserved(home) {
  assert.equal(readFileSync(path.join(home, "projects", "keep-me.txt"), "utf8"), PROJECT_CONTENT);
}

test("macOS shell bootstrap downloads and verifies install.cjs before a real local Release install", {
  skip: IS_WINDOWS,
}, (t) => {
  const { root, home, release } = fixture(t);
  addInstallerBootstrapAssets(release);
  const result = spawnSync("sh", [SHELL_INSTALLER], {
    env: {
      ...installEnv(home, release),
      HOME: path.join(root, "bootstrap-home"),
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
      HOME: path.join(root, "bootstrap-home"),
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

function readState(home) {
  return JSON.parse(readFileSync(path.join(home, "installer-state.json"), "utf8"));
}

function fixture(t, releaseOptions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-updater-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const releaseInfo = makeRelease(root, releaseOptions);
  return { root, home, ...releaseInfo };
}

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
  const serviceLog = path.join(root, "service-actions.log");
  const result = invoke(home, release, {
    CHENGFENG_VIDEOCUT_INSTALLER_ENSURE_SERVICE: "1",
    CHENGFENG_VIDEOCUT_TEST_SERVICE_LOG: serviceLog,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /新 Runtime 服务.*health\/version\/build\/PID\/identity/);
  assert.equal(currentTarget(home), old.runtime);
  assert.equal(readState(home).phase, "idle");
  assert.equal(existsSync(path.join(home, "app", VERSION)), false);
  assert.deepEqual(readFileSync(serviceLog, "utf8").trim().split("\n"), [
    "0.4.7:status",
    `${VERSION}:ensure`,
    `${VERSION}:stop`,
  ]);
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
    `${VERSION}:ensure`,
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

test("rollback failure remains explicit in the single journal and refuses later overwrite", async (t) => {
  const { root, home, release } = fixture(t, { service: "fail" });
  const old = createLegacyRuntime(home, { service: "managed-restore-fail" });
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
  const retry = invoke(home, release, environment);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /回滚未完成/);
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

test("new service ensure that ignores SIGTERM is hard-bounded and rolls back", async (t) => {
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
  assert.match(result.stderr, /新 Runtime service ensure.*(?:ETIMEDOUT|SIGTERM)/);
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

test("new service output is bounded and spam rolls back without retaining the lock", async (t) => {
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
  assert.match(result.stderr, /新 Runtime service ensure.*ENOBUFS/);
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
  const root = mkdtempSync(path.join(os.tmpdir(), "chengfeng-videocut-updater-link-test-"));
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

for (const phase of ["staged", "validated", "promoting", "switching", "health_check", "completed"]) {
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
