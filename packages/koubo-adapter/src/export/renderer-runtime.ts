/**
 * Product-owned lifecycle for the browser that renders export overlays.
 *
 * This deliberately takes the small, useful part of Remotion's browser
 * management model without adopting its React renderer: one pinned Headless
 * Shell is fetched only when a render first needs it, put in a product cache,
 * verified, and reused by every later export. It never searches or modifies a
 * user's Chrome installation.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createReadStream } from "node:fs";
import {
  Browser,
  BrowserPlatform,
  detectBrowserPlatform,
  install,
} from "@puppeteer/browsers";

const PRODUCT = "chengfeng-videocut";
const ENGINE = "chrome-headless-shell";
const MANIFEST_FILE = "renderer-engine.json";
const LOCK_DIRECTORY = "renderer-download.lock";
const DEFAULT_BUILD_ID = "151.0.7922.47";
const DEFAULT_LOCK_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const INCOMPLETE_LOCK_PUBLICATION_GRACE_MS = 5_000;

/**
 * These are archive SHA-256 values computed from the exact Chrome for Testing
 * Headless Shell archives named by DEFAULT_BUILD_ID. A new engine is a source
 * change and release-review event, never a "latest" lookup at runtime.
 */
const ARCHIVE_SHA256: Partial<Record<BrowserPlatform, string>> = {
  [BrowserPlatform.MAC_ARM]: "0bf92463e337d207792b6ba460a06db1d40ab048e72f80cf608942cd7885552f",
  [BrowserPlatform.MAC]: "c59bae764cfd38c6f26b076f19bee73dea6f8aa416781ce7467bf363db9e3996",
  [BrowserPlatform.WIN64]: "26f826217d9b6b626c000daa12a939d53b92aadd810dcec5d4fcf8ef5dc7498f",
};

export class RendererRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererRuntimeError";
  }
}

export interface RendererEngineSpec {
  buildId: string;
  archiveSha256: string;
  browser?: Browser;
}

export interface RendererDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

export interface RendererInstallerInput {
  cacheDirectory: string;
  browser: Browser;
  platform: BrowserPlatform;
  buildId: string;
  expectedArchiveSha256: string;
  onProgress?: (progress: RendererDownloadProgress) => void;
}

export interface RendererInstallerResult {
  installationDirectory: string;
  executablePath: string;
}

export type RendererInstaller = (input: RendererInstallerInput) => Promise<RendererInstallerResult>;

export interface RendererRuntimeOptions {
  /** Product Runtime root. Defaults to the active Runtime data root. */
  dataDirectory?: string;
  /** Test/development seam for an isolated cache. Must not be a project directory. */
  cacheDirectory?: string;
  platform?: BrowserPlatform;
  spec?: RendererEngineSpec;
  installer?: RendererInstaller;
  onProgress?: (progress: RendererDownloadProgress) => void;
  signal?: AbortSignal;
  lockTimeoutMs?: number;
  retryDelayMs?: number;
  /** Test seam; production always proves the executable with `--version`. */
  verifyExecutable?: (path: string, buildId: string) => Promise<void>;
}

export interface RendererRuntime {
  executablePath: string;
  cacheDirectory: string;
  platform: BrowserPlatform;
  buildId: string;
  source: "cache" | "download";
}

interface RendererManifest {
  schemaVersion: 1;
  product: typeof PRODUCT;
  engine: typeof ENGINE;
  platform: BrowserPlatform;
  buildId: string;
  archiveSha256: string;
  executable: string;
  executableSha256: string;
  installedAt: string;
}

interface LockOwner {
  schemaVersion: 1;
  pid: number;
  token: string;
  createdAt: string;
}

const inFlight = new Map<string, Promise<RendererRuntime>>();

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new RendererRuntimeError("渲染引擎准备已取消。");
  }
}

