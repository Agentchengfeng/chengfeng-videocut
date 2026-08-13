#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_RUNTIME_TARGETS, type NpmRuntimePlatformKey } from "./npm-runtime-package";

type JsonRecord = Record<string, unknown>;
type StageStatus = "PASS" | "FAIL" | "SKIP" | "UNVERIFIED" | "BLOCKED";

interface Options {
  run: boolean;
  json: boolean;
  keep: boolean;
  outputRoot?: string;
  evidenceOut?: string;
  voiceMedia?: string;
  cloudIngest: boolean;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

interface Stage {
  name: string;
  status: StageStatus;
  details?: JsonRecord;
}

interface RunningServer {
  child: ChildProcessWithoutNullStreams;
  url: string;
  pid: number;
  port: number;
}

interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requireFromRoot = createRequire(import.meta.url);
const DEFAULT_OPT_IN = "CHENGFENG_VIDEOCUT_INSTALLED_E2E";
const PRODUCT_HOME_NAME = ".chengfeng-videocut";
const RUN_PREFIX = "chengfeng-videocut-installed-e2e-";
const EVIDENCE_PREFIX = "chengfeng-videocut-installed-e2e-evidence-";

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      values.set(rawName, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(rawName, next);
      index += 1;
    } else {
      values.set(rawName, true);
    }
  }
  const text = (name: string, envName?: string): string | undefined => {
    const value = values.get(name);
    if (typeof value === "string" && value.trim()) return value;
    const env = envName ? process.env[envName] : undefined;
    return env?.trim() || undefined;
  };
  return {
    run: values.has("run") || process.env[DEFAULT_OPT_IN] === "1",
    json: values.has("json"),
    keep: values.has("keep") || process.env.CHENGFENG_VIDEOCUT_INSTALLED_E2E_KEEP === "1",
    outputRoot: text("output-root", "CHENGFENG_VIDEOCUT_INSTALLED_E2E_ROOT"),
    evidenceOut: text("evidence-out", "CHENGFENG_VIDEOCUT_INSTALLED_E2E_EVIDENCE"),
    voiceMedia: text("voice-media", "CHENGFENG_VIDEOCUT_INSTALLED_E2E_MEDIA"),
    cloudIngest: values.has("cloud-ingest") || process.env.CHENGFENG_VIDEOCUT_INSTALLED_E2E_CLOUD === "1",
  };
}

function jsonObject(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function fileFingerprint(path: string): Promise<JsonRecord> {
  const metadata = await stat(path);
  return {
    path,
    size: metadata.size,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    sha256: await sha256File(path),
  };
}

async function assertFreshTempRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error(`--output-root must be absolute: ${root}`);
  const tempRoot = await realpath(tmpdir());
  const parent = await realpath(dirname(root));
  const relativeToTemp = relative(tempRoot, parent);
  if (relativeToTemp === ".." || relativeToTemp.startsWith(`..${sep}`) || isAbsolute(relativeToTemp)) {
    throw new Error(`--output-root must live under the system temp directory: ${tempRoot}`);
  }
  if (resolve(root) === tempRoot) throw new Error("--output-root must not be the temp directory itself");
  const entries = await readdir(root).catch((error) => {
    if (jsonObject(error)?.code === "ENOENT") return null;
    throw error;
  });
  if (entries && entries.length > 0) throw new Error(`--output-root must be fresh or empty: ${root}`);
  await mkdir(root, { recursive: true });
  return await realpath(root);
}

async function makeRunRoot(options: Options): Promise<string> {
  if (options.outputRoot) return await assertFreshTempRoot(resolve(options.outputRoot));
  return await realpath(await mkdtemp(join(await realpath(tmpdir()), RUN_PREFIX)));
}

async function assertUnderRoot(label: string, path: string, root: string): Promise<string> {
  const [realPath, realRoot] = await Promise.all([realpath(path), realpath(root)]);
  const relativeToRoot = relative(realRoot, realPath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new Error(`${label} must stay under isolated run root: ${realPath}`);
  }
  return realPath;
}

function scrubbedIsolatedEnv(home: string, tmp: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CHENGFENG_VIDEOCUT_HOME;
  delete env.CHENGFENG_VIDEOCUT_DATA_DIR;
  delete env.CHENGFENG_VIDEOCUT_PROJECTS_DIR;
  delete env.VIDEO_WORKBENCH_PROJECTS_DIR;
  env.HOME = home;
  env.TMPDIR = tmp;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? ROOT,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = { code: code ?? -1, stdout, stderr, signal };
      if (result.code === 0 || options.allowFailure) resolvePromise(result);
      else reject(new Error(
        `${command} ${args.join(" ")} exited ${result.code}` +
        `${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ""}`,
      ));
    });
  });
}

function parseJsonLine<T = JsonRecord>(result: CommandResult): T {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("Command produced no JSON stdout");
  return JSON.parse(line) as T;
}

function platformKey(): NpmRuntimePlatformKey {
  const value = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(NPM_RUNTIME_TARGETS, value)) {
    throw new Error(`Unsupported installed-product E2E platform: ${value}`);
  }
  return value as NpmRuntimePlatformKey;
}

function moduleExportPath(value: unknown): string {
  if (typeof value === "string") return value;
  const record = jsonObject(value);
  if (typeof record?.path === "string") return record.path;
  if (typeof record?.default === "string") return record.default;
  throw new Error("static binary package did not expose a path");
}

