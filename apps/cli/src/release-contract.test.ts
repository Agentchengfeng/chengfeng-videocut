import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  requiredReleaseAssetNames,
  windowsDesktopInstallerName,
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

  it("keeps generated Electron resources out of the public source archive", async () => {
    const sourcePackager = await readFile(join(rootDir, "scripts/pack-source.ts"), "utf8");
    expect(sourcePackager).toContain('"dist-resources"');
  });

  it("copies installers and checksums every portable, tgz, and Windows desktop asset", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "videocut-release-contract-"));
    cleanupPaths.push(fixtureRoot);
    const releaseDir = join(fixtureRoot, "release");
    await mkdir(releaseDir, { recursive: true });
    await Bun.write(join(fixtureRoot, "install.sh"), "#!/bin/sh\nVERSION=fixture\n");
    await Bun.write(join(fixtureRoot, "install.cjs"), 'const VERSION = "fixture";\n');

    const assetNames = requiredReleaseAssetNames(PRODUCT_VERSION).filter(
      (name) => name !== "install.sh" && name !== "install.cjs",
    );
    for (const name of assetNames) {
      await Bun.write(join(releaseDir, name), `fixture:${name}\n`);
    }

    const result = await writeReleaseChecksums({
      rootDir: fixtureRoot,
      releaseDir,
      version: PRODUCT_VERSION,
    });
    const sums = await readFile(result.checksumPath, "utf8");
    expect(result.lines).toHaveLength(7);
    for (const name of requiredReleaseAssetNames(PRODUCT_VERSION)) {
      expect(sums).toContain(`  ${name}\n`);
    }
    expect(windowsDesktopInstallerName(PRODUCT_VERSION)).toBe(
      `Chengfeng-VideoCut-${PRODUCT_VERSION}-win-x64.exe`,
    );
    const installer = await readFile(join(releaseDir, "install.sh"), "utf8");
    expect(installer).toBe("#!/bin/sh\nVERSION=fixture\n");
    expect(sums).toContain(
      `${createHash("sha256").update(installer).digest("hex")}  install.sh\n`,
    );
  });

  it("fails closed when a required archive is missing", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "videocut-release-missing-"));
    cleanupPaths.push(fixtureRoot);
    const releaseDir = join(fixtureRoot, "release");
    await writeFile(join(fixtureRoot, "install.sh"), "#!/bin/sh\n");
    await writeFile(join(fixtureRoot, "install.cjs"), 'const VERSION = "fixture";\n');
    await expect(
      writeReleaseChecksums({ rootDir: fixtureRoot, releaseDir, version: PRODUCT_VERSION }),
    ).rejects.toThrow("Missing chengfeng-videocut");
  });
});
