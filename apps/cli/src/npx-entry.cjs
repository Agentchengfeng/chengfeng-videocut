#!/usr/bin/env node
"use strict";

// The public command is Node/npx, like Remotion. The actual editing Runtime
// remains a separately managed local product: its CLI runs on the Bun shipped
// with the Runtime bundle, together with its matching FFmpeg/FFprobe. Keeping
// this entry in plain CommonJS means a new Windows machine only needs Node LTS
// before `npx @chengfeng/videocut ...` can repair or start the Runtime.

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PRODUCT = "chengfeng-videocut";
const ACCEPT_PUBLIC_BETA = "--accept-public-beta";
const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORM_PACKAGES = {
  "darwin-arm64": "@chengfeng/videocut-runtime-darwin-arm64",
  "darwin-x64": "@chengfeng/videocut-runtime-darwin-x64",
  "win32-x64": "@chengfeng/videocut-runtime-win32-x64",
};

function fail(message) {
  const error = new Error(message);
  error.code = "NPM_RUNTIME_REFUSED";
  throw error;
}

function packageJson() {
  const file = path.join(__dirname, "..", "package.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.name !== "@chengfeng/videocut" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version || "")) {
      fail("The @chengfeng/videocut package identity is invalid.");
    }
    return value;
  } catch (error) {
    if (error && error.code === "NPM_RUNTIME_REFUSED") throw error;
    fail("The @chengfeng/videocut package.json is missing or invalid.");
  }
}

function platformKey() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  fail(`Unsupported platform ${process.platform}-${process.arch}.`);
}

function defaultRuntimeRoot() {
  if (process.env.CHENGFENG_VIDEOCUT_HOME) {
    fail("CHENGFENG_VIDEOCUT_HOME is not supported by the public npx command; use the default Product Runtime root.");
  }
  return path.join(os.homedir(), ".chengfeng-videocut");
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !value.includes("\\") && path.posix.normalize(value) === value &&
    value !== "." && value !== ".." && !value.startsWith("../");
}

function singleRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0) {
    fail(`${label} is not a non-empty single-link regular file.`);
  }
  return stat;
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runtimePackage(acceptPublicBeta) {
  const key = platformKey();
  const name = PLATFORM_PACKAGES[key];
  const entryPackage = packageJson();
  if (entryPackage.optionalDependencies?.[name] !== entryPackage.version) {
    fail(`The npx package does not pin ${name} to its own exact version.`);
  }
  let root;
  try {
    root = path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] }));
  } catch {
    fail(`${name}@${entryPackage.version} is unavailable for ${key}; npm did not install the required platform Runtime package.`);
  }
  const packageRoot = fs.realpathSync(root);
  const manifestPath = path.join(packageRoot, "chengfeng-videocut-runtime-package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail("The platform Runtime package manifest is missing or invalid.");
  }
  const platform = key === "win32-x64" ? { os: "win32", cpu: "x64" } : key.split("-").length === 2
    ? { os: "darwin", cpu: key.slice("darwin-".length) }
    : null;
  if (!platform || manifest.schemaVersion !== 1 || manifest.product !== PRODUCT ||
      manifest.productVersion !== entryPackage.version || manifest.platformKey !== key ||
      manifest.npmPackage?.name !== name || manifest.npmPackage?.version !== entryPackage.version ||
      JSON.stringify(manifest.npmPackage?.os) !== JSON.stringify([platform.os]) ||
      JSON.stringify(manifest.npmPackage?.cpu) !== JSON.stringify([platform.cpu])) {
    fail("The platform Runtime package identity does not match the npx command.");
  }
  const formal = manifest.distributionMode === "release-ready" && manifest.licenseStatus === "VERIFIED";
  const beta = manifest.distributionMode === "public-beta" && manifest.licenseStatus === "UNVERIFIED" &&
    key === "win32-x64" && manifest.beta?.channel === "windows-x64-public-beta" &&
    manifest.beta?.acknowledgement === ACCEPT_PUBLIC_BETA;
  if (!formal && !beta) fail("The platform Runtime package is neither a release-ready package nor the acknowledged Windows public beta.");
  if (formal && acceptPublicBeta) {
    fail(`${ACCEPT_PUBLIC_BETA} is only valid for the acknowledged Windows public beta.`);
  }
  if (beta && !acceptPublicBeta) {
    fail(`This is a Windows public beta. Re-run with ${ACCEPT_PUBLIC_BETA} after reading the beta notice; no Runtime was installed.`);
  }
  const installer = manifest.installer;
  if (!installer || !safeRelative(installer.path) || !installer.path.startsWith("payload/") ||
      typeof installer.asset !== "string" || path.posix.basename(installer.path) !== installer.asset ||
      !SHA256.test(installer.sha256 || "") || !Number.isSafeInteger(installer.size) || installer.size <= 0 ||
      typeof installer.executable !== "boolean") {
    fail("The platform Runtime installer receipt is invalid.");
  }
  const installerPath = path.join(packageRoot, ...installer.path.split("/"));
  const relative = path.relative(packageRoot, installerPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("The platform Runtime installer escapes its package root.");
  }
  const stat = singleRegularFile(installerPath, "Platform Runtime installer");
  if (stat.size !== installer.size || fileSha256(installerPath) !== installer.sha256) {
    fail("The platform Runtime installer does not match its receipt.");
  }
  if (process.platform !== "win32" && !installer.executable) {
    fail("The POSIX platform Runtime installer is not marked executable.");
  }
  return { beta, installerPath };
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (/[\0\r\n"]/.test(text)) fail("Runtime command contains an unsafe Windows argument.");
  return `"${text.replaceAll("%", "%%")}"`;
}

function spawn(command, args, options = {}) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return childProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  }
  const commandLine = `"${[quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ")}"`;
  return childProcess.spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", commandLine], {
    encoding: "utf8", windowsVerbatimArguments: true, ...options,
  });
}