async function loadStaticPackage(packageName: "ffmpeg-static" | "@derhuerst/ffprobe-static"): Promise<{
  binary: string;
  version: string;
}> {
  const candidates = [
    () => requireFromRoot(packageName),
    () => createRequire(join(ROOT, "node_modules/.bun/node_modules", packageName, "index.js"))(packageName),
  ];
  const versionCandidates = [
    () => requireFromRoot(`${packageName}/package.json`).version,
    () => createRequire(join(ROOT, "node_modules/.bun/node_modules", packageName, "index.js"))(`${packageName}/package.json`).version,
  ];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const binary = await realpath(moduleExportPath(candidates[index]!()));
      const nodeModulesRoot = await realpath(join(ROOT, "node_modules"));
      const relativeToNodeModules = relative(nodeModulesRoot, binary);
      if (
        relativeToNodeModules === ".." ||
        relativeToNodeModules.startsWith(`..${sep}`) ||
        isAbsolute(relativeToNodeModules)
      ) {
        throw new Error(`${packageName} resolved outside this worktree node_modules: ${binary}`);
      }
      return { binary, version: String(versionCandidates[index]!()) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function verifyVersion(command: string, expectedPattern: RegExp): string {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot execute ${command}: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  const line = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!expectedPattern.test(line)) throw new Error(`Unexpected media tool identity: ${line}`);
  return line;
}

async function resolveStaticMediaTools(): Promise<{
  ffmpeg: string;
  ffprobe: string;
  evidence: JsonRecord;
}> {
  let ffmpegPath: string;
  let ffprobePath: string;
  let ffmpegPackageVersion: string;
  let ffprobePackageVersion: string;
  try {
    const ffmpeg = await loadStaticPackage("ffmpeg-static");
    const ffprobe = await loadStaticPackage("@derhuerst/ffprobe-static");
    ffmpegPath = ffmpeg.binary;
    ffprobePath = ffprobe.binary;
    ffmpegPackageVersion = ffmpeg.version;
    ffprobePackageVersion = ffprobe.version;
  } catch (error) {
    throw new Error(
      "this worktree node_modules must contain ffmpeg-static@5.3.0 and " +
      `@derhuerst/ffprobe-static@5.3.0; missing static tools: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (ffmpegPackageVersion !== "5.3.0") throw new Error(`ffmpeg-static version drift: ${ffmpegPackageVersion}`);
  if (ffprobePackageVersion !== "5.3.0") {
    throw new Error(`@derhuerst/ffprobe-static version drift: ${ffprobePackageVersion}`);
  }
  const ffmpegLine = verifyVersion(ffmpegPath, /^ffmpeg version (?:n)?6\.0(?:[-\s]|$)/);
  const ffprobeLine = verifyVersion(ffprobePath, /^ffprobe version (?:n)?6\.0(?:[-\s]|$)/);
  return {
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath,
    evidence: {
      ffmpegStatic: { packageVersion: ffmpegPackageVersion, path: ffmpegPath, versionLine: ffmpegLine },
      ffprobeStatic: { packageVersion: ffprobePackageVersion, path: ffprobePath, versionLine: ffprobeLine },
    },
  };
}

async function stagePortableRuntime(releaseDir: string): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version?: string };
  const version = packageJson.version;
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${String(version)}`);
  }
  const cliDistDir = join(ROOT, "apps/cli/dist");
  for (const [path, label] of [
    [join(cliDistDir, "cli.js"), "Bundled CLI"],
    [join(cliDistDir, "studio/index.html"), "Studio bundle"],
    [join(cliDistDir, "legal/LICENSE"), "Legal files"],
  ] as const) {
    await access(path).catch(() => {
      throw new Error(`${label} is missing at ${path}. Run package build first.`);
    });
  }
  const stageDir = join(releaseDir, ".portable-stage");
  const bundleName = `chengfeng-videocut-${version}`;
  const bundleDir = join(stageDir, bundleName);
  const runtimeArchive = join(releaseDir, `${bundleName}-runtime.tar.gz`);
  const installerRuntimeArchive = join(releaseDir, `chengfeng-videocut-runtime-${version}.tar.gz`);
  const launcher = `#!/bin/sh
set -eu

case "$0" in
  /*) CHENGFENG_VIDEOCUT_EXECUTABLE=$0 ;;
  */*) CHENGFENG_VIDEOCUT_EXECUTABLE=$(pwd)/$0 ;;
  *) CHENGFENG_VIDEOCUT_EXECUTABLE=$(command -v "$0") ;;
esac
export CHENGFENG_VIDEOCUT_EXECUTABLE

if [ -z "\${CHENGFENG_VIDEOCUT_DATA_DIR:-}" ]; then
  STABLE_BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$CHENGFENG_VIDEOCUT_EXECUTABLE")" && pwd)
  if [ "$(basename -- "$STABLE_BIN_DIR")" = "bin" ]; then
    CHENGFENG_VIDEOCUT_DATA_DIR=$(CDPATH= cd -- "$STABLE_BIN_DIR/.." && pwd)
    export CHENGFENG_VIDEOCUT_DATA_DIR
  fi
fi

if [ -z "\${CHENGFENG_VIDEOCUT_DATA_DIR:-}" ]; then
  printf '%s\\n' 'chengfeng-videocut cannot locate its installed data root.' >&2
  exit 127
fi
MANAGED_TOOLS_DIR="$CHENGFENG_VIDEOCUT_DATA_DIR/tools/current"
BUN_EXECUTABLE="$MANAGED_TOOLS_DIR/bun"
if [ ! -x "$BUN_EXECUTABLE" ]; then
  printf '%s\\n' 'chengfeng-videocut installed Bun is missing from tools/current.' >&2
  exit 127
fi

SELF=$0
while [ -L "$SELF" ]; do
  LINK_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
  LINK_TARGET=$(readlink "$SELF")
  case "$LINK_TARGET" in
    /*) SELF=$LINK_TARGET ;;
    *) SELF=$LINK_DIR/$LINK_TARGET ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)

PATH="$MANAGED_TOOLS_DIR"
export PATH
exec "$BUN_EXECUTABLE" "$SCRIPT_DIR/cli.js" "$@"
`;
  const startCommand = `#!/bin/sh
set -eu
INSTALL_ROOT=\${CHENGFENG_VIDEOCUT_HOME:-\${HOME:-}/.chengfeng-videocut}
STABLE_LAUNCHER="$INSTALL_ROOT/bin/chengfeng-videocut"
if [ ! -x "$STABLE_LAUNCHER" ]; then
  printf '%s\\n' 'Install chengfeng-videocut before starting the persistent Studio service.' >&2
  exit 1
fi
exec "$STABLE_LAUNCHER" service ensure --open "$@"
`;
  await rm(stageDir, { recursive: true, force: true });
  try {
    await mkdir(bundleDir, { recursive: true });
    await copyFile(join(cliDistDir, "cli.js"), join(bundleDir, "cli.js"));
    await cp(join(cliDistDir, "studio"), join(bundleDir, "studio"), { recursive: true, force: true });
    await cp(join(cliDistDir, "legal"), join(bundleDir, "legal"), { recursive: true, force: true });
    await copyFile(join(ROOT, "README.md"), join(bundleDir, "README.md"));
    await writeFile(join(bundleDir, "VERSION"), `${version}\n`);
    await writeFile(join(bundleDir, "chengfeng-videocut"), launcher);
    await writeFile(join(bundleDir, "start.command"), startCommand);
    await Promise.all([
      chmod(join(bundleDir, "cli.js"), 0o755),
      chmod(join(bundleDir, "chengfeng-videocut"), 0o755),
      chmod(join(bundleDir, "start.command"), 0o755),
    ]);
    await runCommand("tar", ["-czf", runtimeArchive, "-C", stageDir, bundleName], {
      cwd: ROOT,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    await copyFile(runtimeArchive, installerRuntimeArchive);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function writeLocalFixtureSbom(releaseDir: string, platform: NpmRuntimePlatformKey): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
  const target = NPM_RUNTIME_TARGETS[platform];
  const installerPath = join(releaseDir, target.installerAsset);
  const installerDigest = await sha256File(installerPath);
  await writeFile(
    join(releaseDir, `chengfeng-videocut-sbom-${packageJson.version}-${platform}.spdx.json`),
    `${JSON.stringify({
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: `chengfeng-videocut-runtime-${packageJson.version}-${platform}`,
      documentNamespace: `https://example.invalid/chengfeng-videocut/${packageJson.version}/${platform}/installed-e2e`,
      creationInfo: {
        created: new Date().toISOString(),
        creators: ["Tool: chengfeng-videocut-installed-e2e"],
      },
      packages: [
        {
          name: "chengfeng-videocut",
          SPDXID: "SPDXRef-Package-Product",
          versionInfo: packageJson.version,
          licenseDeclared: "Apache-2.0",
          downloadLocation: `https://example.invalid/chengfeng-videocut/${packageJson.version}`,
        },
        {
          name: "bun",
          SPDXID: "SPDXRef-Package-Bun",
          versionInfo: "1.3.5",
          licenseDeclared: "MIT",
          downloadLocation: "https://example.invalid/bun/1.3.5",
        },
        {
          name: "ffmpeg",
          SPDXID: "SPDXRef-Package-FFmpeg",
          versionInfo: "6.0",
          licenseDeclared: "LGPL-2.1-or-later",
          downloadLocation: "https://example.invalid/ffmpeg/6.0",
        },
        {
          name: "ffprobe",
          SPDXID: "SPDXRef-Package-FFprobe",
          versionInfo: "6.0",
          licenseDeclared: "LGPL-2.1-or-later",
          downloadLocation: "https://example.invalid/ffmpeg/6.0",
        },
      ],
      files: [{
        fileName: `payload/${target.installerAsset}`,
        SPDXID: "SPDXRef-File-Installer",
        checksums: [{ algorithm: "SHA256", checksumValue: installerDigest }],
      }],
      relationships: [
        {
          spdxElementId: "SPDXRef-DOCUMENT",
          relationshipType: "DESCRIBES",
          relatedSpdxElement: "SPDXRef-Package-Product",
        },
        ...["Installer", "Bun", "FFmpeg", "FFprobe"].map((name) => ({
          spdxElementId: "SPDXRef-Package-Product",
          relationshipType: "CONTAINS",
          relatedSpdxElement: `SPDXRef-${name === "Installer" ? "File" : "Package"}-${name}`,
        })),
      ],
    }, null, 2)}\n`,
  );
}

async function buildInstalledCandidate(runRoot: string, stages: Stage[]): Promise<{
  installer: string;
  platform: NpmRuntimePlatformKey;
  tools: JsonRecord;
}> {
  const platform = platformKey();
  const releaseDir = join(runRoot, "release");
  const npmStage = join(runRoot, "npm-runtime-stage");
  const tools = await resolveStaticMediaTools();
  stages.push({ name: "static-media-tools", status: "PASS", details: tools.evidence });
  await mkdir(releaseDir, { recursive: true });
  await runCommand(process.execPath, ["run", "package:build"], { cwd: ROOT });
  await stagePortableRuntime(releaseDir);
  await runCommand(process.execPath, ["scripts/package-managed-tools.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE: "1",
      CHENGFENG_VIDEOCUT_TOOLS_OUTPUT_DIR: releaseDir,
      CHENGFENG_VIDEOCUT_FFMPEG_SOURCE: tools.ffmpeg,
      CHENGFENG_VIDEOCUT_FFPROBE_SOURCE: tools.ffprobe,
    },
  });
  await runCommand(process.execPath, ["scripts/build-native-installer.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHENGFENG_VIDEOCUT_RELEASE_DIR: releaseDir,
      CHENGFENG_VIDEOCUT_INSTALLER_TARGETS: platform,
    },
  });
  await runCommand(process.execPath, ["scripts/write-install-manifest.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHENGFENG_VIDEOCUT_RELEASE_DIR: releaseDir,
      CHENGFENG_VIDEOCUT_ALLOW_PARTIAL_MANIFEST: "1",
      CHENGFENG_VIDEOCUT_ALLOW_LOCAL_TOOLS_FIXTURE: "1",
    },
  });
  await writeLocalFixtureSbom(releaseDir, platform);
  await runCommand(process.execPath, ["scripts/stage-npm-runtime-package.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CHENGFENG_VIDEOCUT_RELEASE_DIR: releaseDir,
      CHENGFENG_VIDEOCUT_NPM_RUNTIME_LOCAL_FIXTURE: "1",
      CHENGFENG_VIDEOCUT_NPM_RUNTIME_TARGETS: platform,
      CHENGFENG_VIDEOCUT_NPM_RUNTIME_STAGE_DIR: npmStage,
    },
  });
  const packageDir = join(npmStage, platform);
  await runCommand(process.execPath, ["scripts/verify-npm-runtime-package.ts", "--allow-local-fixture", packageDir], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test" },
  });
  const installer = join(packageDir, "payload", NPM_RUNTIME_TARGETS[platform].installerAsset);
  stages.push({
    name: "self-contained-candidate",
    status: "PASS",
    details: {
      platform,
      packageDir,
      installer,
      installerSha256: await sha256File(installer),
    },
  });
  return { installer, platform, tools: tools.evidence };
}

function cliPath(home: string): string {
  return join(home, PRODUCT_HOME_NAME, "bin", "chengfeng-videocut");
}

async function installedCli(
  home: string,
  tmp: string,
  args: readonly string[],
  options: { cwd?: string; allowFailure?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<CommandResult> {
  return await runCommand(cliPath(home), args, {
    cwd: options.cwd,
    allowFailure: options.allowFailure,
    env: scrubbedIsolatedEnv(home, tmp, options.env),
  });
}

async function installCandidate(input: {
  installer: string;
  home: string;
  tmp: string;
  stages: Stage[];
}): Promise<void> {
  const result = await runCommand(input.installer, ["--allow-unverified-local-fixture", "--json"], {
    env: scrubbedIsolatedEnv(input.home, input.tmp),
  });
  const payload = parseJsonLine<{ ok?: boolean; data?: JsonRecord }>(result);
  const assetDownloads = Number(payload.data?.assetDownloads);
  const targetRoot = String(payload.data?.targetRoot ?? "");
  if (assetDownloads !== 0) throw new Error(`candidate install downloaded assets: ${assetDownloads}`);
  if (await realpath(targetRoot) !== await realpath(join(input.home, PRODUCT_HOME_NAME))) {
    throw new Error(`candidate installed outside isolated HOME: ${targetRoot}`);
  }
  input.stages.push({
    name: "install",
    status: "PASS",
    details: { targetRoot, assetDownloads, code: result.code },
  });
}

async function authorizeLocalDevelopment(home: string, tmp: string, projectsDir: string, stages: Stage[]): Promise<void> {
  const before = await installedCli(home, tmp, ["doctor", "--local-development", "--json"], { allowFailure: true });
  const beforePayload = parseJsonLine<{ data?: JsonRecord }>(before);
  const auth = await runCommand(process.execPath, [
    "scripts/authorize-local-development.ts",
    "--acknowledge-unverified-local-runtime",
  ], {
    cwd: ROOT,
    env: scrubbedIsolatedEnv(home, tmp),
  });
  const after = await installedCli(home, tmp, [
    "doctor",
    "--local-development",
    "--projects-dir",
    projectsDir,
    "--json",
  ]);
  const afterPayload = parseJsonLine<{ data?: JsonRecord }>(after);
  const data = afterPayload.data ?? {};
  if (
    data.healthy !== true ||
    data.developmentMode !== true ||
    data.releaseReady !== false ||
    data.readinessMode !== "local-development"
  ) {
    throw new Error(`doctor local-development contract not ready: ${JSON.stringify(data)}`);
  }
  const capabilities = jsonObject(data.capabilities) ?? {};
  if (capabilities.projectIngestVersion !== 1 || capabilities.transcriptPlaybackPagingVersion !== 1) {
    throw new Error(`doctor capabilities drift: ${JSON.stringify(capabilities)}`);
  }
  stages.push({
    name: "local-auth-doctor",
    status: "PASS",
    details: {
      beforeHealthy: beforePayload.data?.healthy,
      beforeReadinessMode: beforePayload.data?.readinessMode,
      authCode: auth.code,
      after: {
        healthy: data.healthy,
        developmentMode: data.developmentMode,
        releaseReady: data.releaseReady,
        readinessMode: data.readinessMode,
        capabilities,
      },
    },
  });
}

function transcriptWord(index: number, start: number): JsonRecord {
  const text = ["真", "实", "项", "目", "路", "径", "验", "收"][index % 8]!;
  return { id: `w-${String(index + 1).padStart(3, "0")}`, text, start, end: start + 0.18 };
}

async function writeTranscript(path: string, media: { source: string; sha256: string; duration: number }): Promise<void> {
  const words = Array.from({ length: 144 }, (_, index) => transcriptWord(index, index * 0.2));
  const cues = [];
  for (let index = 0; index < words.length; index += 12) {
    const cueWords = words.slice(index, index + 12);
    cues.push({
      id: `cue-${String(index / 12 + 1).padStart(2, "0")}`,
      words: cueWords,
      start: cueWords[0]!.start,
      end: cueWords.at(-1)!.end,
    });
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    provider: "volcengine",
    language: "zh-CN",
    media,
    cues,
  }, null, 2)}\n`);
}

async function generateAvFixture(ffmpeg: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await runCommand(ffmpeg, [
    "-hide_banner",
    "-y",
    "-f", "lavfi",
    "-i", "testsrc=size=640x360:rate=25:duration=30",
    "-f", "lavfi",
    "-i", "sine=frequency=660:sample_rate=48000:duration=30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    output,
  ]);
}

async function generateSilentFixture(ffmpeg: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await runCommand(ffmpeg, [
    "-hide_banner",
    "-y",
    "-f", "lavfi",
    "-i", "testsrc=size=320x180:rate=25:duration=2",
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    output,
  ]);
}

async function createInstalledProject(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  tasksDir: string;
  ffmpeg: string;
  voiceMedia?: string;
  stages: Stage[];
}): Promise<{
  projectId: string;
  taskDir: string;
  projectDir: string;
  mediaFingerprintBefore: JsonRecord;
  mediaFingerprintAfter: JsonRecord;
  externalFingerprintBefore?: JsonRecord;
  externalFingerprintAfter?: JsonRecord;
}> {
  const taskDir = join(input.tasksDir, "installed-project");
  const media = join(taskDir, "uploads", "talk.mp4");
  const transcript = join(taskDir, "cloud", "words.json");
  await mkdir(join(taskDir, "uploads"), { recursive: true });
  let externalFingerprintBefore: JsonRecord | undefined;
  let externalFingerprintAfter: JsonRecord | undefined;
  if (input.voiceMedia) {
    externalFingerprintBefore = await fileFingerprint(input.voiceMedia);
    await copyFile(input.voiceMedia, media);
  } else {
    await generateAvFixture(input.ffmpeg, media);
    input.stages.push({
      name: "human-voice-input",
      status: "UNVERIFIED",
      details: {
        reason: "--voice-media was not provided; built-in media is generated A/V and is not human speech",
      },
    });
  }
  const mediaSha = await sha256File(media);
  await writeTranscript(transcript, { source: "uploads/talk.mp4", sha256: mediaSha, duration: 30 });
  const mediaFingerprintBefore = await fileFingerprint(media);
  const created = await installedCli(input.home, input.tmp, [
    "project", "create", taskDir,
    "--video", "uploads/talk.mp4",
    "--transcript", "cloud/words.json",
    "--aspect-ratio", "16:9",
    "--projects-dir", input.projectsDir,
    "--json",
  ], { cwd: taskDir });
  const payload = parseJsonLine<{ data?: JsonRecord }>(created);
  const data = payload.data ?? {};
  if (data.projectId !== "installed-project" || data.registered !== true) {
    throw new Error(`project create did not register the isolated project: ${JSON.stringify(data)}`);
  }
  const mediaFingerprintAfter = await fileFingerprint(media);
  if (JSON.stringify(mediaFingerprintBefore) !== JSON.stringify(mediaFingerprintAfter)) {
    throw new Error("task-local input media changed during installed project creation");
  }
  if (input.voiceMedia) externalFingerprintAfter = await fileFingerprint(input.voiceMedia);
  if (
    externalFingerprintBefore &&
    JSON.stringify(externalFingerprintBefore) !== JSON.stringify(externalFingerprintAfter)
  ) {
    throw new Error("external voice media changed during installed project creation");
  }
  input.stages.push({
    name: "installed-project-create",
    status: "PASS",
    details: {
      projectId: data.projectId,
      projectDir: data.directory,
      registered: data.registered,
      transcriptCueCount: data.transcriptCueCount,
      cutWordCount: data.cutWordCount,
      source: input.voiceMedia ? "external-voice-media" : "generated-av-fixture",
      humanVoiceVerified: Boolean(input.voiceMedia),
    },
  });
  return {
    projectId: String(data.projectId),
    taskDir,
    projectDir: String(data.directory),
    mediaFingerprintBefore,
    mediaFingerprintAfter,
    ...(externalFingerprintBefore ? { externalFingerprintBefore, externalFingerprintAfter } : {}),
  };
}