function ensureRelativePath(value: string, label: string): string {
  if (!value || isAbsolute(value) || value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new RendererRuntimeError(`${label} 必须是无穿越的相对路径。`);
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return Boolean(child) && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function defaultDataDirectory(): string {
  return process.env.CHENGFENG_VIDEOCUT_DATA_DIR
    ?? process.env.CHENGFENG_VIDEOCUT_HOME
    ?? join(homedir(), ".chengfeng-videocut");
}

function defaultSpec(platform: BrowserPlatform): RendererEngineSpec {
  const archiveSha256 = ARCHIVE_SHA256[platform];
  if (!archiveSha256) {
    throw new RendererRuntimeError(
      `当前 Product 没有锁定 ${platform} 的 Headless Shell 摘要；导出不会借用系统浏览器或下载 latest。`,
    );
  }
  return {
    buildId: DEFAULT_BUILD_ID,
    archiveSha256,
    browser: Browser.CHROMEHEADLESSSHELL,
  };
}

function validateSpec(spec: RendererEngineSpec): Required<RendererEngineSpec> {
  if (!/^\d+(?:\.\d+){2,}$/.test(spec.buildId)) {
    throw new RendererRuntimeError("渲染引擎 buildId 必须是固定的完整版本号。");
  }
  if (!isDigest(spec.archiveSha256)) {
    throw new RendererRuntimeError("渲染引擎 archive SHA-256 缺失或无效；拒绝下载。 ");
  }
  return {
    buildId: spec.buildId,
    archiveSha256: spec.archiveSha256.toLowerCase(),
    browser: spec.browser ?? Browser.CHROMEHEADLESSSHELL,
  };
}

function installationDirectory(cacheDirectory: string, platform: BrowserPlatform, buildId: string): string {
  return join(cacheDirectory, ENGINE, `${platform}-${buildId}`);
}

function cacheKey(cacheDirectory: string, platform: BrowserPlatform, spec: Required<RendererEngineSpec>): string {
  return [cacheDirectory, platform, spec.browser, spec.buildId, spec.archiveSha256].join("\u0000");
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularExecutable(path: string, platform: BrowserPlatform): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new RendererRuntimeError("渲染引擎可执行文件必须是单链接普通文件。 ");
  }
  await access(path, platform === BrowserPlatform.WIN32 || platform === BrowserPlatform.WIN64
    ? constants.R_OK
    : constants.R_OK | constants.X_OK).catch(() => {
    throw new RendererRuntimeError("渲染引擎可执行文件不可读或不可执行。 ");
  });
}

async function assertSafeTree(directory: string): Promise<void> {
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new RendererRuntimeError("渲染引擎安装目录必须是普通目录。 ");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const childMetadata = await lstat(child);
    if (childMetadata.isSymbolicLink()) throw new RendererRuntimeError(`渲染引擎包含不允许的符号链接：${entry.name}`);
    if (childMetadata.isDirectory()) {
      await assertSafeTree(child);
    } else if (!childMetadata.isFile() || childMetadata.nlink !== 1) {
      throw new RendererRuntimeError(`渲染引擎包含不允许的特殊文件：${entry.name}`);
    }
  }
}

async function assertInside(root: string, candidate: string, label: string): Promise<void> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isInside(canonicalRoot, canonicalCandidate)) {
    throw new RendererRuntimeError(`${label} 逃出了渲染引擎暂存目录。`);
  }
}

