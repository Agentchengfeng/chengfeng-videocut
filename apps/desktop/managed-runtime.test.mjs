import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureManagedRuntime,
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

test("installBundledTools stages versioned desktop dependencies without activating tools/current", async () => {
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
    await assert.rejects(realpath(layout.toolsCurrentDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed staged-tool verification leaves the prior shared tools and Runtime current links untouched", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-managed-tools-rollback-"));
  try {
    const source = join(root, "source");
    const dataDir = join(root, "data");
    await mkdir(source);
    const previous = await installBundledTools({
      dataDir,
      version: "0.4.7",
      platform: process.platform,
      manifest: {
        product: "chengfeng-videocut",
        productVersion: "0.4.7",
        platform: process.platform,
        arch: process.arch,
        bun: "old",
        ffmpeg: "old",
        ffprobe: "old",
      },
      bundledBunPath: await writeExecutable(source, "bun", "#!/bin/sh\nexit 0\n"),
      bundledFfmpegPath: await writeExecutable(source, "ffmpeg", "#!/bin/sh\nexit 0\n"),
      bundledFfprobePath: await writeExecutable(source, "ffprobe", "#!/bin/sh\nexit 0\n"),
    });
    await symlink("0.4.7", previous.toolsCurrentDir);
    const oldRuntime = join(dataDir, "app", "0.4.7");
    await mkdir(oldRuntime, { recursive: true });
    await symlink("0.4.7", join(dataDir, "app", "current"));

    await assert.rejects(
      ensureManagedRuntime({
        dataDir,
        version: "0.4.8",
        platform: process.platform,
        manifest: {
          product: "chengfeng-videocut",
          productVersion: "0.4.8",
          platform: process.platform,
          arch: process.arch,
          bun: "new",
          ffmpeg: "new",
          ffprobe: "new",
        },
        bundledBunPath: await writeExecutable(source, "new-bun", "#!/bin/sh\nexit 1\n"),
        bundledFfmpegPath: await writeExecutable(source, "new-ffmpeg", "#!/bin/sh\nexit 0\n"),
        bundledFfprobePath: await writeExecutable(source, "new-ffprobe", "#!/bin/sh\nexit 0\n"),
        installerDir: source,
        installerPath: join(source, "unused-install.cjs"),
      }),
      /Bundled Bun verification failed/,
    );
    assert.equal(await realpath(previous.toolsCurrentDir), await realpath(previous.toolsVersionDir));
    assert.equal(await realpath(join(dataDir, "app", "current")), await realpath(oldRuntime));
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

async function writeExecutable(directory, name, contents) {
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}