async function assertPlayback(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  projectId: string;
  taskDir: string;
  stages: Stage[];
}): Promise<void> {
  const seen = new Set<number>();
  let cursor: string | null = null;
  let transcriptRevision: string | null = null;
  let editListRevision: string | null = null;
  let totalEntries = 0;
  let pages = 0;
  do {
    const args = [
      "transcript", "playback", input.projectId,
      "--projects-dir", input.projectsDir,
      "--limit", "17",
      "--json",
    ];
    if (cursor) args.push("--cursor", cursor);
    const page = parseJsonLine<{ data?: JsonRecord }>(await installedCli(input.home, input.tmp, args, {
      cwd: input.taskDir,
    })).data ?? {};
    const pageInfo = jsonObject(page.page) ?? {};
    const stream = Array.isArray(page.stream) ? page.stream : [];
    const startIndex = Number(pageInfo.startIndex);
    const endIndex = Number(pageInfo.endIndex);
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || endIndex - startIndex !== stream.length) {
      throw new Error(`bad playback page indexes: ${JSON.stringify(pageInfo)}`);
    }
    for (let index = startIndex; index < endIndex; index += 1) {
      if (seen.has(index)) throw new Error(`duplicate playback index: ${index}`);
      seen.add(index);
    }
    transcriptRevision ??= String(page.transcriptRevision);
    editListRevision ??= page.editListRevision === null ? null : String(page.editListRevision);
    if (transcriptRevision !== page.transcriptRevision || editListRevision !== page.editListRevision) {
      throw new Error("playback revisions changed during paging");
    }
    totalEntries = Number(pageInfo.totalEntries);
    cursor = typeof pageInfo.nextCursor === "string" ? pageInfo.nextCursor : null;
    pages += 1;
  } while (cursor);
  if (seen.size !== totalEntries || totalEntries < 100 || pages < 2) {
    throw new Error(`playback did not cover the full transcript: seen=${seen.size} total=${totalEntries} pages=${pages}`);
  }
  input.stages.push({
    name: "transcript-playback",
    status: "PASS",
    details: { pages, totalEntries, transcriptRevision, editListRevision },
  });
}