function runtimeLauncher(root) {
  return path.join(root, "bin", process.platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
}

function doctorReady(launcher) {
  try {
    singleRegularFile(launcher, "Product Runtime launcher");
  } catch {
    return false;
  }
  const result = spawn(launcher, ["doctor", "--json"], { timeout: 30_000 });
  if (result.error || result.status !== 0) return false;
  const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  try {
    return Boolean(line && JSON.parse(line).healthy === true);
  } catch {
    return false;
  }
}

function ensureRuntime(acceptPublicBeta) {
  const root = defaultRuntimeRoot();
  const launcher = runtimeLauncher(root);
  // Validate the exact npm platform payload even when a prior Runtime is
  // already healthy. Otherwise an unacknowledged beta could silently reuse a
  // production Runtime and bypass the channel warning.
  const runtime = runtimePackage(acceptPublicBeta);
  if (doctorReady(launcher)) return launcher;
  const args = ["--target-root", root, "--ensure-service", "--json"];
  if (runtime.beta) args.push(ACCEPT_PUBLIC_BETA);
  const result = spawn(runtime.installerPath, args, { timeout: 20 * 60_000 });
  if (result.error || result.status !== 0) {
    const output = String(result.stderr || result.stdout || result.error?.message || "").trim();
    fail(`Product Runtime installation failed${output ? `: ${output}` : "."}`);
  }
  if (!doctorReady(launcher)) fail("Product Runtime installer returned success but doctor is not healthy.");
  return launcher;
}

function usage() {
  process.stdout.write([
    "chengfeng-videocut",
    "",
    "Usage:",
    "  npx @chengfeng/videocut doctor",
    "  npx @chengfeng/videocut service ensure",
    "  npx @chengfeng/videocut <Product Runtime argv>",
    "",
    "The command uses Node/npx only as the public launcher. It starts the managed Product Runtime, which owns Bun, FFmpeg, FFprobe, Studio and renderer preparation.",
    `The Windows public beta requires ${ACCEPT_PUBLIC_BETA}; a release-ready package never accepts that flag.`,
  ].join("\n") + "\n");
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") return usage();
  const acceptPublicBeta = argv.includes(ACCEPT_PUBLIC_BETA);
  const runtimeArgv = argv.filter((argument) => argument !== ACCEPT_PUBLIC_BETA);
  const launcher = ensureRuntime(acceptPublicBeta);
  const result = spawn(launcher, runtimeArgv, { timeout: 20 * 60_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`Product Runtime execution failed: ${result.error.message}`);
  process.exitCode = result.status ?? 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`REFUSED ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { main, runtimePackage, doctorReady };