async function defaultVerifyExecutable(path: string, buildId: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(path, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let output = "";
    const append = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-64 * 1024);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RendererRuntimeError("渲染引擎版本自检超时。"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new RendererRuntimeError(`渲染引擎无法启动：${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new RendererRuntimeError(`渲染引擎版本自检失败（${code ?? "unknown"}）：${output.trim()}`));
      } else if (!output.includes(buildId)) {
        reject(new RendererRuntimeError(`渲染引擎版本不是已锁定的 ${buildId}：${output.trim()}`));
      } else {
        resolvePromise();
      }
    });
  });
}

async function defaultInstaller(input: RendererInstallerInput): Promise<RendererInstallerResult> {
  const installed = await install({
    browser: input.browser,
    platform: input.platform,
    buildId: input.buildId,
    cacheDir: input.cacheDirectory,
    unpack: true,
    expectedHash: input.expectedArchiveSha256,
    downloadProgressCallback: input.onProgress
      ? (downloadedBytes, totalBytes) => input.onProgress?.({ downloadedBytes, totalBytes })
      : undefined,
  });
  return {
    installationDirectory: installed.path,
    executablePath: installed.executablePath,
  };
}

function parseManifest(raw: unknown): RendererManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 || value.product !== PRODUCT || value.engine !== ENGINE ||
    typeof value.platform !== "string" || typeof value.buildId !== "string" ||
    typeof value.archiveSha256 !== "string" || typeof value.executable !== "string" ||
    typeof value.executableSha256 !== "string" || typeof value.installedAt !== "string"
  ) return null;
  if (!isDigest(value.archiveSha256) || !isDigest(value.executableSha256)) return null;
  try {
    ensureRelativePath(value.executable, "渲染引擎 executable");
  } catch {
    return null;
  }
  return value as unknown as RendererManifest;
}

async function readCachedRuntime(
  directory: string,
  platform: BrowserPlatform,
  spec: Required<RendererEngineSpec>,
): Promise<RendererRuntime | null> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    const manifest = parseManifest(JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8")));
    if (!manifest || manifest.platform !== platform || manifest.buildId !== spec.buildId ||
      manifest.archiveSha256 !== spec.archiveSha256) return null;
    const executablePath = resolve(directory, manifest.executable);
    await assertInside(directory, executablePath, "渲染引擎 executable");
    await regularExecutable(executablePath, platform);
    if (await sha256(executablePath) !== manifest.executableSha256) return null;
    return {
      executablePath,
      cacheDirectory: dirname(dirname(directory)),
      platform,
      buildId: spec.buildId,
      source: "cache",
    };
  } catch {
    return null;
  }
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 || !Number.isInteger(value.pid) || (value.pid as number) < 1 ||
      typeof value.token !== "string" || !value.token || typeof value.createdAt !== "string"
    ) return null;
    return value as unknown as LockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function acquireDownloadLock(
  cacheDirectory: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  retryDelayMs: number,
): Promise<() => Promise<void>> {
  const lockPath = join(cacheDirectory, LOCK_DIRECTORY);
  const startedAt = Date.now();
  const token = randomUUID();
  for (;;) {
    throwIfAborted(signal);
    try {
      await mkdir(lockPath);
      const owner: LockOwner = {
        schemaVersion: 1,
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return async () => {
        const ownerPath = join(lockPath, "owner.json");
        const current = parseLockOwner(await readFile(ownerPath, "utf8").catch(() => ""));
        if (!current || current.token !== token || current.pid !== process.pid) {
          throw new RendererRuntimeError("渲染引擎下载锁所有权已变化；保留现场，拒绝删除。 ");
        }
        await rm(lockPath, { recursive: true, force: false });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    const owner = parseLockOwner(await readFile(join(lockPath, "owner.json"), "utf8").catch(() => ""));
    if (!owner) {
      // mkdir is atomic but writing owner.json is not. A second export may
      // observe the tiny interval between the two operations; wait for a
      // freshly-created directory to publish its owner instead of rejecting a
      // legitimate concurrent download. An old/damaged directory remains
      // fail-closed and is never deleted without a proven-dead owner.
      const metadata = await lstat(lockPath).catch(() => null);
      const isFreshPublication = Boolean(
        metadata?.isDirectory()
        && Date.now() - metadata.mtimeMs < INCOMPLETE_LOCK_PUBLICATION_GRACE_MS,
      );
      if (isFreshPublication && Date.now() - startedAt < timeoutMs) {
        await delay(retryDelayMs);
        continue;
      }
      throw new RendererRuntimeError("渲染引擎下载锁不完整；为避免删除未知进程的现场而停止。 ");
    }
    if (!processIsAlive(owner.pid)) {
      await rm(lockPath, { recursive: true, force: false }).catch((error) => {
        throw new RendererRuntimeError(`无法回收已死亡的渲染引擎下载锁：${String(error)}`);
      });
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new RendererRuntimeError("等待另一项渲染引擎下载超时；它仍在运行，未改动其缓存。 ");
    }
    await delay(retryDelayMs);
  }
}

async function quarantineInvalidInstall(cacheDirectory: string, directory: string, token: string): Promise<void> {
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata) return;
  const quarantine = join(cacheDirectory, ".quarantine");
  await mkdir(quarantine, { recursive: true });
  await rename(directory, join(quarantine, `${basename(directory)}-${Date.now()}-${token}`));
}

async function writeManifest(directory: string, manifest: RendererManifest): Promise<void> {
  const destination = join(directory, MANIFEST_FILE);
  const temporary = join(directory, `.${MANIFEST_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function downloadAndActivate(
  cacheDirectory: string,
  finalDirectory: string,
  platform: BrowserPlatform,
  spec: Required<RendererEngineSpec>,
  options: RendererRuntimeOptions,
): Promise<RendererRuntime> {
  const transactionId = randomUUID();
  const stagingRoot = join(cacheDirectory, ".pending", transactionId);
  const stagingCache = join(stagingRoot, "cache");
  const stagedEngine = join(stagingRoot, "engine");
  const installer = options.installer ?? defaultInstaller;
  const verifyExecutable = options.verifyExecutable ?? defaultVerifyExecutable;
  try {
    await mkdir(stagingCache, { recursive: true });
    throwIfAborted(options.signal);
    const downloaded = await installer({
      cacheDirectory: stagingCache,
      browser: spec.browser,
      platform,
      buildId: spec.buildId,
      expectedArchiveSha256: spec.archiveSha256,
      onProgress: options.onProgress,
    });
    throwIfAborted(options.signal);
    await assertInside(stagingRoot, downloaded.installationDirectory, "下载的渲染引擎");
    await assertInside(downloaded.installationDirectory, downloaded.executablePath, "下载的渲染引擎 executable");
    const executable = relative(downloaded.installationDirectory, downloaded.executablePath);
    ensureRelativePath(executable, "下载的渲染引擎 executable");
    await assertSafeTree(downloaded.installationDirectory);
    if (platform !== BrowserPlatform.WIN32 && platform !== BrowserPlatform.WIN64) {
      await chmod(downloaded.executablePath, 0o755);
    }
    await regularExecutable(downloaded.executablePath, platform);
    await verifyExecutable(downloaded.executablePath, spec.buildId);
    const executableSha256 = await sha256(downloaded.executablePath);
    await rename(downloaded.installationDirectory, stagedEngine);
    await writeManifest(stagedEngine, {
      schemaVersion: 1,
      product: PRODUCT,
      engine: ENGINE,
      platform,
      buildId: spec.buildId,
      archiveSha256: spec.archiveSha256,
      executable,
      executableSha256,
      installedAt: new Date().toISOString(),
    });
    await mkdir(dirname(finalDirectory), { recursive: true });
    await quarantineInvalidInstall(cacheDirectory, finalDirectory, transactionId);
    await rename(stagedEngine, finalDirectory);
    const activated = await readCachedRuntime(finalDirectory, platform, spec);
    if (!activated) throw new RendererRuntimeError("渲染引擎已激活但自证失败；保留缓存现场。 ");
    return { ...activated, source: "download" };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Return the one Product-owned Headless Shell for this platform.
 *
 * The hot path reads and verifies the activated cache. The cold path is a
 * single-flight, cross-process locked transaction that downloads into a
 * sibling pending directory and atomically renames it only after an
 * executable/version self-test succeeds.
 */
export async function ensureRendererRuntime(options: RendererRuntimeOptions = {}): Promise<RendererRuntime> {
  const platform = options.platform ?? detectBrowserPlatform();
  if (!platform) {
    throw new RendererRuntimeError(`Chrome Headless Shell 不支持当前平台：${process.platform}/${process.arch}`);
  }
  const spec = validateSpec(options.spec ?? defaultSpec(platform));
  const cacheDirectory = resolve(options.cacheDirectory ?? join(options.dataDirectory ?? defaultDataDirectory(), "cache", "renderer-engine"));
  const finalDirectory = installationDirectory(cacheDirectory, platform, spec.buildId);
  const cached = await readCachedRuntime(finalDirectory, platform, spec);
  if (cached) return cached;
  const key = cacheKey(cacheDirectory, platform, spec);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const operation = (async () => {
    await mkdir(cacheDirectory, { recursive: true });
    const release = await acquireDownloadLock(
      cacheDirectory,
      options.signal,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    );
    try {
      const afterLock = await readCachedRuntime(finalDirectory, platform, spec);
      if (afterLock) return afterLock;
      return await downloadAndActivate(cacheDirectory, finalDirectory, platform, spec, options);
    } finally {
      await release();
    }
  })();
  inFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(key);
  }
}