async function startInstalledServer(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  dataDir: string;
}): Promise<RunningServer> {
  const child = spawn(cliPath(input.home), [
    "start",
    "--port", "0",
    "--projects-dir", input.projectsDir,
    "--data-dir", input.dataDir,
    "--json",
  ], {
    env: scrubbedIsolatedEnv(input.home, input.tmp),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const line = await new Promise<string>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`start --port 0 did not print JSON: ${stderr.slice(-2000)}`));
    }, 20_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`start exited before ready: ${code ?? signal} ${stderr.slice(-2000)}`));
    });
    const poll = setInterval(() => {
      const match = stdout.match(/^(\{.*\})/m);
      if (!match) return;
      clearInterval(poll);
      clearTimeout(timeout);
      resolvePromise(match[1]!);
    }, 25);
  });
  const payload = JSON.parse(line) as { data?: JsonRecord };
  const data = payload.data ?? {};
  if (typeof data.url !== "string" || typeof data.pid !== "number" || typeof data.port !== "number") {
    throw new Error(`start returned invalid server data: ${line}`);
  }
  if (child.pid !== undefined && data.pid !== child.pid) {
    throw new Error(`start returned a PID not owned by this harness: child=${child.pid} reported=${data.pid}`);
  }
  return { child, url: data.url, pid: data.pid, port: data.port };
}

