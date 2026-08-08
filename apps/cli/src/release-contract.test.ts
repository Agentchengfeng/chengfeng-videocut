import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  requiredReleaseAssetNames,
  nativeInstallerAssetNames,
  verifyReleaseAssetManifest,
  writeReleaseChecksums,
} from "../../../scripts/release-assets";
import { checkVersionContract } from "../../../scripts/version-contract";
import { PRODUCT_VERSION } from "./output";

const cleanupPaths: string[] = [];
const rootDir = resolve(import.meta.dir, "../../..");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assetRecord(path: string, root?: string): Promise<{
  asset: string;
  root?: string;
  sha256: string;
  size: number;
}> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return {
    asset: path.split("/").at(-1)!,
    ...(root ? { root } : {}),
    sha256: digest(bytes),
    size: bytes.byteLength,
  };
}

async function writeValidNativeRelease(releaseDir: string, stageDir: string): Promise<void> {
  const runtimeAsset = `chengfeng-videocut-runtime-${PRODUCT_VERSION}.tar.gz`;
  await Bun.write(join(releaseDir, runtimeAsset), "fixture runtime\n");
  for (const name of nativeInstallerAssetNames()) {
    await Bun.write(join(releaseDir, name), `fixture:${name}\n`);
    if (name.includes("macos")) await chmod(join(releaseDir, name), 0o755);
  }
  const platforms = [
    ["darwin-arm64", "darwin", "arm64", "chengfeng-videocut-installer-macos-arm64"],
    ["darwin-x64", "darwin", "x64", "chengfeng-videocut-installer-macos-x64"],
    ["win32-x64", "win32", "x64", "chengfeng-videocut-installer-windows-x64.exe"],
  ] as const;
  const platformRecords: Record<string, unknown> = {};
  for (const [platformKey, platform, arch, installerAsset] of platforms) {
    const toolsAsset = `chengfeng-videocut-tools-${PRODUCT_VERSION}-${platformKey}.tar.gz`;
    const toolsRoot = toolsAsset.slice(0, -".tar.gz".length);
    const root = join(stageDir, toolsRoot);
    await mkdir(root, { recursive: true });
    const executableNames = platform === "win32"
      ? { bun: "bun.exe", ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" }
      : { bun: "bun", ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
    const files = [];
    for (const [name, relative] of Object.entries(executableNames)) {
      const bytes = new TextEncoder().encode(`fixture:${platformKey}:${name}\n`);
      await Bun.write(join(root, relative), bytes);
      if (platform === "darwin") await chmod(join(root, relative), 0o755);
      files.push({ path: relative, size: bytes.byteLength, sha256: digest(bytes) });
    }
    await Bun.write(join(root, "resources-manifest.json"), `${JSON.stringify({
      schemaVersion: 4,
      product: "chengfeng-videocut-managed-tools",
      productVersion: PRODUCT_VERSION,
      platform,
      arch,
      distributionMode: "release-ready",
      licenseStatus: "VERIFIED",
      versions: {},
      executables: executableNames,
      files,
    })}\n`);
    const child = Bun.spawn(["tar", "-czf", join(releaseDir, toolsAsset), "-C", stageDir, toolsRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`tar fixture failed: ${stderr}`);
    platformRecords[platformKey] = {
      installerAsset,
      installer: await assetRecord(join(releaseDir, installerAsset)),
      tools: await assetRecord(join(releaseDir, toolsAsset), toolsRoot),
    };
  }
  await Bun.write(join(releaseDir, "chengfeng-videocut-install-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "chengfeng-videocut",
    productVersion: PRODUCT_VERSION,
    releaseTag: `v${PRODUCT_VERSION}`,
    distributionMode: "release-ready",
    runtime: await assetRecord(
      join(releaseDir, runtimeAsset),
      `chengfeng-videocut-${PRODUCT_VERSION}`,
    ),
    platforms: platformRecords,
    licenseStatus: "VERIFIED",
  })}\n`);
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("release contract", () => {
  it("keeps every product version surface aligned", async () => {
    expect(await checkVersionContract(rootDir)).toBe(PRODUCT_VERSION);
  });

  it("keeps installed CLI commands on the stable install data root", async () => {
    const portablePackager = await readFile(join(rootDir, "scripts/package-portable.ts"), "utf8");
    expect(portablePackager).toContain("CHENGFENG_VIDEOCUT_EXECUTABLE");
    expect(portablePackager).toContain("CHENGFENG_VIDEOCUT_DATA_DIR");
    expect(portablePackager).toContain('basename -- "$STABLE_BIN_DIR"');
    expect(portablePackager).toContain('tools/current');
    expect(portablePackager).toContain('MANAGED_TOOLS_DIR');
    const installer = await readFile(join(rootDir, "install.cjs"), "utf8");
    expect(installer).toContain('tools\\\\current');
    expect(installer).toContain('MANAGED_TOOLS');
    expect(installer).toContain('CHENGFENG_VIDEOCUT_EXECUTABLE=%~f0');
    expect(installer).toContain('CHENGFENG_VIDEOCUT_CHROME_PATH=');
    expect(installer).toContain('unset CHENGFENG_VIDEOCUT_CHROME_PATH');
  });

  it("keeps developer source archives outside the Windows prerelease asset contract", async () => {
    expect(requiredReleaseAssetNames(PRODUCT_VERSION)).not.toContain(
      `chengfeng-videocut-${PRODUCT_VERSION}-source.tar.gz`,
    );
    const sourcePackager = await readFile(join(rootDir, "scripts/pack-source.ts"), "utf8");
    expect(sourcePackager).toContain('join(root, "source-archives")');
    expect(sourcePackager).not.toContain('join(root, "release")');
  });

  it("checksums the manifest, Runtime, three native installers, and three tools bundles", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "videocut-release-contract-"));
    cleanupPaths.push(fixtureRoot);
    const releaseDir = join(fixtureRoot, "release");
    await mkdir(releaseDir, { recursive: true });
    await writeValidNativeRelease(releaseDir, join(fixtureRoot, "stage"));

    const result = await writeReleaseChecksums({
      rootDir: fixtureRoot,
      releaseDir,
      version: PRODUCT_VERSION,
    });
    const sums = await readFile(result.checksumPath, "utf8");
    expect(result.lines).toHaveLength(8);
    for (const name of requiredReleaseAssetNames(PRODUCT_VERSION)) {
      expect(sums).toContain(`  ${name}\n`);
    }
    expect(nativeInstallerAssetNames()).toEqual([
      "chengfeng-videocut-installer-macos-arm64",
      "chengfeng-videocut-installer-macos-x64",
      "chengfeng-videocut-installer-windows-x64.exe",
    ]);
    await expect(
      verifyReleaseAssetManifest({ releaseDir, version: PRODUCT_VERSION }),
    ).resolves.toEqual({
      assetNames: [...requiredReleaseAssetNames(PRODUCT_VERSION)].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
      checksums: expect.any(Map),
    });
    const windowsInstaller = "chengfeng-videocut-installer-windows-x64.exe";
    await Bun.write(join(releaseDir, windowsInstaller), "tampered\n");
    await expect(
      verifyReleaseAssetManifest({ releaseDir, version: PRODUCT_VERSION }),
    ).rejects.toThrow(`SHA256 mismatch for ${windowsInstaller}`);
  });

  it("fails closed when a required archive is missing", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "videocut-release-missing-"));
    cleanupPaths.push(fixtureRoot);
    const releaseDir = join(fixtureRoot, "release");
    await expect(
      writeReleaseChecksums({ rootDir: fixtureRoot, releaseDir, version: PRODUCT_VERSION }),
    ).rejects.toThrow("Missing chengfeng-videocut");
  });

  it("rejects a source archive left in the Windows prerelease directory", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "videocut-release-source-"));
    cleanupPaths.push(fixtureRoot);
    const releaseDir = join(fixtureRoot, "release");
    await mkdir(releaseDir, { recursive: true });
    for (const name of requiredReleaseAssetNames(PRODUCT_VERSION)) {
      await Bun.write(join(releaseDir, name), `fixture:${name}\n`);
    }
    await Bun.write(
      join(releaseDir, `chengfeng-videocut-${PRODUCT_VERSION}-source.tar.gz`),
      "not a release payload\n",
    );
    await expect(
      writeReleaseChecksums({ rootDir: fixtureRoot, releaseDir, version: PRODUCT_VERSION }),
    ).rejects.toThrow("Release directory contains unsupported assets");
  });
});
