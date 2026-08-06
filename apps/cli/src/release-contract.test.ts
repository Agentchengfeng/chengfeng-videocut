import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
    for (const name of requiredReleaseAssetNames(PRODUCT_VERSION)) {
      await Bun.write(join(releaseDir, name), `fixture:${name}\n`);
    }

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