async function stopServer(server: RunningServer | null): Promise<JsonRecord> {
  if (!server) return { stopped: false };
  if (server.child.exitCode !== null) return { stopped: true, alreadyExited: true, code: server.child.exitCode };
  server.child.kill("SIGTERM");
  const code = await new Promise<number | null>((resolvePromise) => {
    const timeout = setTimeout(() => {
      server.child.kill("SIGKILL");
    }, 5_000);
    server.child.once("exit", (value) => {
      clearTimeout(timeout);
      resolvePromise(value);
    });
  });
  return { stopped: true, pid: server.pid, code };
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) as unknown : null,
  };
}

async function exerciseServerAndCuts(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  dataDir: string;
  projectId: string;
  taskDir: string;
  stages: Stage[];
}): Promise<RunningServer> {
  const server = await startInstalledServer(input);
  const health = await fetchJson(`${server.url}/api/health`);
  const capabilities = await fetchJson(`${server.url}/chengfeng-videocut-capabilities.json`);
  const surface = await fetchJson(`${server.url}/api/projects/${encodeURIComponent(input.projectId)}/surface`);
  if (health.status !== 200 || capabilities.status !== 200 || surface.status !== 200) {
    throw new Error(`server marker failed: ${JSON.stringify({ health, capabilities, surface })}`);
  }
  const surfaceBody = jsonObject(surface.body);
  if (surfaceBody?.surface !== "koubo") throw new Error(`unexpected Studio surface marker: ${JSON.stringify(surface.body)}`);
  const before = parseJsonLine<{ data?: JsonRecord }>(await installedCli(input.home, input.tmp, [
    "cuts", "get", input.projectId,
    "--projects-dir", input.projectsDir,
    "--api-base", server.url,
    "--json",
  ], { cwd: input.taskDir })).data ?? {};
  const revision = String(before.revision);
  const document = jsonObject(before.document) ?? {};
  const previousIds = Array.isArray(document.cutWordIds)
    ? document.cutWordIds.filter((id): id is string => typeof id === "string")
    : [];
  const nextIds = [...new Set([...previousIds, "w-001"])];
  const proposal = join(input.taskDir, "cuts-proposal.json");
  await writeFile(proposal, `${JSON.stringify({ cutWordIds: nextIds }, null, 2)}\n`);
  const set = parseJsonLine<{ data?: JsonRecord }>(await installedCli(input.home, input.tmp, [
    "cuts", "set", input.projectId,
    "--projects-dir", input.projectsDir,
    "--api-base", server.url,
    "--expected-revision", revision,
    "--file", proposal,
    "--json",
  ], { cwd: input.taskDir })).data ?? {};
  if (set.readBackVerified !== true) throw new Error(`cuts.set did not report readBackVerified: ${JSON.stringify(set)}`);
  const stale = await installedCli(input.home, input.tmp, [
    "cuts", "set", input.projectId,
    "--projects-dir", input.projectsDir,
    "--api-base", server.url,
    "--expected-revision", revision,
    "--file", proposal,
    "--json",
  ], { cwd: input.taskDir, allowFailure: true });
  const stalePayload = parseJsonLine<{ error?: JsonRecord }>(stale);
  if (stale.code !== 5 || stalePayload.error?.code !== "revision_conflict") {
    throw new Error(`stale CAS write did not conflict: ${JSON.stringify(stalePayload)}`);
  }
  input.stages.push({
    name: "studio-http-cuts",
    status: "PASS",
    details: {
      server: { url: server.url, pid: server.pid, port: server.port },
      surface: surface.body as JsonRecord,
      initialRevision: revision,
      writtenRevision: set.revision,
      readBackVerified: set.readBackVerified,
      staleExitCode: stale.code,
    },
  });
  input.stages.push({
    name: "real-browser-route",
    status: "UNVERIFIED",
    details: {
      reason: "no browser automation dependency is required by this harness; HTTP route marker was verified",
      route: `${server.url}/?view=koubo#project/${encodeURIComponent(input.projectId)}`,
    },
  });
  return server;
}

