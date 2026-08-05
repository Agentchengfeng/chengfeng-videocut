import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installBundledTools,
  resolveManagedRuntimeLayout,
  runCaptured,
} from "./managed-runtime.mjs";

test("resolveManagedRuntimeLayout exposes stable shared Product paths", () => {
  const layout = resolveManagedRuntimeLayout({
    dataDir: "C:/Users/test/.chengfeng-videocut",
    version: "0.4.7",
    platform: "win32",
  });
  assert.equal(layout.managedBunPath, join(layout.toolsVersionDir, "bun.exe"));
  assert.equal(
    layout.stableLauncherPath,
    join(layout.root, "bin", "chengfeng-videocut.cmd"),
  );
  assert.equal(layout.installedCliPath, join(layout.root, "app", "current", "cli.js"));
});

test("installBundledTools versions the desktop dependencies and points current at them", async () => {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-managed-tools-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    const suffix = process.platform === "win32" ? ".exe" : "";
    const bun = join(source, `bun${suffix}`);
    const ffmpeg = join(source, `ffmpeg${suffix}`);
    const ffprobe = join(source, `ffprobe${suffix}`);
    await Promise.all([
      writeFile(bun, "bun"),
      writeFile(ffmpeg, "ffmpeg"),
      writeFile(ffprobe, "ffprobe"),
    ]);
    const manifest = {
      schemaVersion: 1,
      product: "chengfeng-videocut",
      productVersion: "0.4.7",
      platform: process.platform,
      arch: process.arch,
      bun: "1.3.5",
      ffmpeg: "ffmpeg 7",
      ffprobe: "ffprobe 7",
    };
    const dataDir = join(root, "data");
    const layout = await installBundledTools({
      dataDir,
      version: "0.4.7",
      platform: process.platform,
      manifest,
      bundledBunPath: bun,
      bundledFfmpegPath: ffmpeg,
      bundledFfprobePath: ffprobe,
    });

    assert.equal(await readFile(layout.managedBunPath, "utf8"), "bun");
    assert.equal(await realpath(layout.toolsCurrentDir), await realpath(layout.toolsVersionDir));
    assert.deepEqual(
      JSON.parse(await readFile(layout.toolsManifestPath, "utf8")),
      manifest,
    );

    await installBundledTools({
      dataDir,
      version: "0.4.7",
      platform: process.platform,
      manifest,
      bundledBunPath: bun,
      bundledFfmpegPath: ffmpeg,
      bundledFfprobePath: ffprobe,
    });
    assert.equal(await realpath(layout.toolsCurrentDir), await realpath(layout.toolsVersionDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installBundledTools refuses to overwrite an unmanaged current directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-managed-tools-conflict-"));
  try {
    const source = join(root, "source");
    const dataDir = join(root, "data");
    await mkdir(source);
    await mkdir(join(dataDir, "tools", "current"), { recursive: true });
    const suffix = process.platform === "win32" ? ".exe" : "";
    const files = ["bun", "ffmpeg", "ffprobe"].map((name) => join(source, `${name}${suffix}`));
    await Promise.all(files.map((path) => writeFile(path, path)));
    await assert.rejects(
      installBundledTools({
        dataDir,
        version: "0.4.7",
        platform: process.platform,
        manifest: {
          product: "chengfeng-videocut",
          productVersion: "0.4.7",
          platform: process.platform,
          arch: process.arch,
          bun: "1",
          ffmpeg: "1",
          ffprobe: "1",
        },
        bundledBunPath: files[0],
        bundledFfmpegPath: files[1],
        bundledFfprobePath: files[2],
      }),
      /not a managed link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCaptured reports bounded command output", async () => {
  const result = await runCaptured(
    process.execPath,
    ["-e", "process.stdout.write('managed-ok')"],
    { timeoutMs: 5_000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "managed-ok");
  assert.equal(result.overflow, false);
});
