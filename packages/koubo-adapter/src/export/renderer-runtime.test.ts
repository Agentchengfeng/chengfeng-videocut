import { afterEach, describe, expect, it } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, BrowserPlatform } from "@puppeteer/browsers";
import {
  ensureRendererRuntime,
  type RendererInstaller,
  type RendererInstallerInput,
} from "./renderer-runtime";

const cleanup: string[] = [];
const platform = BrowserPlatform.MAC_ARM;
const buildId = "151.0.7922.47";
const archiveSha256 = "a".repeat(64);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "videocut-render-engine-test-"));
  cleanup.push(directory);
  return directory;
}

async function writeFixture(input: RendererInstallerInput): Promise<{ installationDirectory: string; executablePath: string }> {
  const installationDirectory = join(
    input.cacheDirectory,
    "chrome-headless-shell",
    `${input.platform}-${input.buildId}`,
  );
  const executablePath = join(installationDirectory, "chrome-headless-shell");
  await mkdir(installationDirectory, { recursive: true });
  await writeFile(executablePath, `#!/bin/sh\nprintf '%s\\n' '${input.buildId}'\n`);
  await chmod(executablePath, 0o755);
  return { installationDirectory, executablePath };
}

function fixtureInstaller(calls: RendererInstallerInput[]): RendererInstaller {
  return async (input) => {
    calls.push(input);
    return writeFixture(input);
  };
}

async function directoryExists(path: string): Promise<boolean> {
  return lstat(path).then((metadata) => metadata.isDirectory()).catch(() => false);
}

function options(
  cache: string,
  installer: RendererInstaller,
  overrides: Record<string, unknown> = {},
) {
  return {
    cacheDirectory: cache,
    platform,
    installer,
    spec: { buildId, archiveSha256, browser: Browser.CHROMEHEADLESSSHELL },
    ...overrides,
  };
}

describe("product-owned renderer runtime", () => {
  it("downloads once into a verified cache and reuses the activated engine", async () => {
    const cache = await cacheDirectory();
    const calls: RendererInstallerInput[] = [];
    const installer = fixtureInstaller(calls);

    const first = await ensureRendererRuntime(options(cache, installer));
    const second = await ensureRendererRuntime(options(cache, installer));

    expect(first.source).toBe("download");
    expect(second.source).toBe("cache");
    expect(second.executablePath).toBe(first.executablePath);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      browser: Browser.CHROMEHEADLESSSHELL,
      platform,
      buildId,
      expectedArchiveSha256: archiveSha256,
    });
    const manifest = JSON.parse(await readFile(join(cache, "chrome-headless-shell", `${platform}-${buildId}`, "renderer-engine.json"), "utf8"));
    expect(manifest).toMatchObject({
      product: "chengfeng-videocut",
      engine: "chrome-headless-shell",
      platform,
      buildId,
      archiveSha256,
    });
  });

  it("quarantines a tampered cache and replaces it rather than borrowing a system browser", async () => {
    const cache = await cacheDirectory();
    const calls: RendererInstallerInput[] = [];
    const installer = fixtureInstaller(calls);
    const first = await ensureRendererRuntime(options(cache, installer));
    await writeFile(first.executablePath, "tampered");

    const repaired = await ensureRendererRuntime(options(cache, installer));

    expect(repaired.source).toBe("download");
    expect(calls).toHaveLength(2);
    expect(await readFile(repaired.executablePath, "utf8")).toContain(buildId);
    expect(await directoryExists(join(cache, ".quarantine"))).toBe(true);
  });

  it("deduplicates concurrent callers in one Runtime process", async () => {
    const cache = await cacheDirectory();
    const calls: RendererInstallerInput[] = [];
    let releaseInstaller!: () => void;
    const installerGate = new Promise<void>((resolvePromise) => {
      releaseInstaller = resolvePromise;
    });
    const installer: RendererInstaller = async (input) => {
      calls.push(input);
      await installerGate;
      return writeFixture(input);
    };
    const first = ensureRendererRuntime(options(cache, installer));
    const second = ensureRendererRuntime(options(cache, installer));
    while (calls.length === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    expect(calls).toHaveLength(1);
    releaseInstaller();

    const [a, b] = await Promise.all([first, second]);

    expect(a.executablePath).toBe(b.executablePath);
    expect(calls).toHaveLength(1);
  });

  it("recovers only a lock whose owner PID is demonstrably dead", async () => {
    const cache = await cacheDirectory();
    const lock = join(cache, "renderer-download.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      token: "dead-owner",
      createdAt: new Date(0).toISOString(),
    })}\n`);
    const calls: RendererInstallerInput[] = [];

    await expect(ensureRendererRuntime(options(cache, fixtureInstaller(calls)))).resolves.toMatchObject({ source: "download" });

    expect(calls).toHaveLength(1);
    expect(await directoryExists(lock)).toBe(false);
  });

  it("fails closed for an incomplete cross-process lock", async () => {
    const cache = await cacheDirectory();
    const lock = join(cache, "renderer-download.lock");
    await mkdir(lock, { recursive: true });
    await utimes(lock, new Date(0), new Date(0));
    const calls: RendererInstallerInput[] = [];

    await expect(ensureRendererRuntime(options(cache, fixtureInstaller(calls))))
      .rejects.toThrow("下载锁不完整");

    expect(calls).toHaveLength(0);
    expect(await directoryExists(lock)).toBe(true);
  });

  it("waits for a fresh lock to publish its owner before deciding whether to recover it", async () => {
    const cache = await cacheDirectory();
    const lock = join(cache, "renderer-download.lock");
    await mkdir(lock, { recursive: true });
    const calls: RendererInstallerInput[] = [];
    const pending = ensureRendererRuntime(options(cache, fixtureInstaller(calls), { retryDelayMs: 5 }));
    setTimeout(() => {
      void writeFile(join(lock, "owner.json"), `${JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        token: "published-dead-owner",
        createdAt: new Date(0).toISOString(),
      })}\n`);
    }, 20);

    await expect(pending).resolves.toMatchObject({ source: "download" });
    expect(calls).toHaveLength(1);
  });

  it("rejects a downloader result that escapes its pending transaction", async () => {
    const cache = await cacheDirectory();
    const outside = await mkdtemp(join(tmpdir(), "videocut-render-engine-outside-"));
    cleanup.push(outside);
    const executablePath = join(outside, "chrome-headless-shell");
    await writeFile(executablePath, `#!/bin/sh\nprintf '%s\\n' '${buildId}'\n`);
    await chmod(executablePath, 0o755);
    const installer: RendererInstaller = async () => ({
      installationDirectory: outside,
      executablePath,
    });

    await expect(ensureRendererRuntime(options(cache, installer))).rejects.toThrow("逃出了渲染引擎暂存目录");
  });
});