async function exerciseCursorStale(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  projectId: string;
  taskDir: string;
  stages: Stage[];
}): Promise<void> {
  const first = parseJsonLine<{ data?: JsonRecord }>(await installedCli(input.home, input.tmp, [
    "transcript", "playback", input.projectId,
    "--projects-dir", input.projectsDir,
    "--limit", "10",
    "--json",
  ], { cwd: input.taskDir })).data ?? {};
  const cursor = jsonObject(first.page)?.nextCursor;
  if (typeof cursor !== "string") throw new Error("first playback page did not return a cursor");
  const corrections = join(input.taskDir, "corrections.json");
  await writeFile(corrections, `${JSON.stringify([{ wordId: "w-001", text: "验" }], null, 2)}\n`);
  const corrected = await installedCli(input.home, input.tmp, [
    "transcript", "correct", input.projectId,
    "--projects-dir", input.projectsDir,
    "--file", corrections,
    "--json",
  ], { cwd: input.taskDir });
  const stale = await installedCli(input.home, input.tmp, [
    "transcript", "playback", input.projectId,
    "--projects-dir", input.projectsDir,
    "--cursor", cursor,
    "--json",
  ], { cwd: input.taskDir, allowFailure: true });
  const stalePayload = parseJsonLine<{ error?: JsonRecord }>(stale);
  if (
    stale.code !== 5 ||
    stalePayload.error?.code !== "revision_conflict" ||
    jsonObject(stalePayload.error.details)?.reason !== "playback_cursor_stale"
  ) {
    throw new Error(`stale cursor did not fail closed: ${JSON.stringify(stalePayload)}`);
  }
  input.stages.push({
    name: "cursor-stale",
    status: "PASS",
    details: {
      correctionCode: corrected.code,
      staleExitCode: stale.code,
      staleError: stalePayload.error,
    },
  });
}

async function exerciseSilenceFailure(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  tasksDir: string;
  ffmpeg: string;
  stages: Stage[];
}): Promise<void> {
  const taskDir = join(input.tasksDir, "silent-project");
  const media = join(taskDir, "uploads", "silent.mp4");
  await generateSilentFixture(input.ffmpeg, media);
  const result = await installedCli(input.home, input.tmp, [
    "project", "ingest", taskDir,
    "--video", "uploads/silent.mp4",
    "--projects-dir", input.projectsDir,
    "--json",
  ], {
    cwd: taskDir,
    allowFailure: true,
    env: { VOLCENGINE_API_KEY: "installed-e2e-fake-key" },
  });
  const payload = parseJsonLine<{ error?: JsonRecord }>(result);
  if (result.code !== 4 || payload.error?.code !== "media_has_no_audio") {
    throw new Error(`silent media failure path drifted: ${JSON.stringify({ code: result.code, payload })}`);
  }
  input.stages.push({
    name: "silent-media-failure",
    status: "PASS",
    details: { exitCode: result.code, error: payload.error },
  });
}

async function runSourceFakeIngestRecovery(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  tasksDir: string;
  ffmpeg: string;
  stages: Stage[];
}): Promise<void> {
  const { runCli } = await import("../apps/cli/src/run");
  const taskDir = join(input.tasksDir, "fake-provider-retry");
  const media = join(taskDir, "uploads", "talk.mp4");
  await generateAvFixture(input.ffmpeg, media);
  const mediaSha = await sha256File(media);
  let calls = 0;
  const capture = (): { io: CliIo; stdout: string[]; stderr: string[] } => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      io: {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    };
  };
  const runOnce = async () => {
    const captured = capture();
    const code = await runCli([
      "project", "ingest", taskDir,
      "--video", "uploads/talk.mp4",
      "--projects-dir", input.projectsDir,
      "--json",
    ], {
      cwd: taskDir,
      io: captured.io,
      runTranscription: async (_jobDir, options) => {
        calls += 1;
        await writeTranscript(join(taskDir, options.output), {
          source: options.video,
          sha256: mediaSha,
          duration: 30,
        });
        return {
          provider: "volcengine",
          source: join(taskDir, options.video),
          output: join(taskDir, options.output),
          cueCount: 12,
          wordCount: 144,
          duration: 30,
        };
      },
    });
    return { code, payload: JSON.parse(captured.stdout.join("")) as { data?: JsonRecord; error?: JsonRecord } };
  };
  const previousEnv = {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY,
    CHENGFENG_VIDEOCUT_HOME: process.env.CHENGFENG_VIDEOCUT_HOME,
    CHENGFENG_VIDEOCUT_DATA_DIR: process.env.CHENGFENG_VIDEOCUT_DATA_DIR,
    CHENGFENG_VIDEOCUT_PROJECTS_DIR: process.env.CHENGFENG_VIDEOCUT_PROJECTS_DIR,
    VIDEO_WORKBENCH_PROJECTS_DIR: process.env.VIDEO_WORKBENCH_PROJECTS_DIR,
  };
  try {
    const nextEnv = scrubbedIsolatedEnv(input.home, input.tmp, {
      VOLCENGINE_API_KEY: "source-fake-provider-recovery",
    });
    for (const key of Object.keys(previousEnv)) {
      if (nextEnv[key] === undefined) delete process.env[key];
      else process.env[key] = nextEnv[key];
    }
    const first = await runOnce();
    if (first.code !== 0) throw new Error(`first fake-provider ingest failed: ${JSON.stringify(first.payload)}`);
    const second = await runOnce();
    if (second.code !== 0) throw new Error(`retry fake-provider ingest failed: ${JSON.stringify(second.payload)}`);
    const secondData = second.payload.data ?? {};
    const transcription = jsonObject(secondData.transcription) ?? {};
    if (calls !== 1 || transcription.reused !== true || transcription.reusedProject !== true) {
      throw new Error(`response-loss retry did not reuse stage/project: calls=${calls} ${JSON.stringify(transcription)}`);
    }
    input.stages.push({
      name: "source-level-fake-provider-response-loss-retry",
      status: "PASS",
      details: {
        proofScope: "source-level logic test only; not installed binary or cloud ASR proof",
        transcriptionCalls: calls,
        reused: transcription.reused,
        reusedProject: transcription.reusedProject,
        projectId: secondData.projectId,
      },
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function maybeRunRealCloudIngest(input: {
  home: string;
  tmp: string;
  projectsDir: string;
  tasksDir: string;
  voiceMedia?: string;
  cloudIngest: boolean;
  stages: Stage[];
}): Promise<void> {
  if (!input.cloudIngest) {
    input.stages.push({
      name: "real-cloud-ingest",
      status: "SKIP",
      details: { reason: "set CHENGFENG_VIDEOCUT_INSTALLED_E2E_CLOUD=1 or --cloud-ingest to run real cloud ASR" },
    });
    return;
  }
  if (!input.voiceMedia) {
    input.stages.push({
      name: "real-cloud-ingest",
      status: "SKIP",
      details: { reason: "--voice-media is required for real cloud ingest" },
    });
    return;
  }
  if (!process.env.VOLCENGINE_API_KEY?.trim()) {
    input.stages.push({
      name: "real-cloud-ingest",
      status: "SKIP",
      details: { reason: "VOLCENGINE_API_KEY is not set; no cloud ASR was faked" },
    });
    return;
  }
  const taskDir = join(input.tasksDir, "real-cloud-ingest");
  const media = join(taskDir, "uploads", "talk.mp4");
  await mkdir(dirname(media), { recursive: true });
  const before = await fileFingerprint(input.voiceMedia);
  await copyFile(input.voiceMedia, media);
  const result = await installedCli(input.home, input.tmp, [
    "project", "ingest", taskDir,
    "--video", "uploads/talk.mp4",
    "--projects-dir", input.projectsDir,
    "--json",
  ], {
    cwd: taskDir,
    env: {
      VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY,
      VOLCENGINE_ASR_RESOURCE_ID: process.env.VOLCENGINE_ASR_RESOURCE_ID,
      VOLCENGINE_ASR_MODEL_NAME: process.env.VOLCENGINE_ASR_MODEL_NAME,
    },
  });
  const data = parseJsonLine<{ data?: JsonRecord }>(result).data ?? {};
  const after = await fileFingerprint(input.voiceMedia);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("real cloud voice input changed");
  input.stages.push({
    name: "real-cloud-ingest",
    status: "PASS",
    details: {
      projectId: data.projectId,
      transcriptCueCount: data.transcriptCueCount,
      transcription: data.transcription,
      externalFingerprint: before,
    },
  });
}

async function endpointStillReachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(750) });
    return true;
  } catch {
    return false;
  }
}

function aggregateStatus(stages: readonly Stage[]): StageStatus {
  if (stages.some((stage) => stage.status === "FAIL")) return "FAIL";
  if (stages.some((stage) => stage.status === "BLOCKED")) return "BLOCKED";
  if (stages.some((stage) => stage.status === "UNVERIFIED")) return "UNVERIFIED";
  return "PASS";
}

async function writeFinalEvidence(input: {
  options: Options;
  runRoot: string;
  summary: JsonRecord;
}): Promise<string> {
  const evidenceOut = input.options.evidenceOut
    ? resolve(input.options.evidenceOut)
    : join(await realpath(tmpdir()), `${EVIDENCE_PREFIX}${Date.now()}-${process.pid}.json`);
  const summary = { ...input.summary, evidenceOut };
  await mkdir(dirname(evidenceOut), { recursive: true });
  await writeFile(evidenceOut, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return evidenceOut;
}

async function main(): Promise<number> {
  const options = parseArgs(Bun.argv.slice(2));
  if (!options.run) {
    const payload = {
      ok: true,
      status: "SKIP",
      command: "installed-product-e2e",
      optIn: DEFAULT_OPT_IN,
      message: `set ${DEFAULT_OPT_IN}=1 or pass --run to execute the installed-product E2E`,
    };
    if (options.json) console.log(JSON.stringify(payload));
    else console.log(payload.message);
    return 0;
  }

  const stages: Stage[] = [];
  const runRoot = await makeRunRoot(options);
  const home = join(runRoot, "home");
  const tmp = join(runRoot, "tmp");
  const dataDir = join(runRoot, "data");
  const projectsDir = join(runRoot, "projects");
  const tasksDir = join(runRoot, "target", "tasks");
  let server: RunningServer | null = null;
  let restartedServer: RunningServer | null = null;
  let cleanup: JsonRecord = {};
  let evidenceOut = "";
  let status: StageStatus = "FAIL";
  await Promise.all([mkdir(home, { recursive: true }), mkdir(tmp, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(projectsDir, { recursive: true }), mkdir(tasksDir, { recursive: true })]);
  await Promise.all([
    assertUnderRoot("isolated HOME", home, runRoot),
    assertUnderRoot("isolated tmp", tmp, runRoot),
    assertUnderRoot("isolated data", dataDir, runRoot),
    assertUnderRoot("isolated projects", projectsDir, runRoot),
    assertUnderRoot("isolated tasks", tasksDir, runRoot),
  ]);
  const startedPids: number[] = [];
  const serverUrls: string[] = [];
  try {
    if (process.env.CHENGFENG_VIDEOCUT_INSTALLED_E2E_SELFTEST_SURVIVOR === "1") {
      const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      if (survivor.pid !== undefined) startedPids.push(survivor.pid);
      stages.push({
        name: "cleanup-survivor-selftest",
        status: "PASS",
        details: { pid: survivor.pid, scope: "test-only cleanup fatal path" },
      });
      throw new Error("intentional cleanup survivor self-test");
    }
    const candidate = await buildInstalledCandidate(runRoot, stages);
    await installCandidate({ installer: candidate.installer, home, tmp, stages });
    stages.push({
      name: "isolation-boundaries",
      status: "PASS",
      details: {
        runRoot: await realpath(runRoot),
        home: await assertUnderRoot("installed HOME", home, runRoot),
        productRoot: await assertUnderRoot("installed Product root", join(home, PRODUCT_HOME_NAME), runRoot),
        projectsDir: await assertUnderRoot("project registry", projectsDir, runRoot),
        dataDir: await assertUnderRoot("server data dir", dataDir, runRoot),
        tasksDir: await assertUnderRoot("task target root", tasksDir, runRoot),
        proof: "absolute isolated paths plus owned foreground process PIDs; no default Runtime or user project probes",
      },
    });
    await authorizeLocalDevelopment(home, tmp, projectsDir, stages);
    const staticTools = await resolveStaticMediaTools();
    const project = await createInstalledProject({
      home,
      tmp,
      projectsDir,
      tasksDir,
      ffmpeg: staticTools.ffmpeg,
      voiceMedia: options.voiceMedia ? resolve(options.voiceMedia) : undefined,
      stages,
    });
    await assertPlayback({ home, tmp, projectsDir, projectId: project.projectId, taskDir: project.taskDir, stages });
    server = await exerciseServerAndCuts({
      home,
      tmp,
      projectsDir,
      dataDir,
      projectId: project.projectId,
      taskDir: project.taskDir,
      stages,
    });
    startedPids.push(server.pid);
    serverUrls.push(server.url);
    await exerciseCursorStale({ home, tmp, projectsDir, projectId: project.projectId, taskDir: project.taskDir, stages });
    await exerciseSilenceFailure({ home, tmp, projectsDir, tasksDir, ffmpeg: staticTools.ffmpeg, stages });
    await runSourceFakeIngestRecovery({ home, tmp, projectsDir, tasksDir, ffmpeg: staticTools.ffmpeg, stages });
    await maybeRunRealCloudIngest({
      home,
      tmp,
      projectsDir,
      tasksDir,
      voiceMedia: options.voiceMedia ? resolve(options.voiceMedia) : undefined,
      cloudIngest: options.cloudIngest,
      stages,
    });
    const firstStop = await stopServer(server);
    server = null;
    restartedServer = await startInstalledServer({ home, tmp, projectsDir, dataDir });
    startedPids.push(restartedServer.pid);
    serverUrls.push(restartedServer.url);
    const restarted = { url: restartedServer.url, pid: restartedServer.pid, port: restartedServer.port };
    const restartedHealth = await fetchJson(`${restarted.url}/api/health`);
    const restartStop = await stopServer(restartedServer);
    restartedServer = null;
    stages.push({
      name: "foreground-service-restart",
      status: restartedHealth.status === 200 ? "PASS" : "FAIL",
      details: {
        managedServiceRestart: "UNVERIFIED: skipped to avoid touching the user-wide managed service",
        firstStop,
        restarted: { ...restarted, status: restartedHealth.status },
        restartStop,
      },
    });
    status = aggregateStatus(stages);
  } catch (error) {
    stages.push({
      name: "harness-error",
      status: "FAIL",
      details: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    status = aggregateStatus(stages);
  } finally {
    const stopResults = [];
    if (server) stopResults.push(await stopServer(server));
    if (restartedServer) stopResults.push(await stopServer(restartedServer));
    const childAlive: number[] = [];
    for (const pid of startedPids) {
      try {
        process.kill(pid, 0);
        childAlive.push(pid);
      } catch {
        // Process is gone.
      }
    }
    for (const pid of childAlive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort forced cleanup after recording the survivor.
      }
    }
    const endpointAlive = [];
    for (const url of serverUrls) {
      if (await endpointStillReachable(url)) endpointAlive.push(url);
    }
    const cleanupFailures = [
      ...(childAlive.length > 0 ? ["child process survived normal cleanup"] : []),
      ...(endpointAlive.length > 0 ? ["server endpoint survived normal cleanup"] : []),
    ];
    let runRootRemoved = false;
    if (!options.keep) {
      try {
        await rm(runRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(`run root cleanup threw: ${error instanceof Error ? error.message : String(error)}`);
      }
      runRootRemoved = !await stat(runRoot).then(() => true).catch(() => false);
      if (!runRootRemoved) cleanupFailures.push("run root still exists after cleanup");
    }
    cleanup = { stoppedServers: stopResults, childAlive, endpointAlive, runRootRemoved };
    if (cleanupFailures.length > 0) {
      stages.push({
        name: "cleanup-fatal",
        status: "FAIL",
        details: { failures: cleanupFailures, cleanup },
      });
      status = "FAIL";
    } else if (status !== "FAIL" && status !== "BLOCKED") {
      status = aggregateStatus(stages);
    }
    const summary: JsonRecord = {
      ok: status === "PASS",
      status,
      command: "installed-product-e2e",
      runRoot,
      keep: options.keep,
      stages,
      cleanup,
    };
    evidenceOut = await writeFinalEvidence({ options, runRoot, summary });
    const finalSummary = {
      ...summary,
      evidenceOut,
      cleanup,
    };
    await writeFile(evidenceOut, `${JSON.stringify(finalSummary, null, 2)}\n`, { mode: 0o600 });
    if (options.json) console.log(JSON.stringify(finalSummary));
    else console.log(`installed-product E2E ${status}; evidence: ${evidenceOut}`);
  }
  return status === "PASS" || status === "UNVERIFIED" ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
