import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NPM_RUNTIME_PACKAGE_MANIFEST,
  NPM_RUNTIME_TARGETS,
  stageNpmRuntimePackages,
  verifyNpmRuntimePackage,
  type NpmRuntimePlatformKey,
} from "../scripts/npm-runtime-package";

const ROOT = resolve(import.meta.dir, "..");
const VERSION = "0.5.1";
const PLATFORM: NpmRuntimePlatformKey = "darwin-arm64";
const temporaryRoots: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(options: {
  releaseReady?: boolean;
  allPlatforms?: boolean;
} = {}): Promise<{ root: string; releaseDir: string; outputDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-npm-runtime-package-"));
  temporaryRoots.push(root);
  const releaseDir = join(root, "release");
  const outputDir = join(root, "stage");
  await mkdir(releaseDir);
  const platforms: Record<string, unknown> = {};
  const keys = options.allPlatforms ? Object.keys(NPM_RUNTIME_TARGETS) as NpmRuntimePlatformKey[] : [PLATFORM];
  for (const platformKey of keys) {
    const target = NPM_RUNTIME_TARGETS[platformKey];
    const bytes = Buffer.from(`fixture native installer:${platformKey}\n`);
    const installerPath = join(releaseDir, target.installerAsset);
    await writeFile(installerPath, bytes);
    if (target.executable) await chmod(installerPath, 0o755);
    let tools = {
      asset: `fixture-tools-${platformKey}.tar.gz`,
      root: `fixture-tools-${platformKey}`,
      sha256: "f".repeat(64),
      size: 1,
    };
    if (options.releaseReady) {
      const [platform, arch] = platformKey.split("-");
      const toolsRootName = `chengfeng-videocut-tools-${VERSION}-${platformKey}`;
      const toolsRoot = join(root, toolsRootName);
      await mkdir(toolsRoot);
      const suffix = platform === "win32" ? ".exe" : "";
      const executables = {
        bun: `bun${suffix}`,
        ffmpeg: `ffmpeg${suffix}`,
        ffprobe: `ffprobe${suffix}`,
      };
      const files = [];
      for (const [name, path] of Object.entries(executables)) {
        const bytes = Buffer.from(`${platformKey}:${name}\n`);
        const absolute = join(toolsRoot, path);
        await writeFile(absolute, bytes);
        if (platform === "darwin") await chmod(absolute, 0o755);
        files.push({ path, size: bytes.length, sha256: sha256(bytes) });
      }
      await writeFile(join(toolsRoot, "resources-manifest.json"), `${JSON.stringify({
        schemaVersion: 4,
        product: "chengfeng-videocut-managed-tools",
        productVersion: VERSION,
        platform,
        arch,
        executables,
        versions: { bun: "test", ffmpeg: "test", ffprobe: "test" },
        distributionMode: "release-ready",
        files,
        licenseStatus: "VERIFIED",
        licenseNote: "explicit test fixture; never publish",
      }, null, 2)}\n`);
      const toolsAsset = `${toolsRootName}.tar.gz`;
      const archived = spawnSync("tar", ["-czf", join(releaseDir, toolsAsset), "-C", root, toolsRootName], {
        encoding: "utf8",
      });
      expect(archived.status).toBe(0);
      const archiveBytes = await readFile(join(releaseDir, toolsAsset));
      tools = {
        asset: toolsAsset,
        root: toolsRootName,
        sha256: sha256(archiveBytes),
        size: archiveBytes.length,
      };
    }
    platforms[platformKey] = {
      installerAsset: target.installerAsset,
      installer: {
        asset: target.installerAsset,
        sha256: sha256(bytes),
        size: bytes.length,
      },
      tools,
    };
  }
  const releaseReady = options.releaseReady === true;
  let runtime = {
    asset: `fixture-runtime-${VERSION}.tar.gz`,
    root: `fixture-runtime-${VERSION}`,
    sha256: "e".repeat(64),
    size: 1,
  };
  if (releaseReady) {
    const asset = `chengfeng-videocut-runtime-${VERSION}.tar.gz`;
    const bytes = Buffer.from("fixture Product Runtime archive\n");
    await writeFile(join(releaseDir, asset), bytes);
    runtime = {
      asset,
      root: `chengfeng-videocut-${VERSION}`,
      sha256: sha256(bytes),
      size: bytes.length,
    };
  }
  await writeFile(join(releaseDir, "chengfeng-videocut-install-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "chengfeng-videocut",
    productVersion: VERSION,
    releaseTag: `v${VERSION}`,
    distributionMode: releaseReady ? "release-ready" : "local-test-only",
    runtime,
    platforms,
    licenseStatus: releaseReady ? "VERIFIED" : "UNVERIFIED",
    licenseNote: "explicit test fixture; never publish",
  }, null, 2)}\n`);
  return { root, releaseDir, outputDir };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("npm Runtime platform package", () => {
  test("stages one data-only platform package with an exact layout and installer digest", async () => {
    const value = await fixture({ releaseReady: true, allPlatforms: true });
    const receipts = await stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: value.outputDir,
      platformKeys: [PLATFORM],
    });
    expect(receipts).toHaveLength(1);
    const packageDir = join(value.outputDir, PLATFORM);
    const manifest = await verifyNpmRuntimePackage({ packageDir });
    expect(manifest).toEqual({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      productVersion: VERSION,
      platformKey: PLATFORM,
      npmPackage: {
        name: "@chengfeng/videocut-runtime-darwin-arm64",
        version: VERSION,
        os: ["darwin"],
        cpu: ["arm64"],
      },
      distributionMode: "release-ready",
      licenseStatus: "VERIFIED",
      licenseNote: "explicit test fixture; never publish",
      installer: {
        asset: "chengfeng-videocut-installer-macos-arm64",
        path: "payload/chengfeng-videocut-installer-macos-arm64",
        sha256: sha256(Buffer.from(`fixture native installer:${PLATFORM}\n`)),
        size: Buffer.byteLength(`fixture native installer:${PLATFORM}\n`),
        executable: true,
      },
    });
    const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    expect(packageJson.os).toEqual(["darwin"]);
    expect(packageJson.cpu).toEqual(["arm64"]);
    expect(packageJson.files).toEqual([
      NPM_RUNTIME_PACKAGE_MANIFEST,
      "payload/chengfeng-videocut-installer-macos-arm64",
    ]);
    expect(packageJson).not.toHaveProperty("scripts");
    expect(packageJson).not.toHaveProperty("bin");
  });

  test("npm pack dry-run contains only the allowlisted data files", async () => {
    const value = await fixture({ releaseReady: true, allPlatforms: true });
    await stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: value.outputDir,
      platformKeys: [PLATFORM],
    });
    const packageDir = join(value.outputDir, PLATFORM);
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
      cwd: packageDir,
      encoding: "utf8",
    });
    expect(packed.status).toBe(0);
    const report = JSON.parse(packed.stdout);
    expect(report).toHaveLength(1);
    expect(report[0].files.map((file: { path: string }) => file.path).sort()).toEqual([
      NPM_RUNTIME_PACKAGE_MANIFEST,
      "package.json",
      "payload/chengfeng-videocut-installer-macos-arm64",
    ].sort());
  });

  test("rejects UNVERIFIED/local-test-only input unless the test fixture path is explicit", async () => {
    const value = await fixture();
    await expect(stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: value.outputDir,
      platformKeys: [PLATFORM],
    })).rejects.toThrow(/release-ready \/ VERIFIED/);

    const explicitOutput = join(value.root, "explicit-stage");
    await stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: explicitOutput,
      platformKeys: [PLATFORM],
      allowLocalFixture: true,
    });
    const packageDir = join(explicitOutput, PLATFORM);
    await expect(verifyNpmRuntimePackage({ packageDir })).rejects.toThrow(/release-ready \/ VERIFIED/);
    const manifest = await verifyNpmRuntimePackage({ packageDir, allowLocalFixture: true });
    expect(manifest.distributionMode).toBe("local-test-only");
    expect(manifest.licenseStatus).toBe("UNVERIFIED");
    const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    expect(packageJson.private).toBe(true);
    expect(packageJson).not.toHaveProperty("publishConfig");
  });

  test("rejects any file outside the three-file package allowlist", async () => {
    const value = await fixture({ releaseReady: true, allPlatforms: true });
    await stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: value.outputDir,
      platformKeys: [PLATFORM],
    });
    const packageDir = join(value.outputDir, PLATFORM);
    await writeFile(join(packageDir, "postinstall.js"), "throw new Error('must never run');\n");
    await expect(verifyNpmRuntimePackage({ packageDir })).rejects.toThrow(/unexpected file: postinstall\.js/);
  });

  test("rejects lifecycle/bin metadata and installer tampering", async () => {
    const value = await fixture({ releaseReady: true, allPlatforms: true });
    await stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: value.outputDir,
      platformKeys: [PLATFORM],
    });
    const packageDir = join(value.outputDir, PLATFORM);
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.scripts = { postinstall: "node postinstall.js" };
    packageJson.bin = { "chengfeng-videocut": "payload/chengfeng-videocut-installer-macos-arm64" };
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await expect(verifyNpmRuntimePackage({ packageDir })).rejects.toThrow(/package\.json keys are not exact/);

    delete packageJson.scripts;
    delete packageJson.bin;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(join(packageDir, "payload/chengfeng-videocut-installer-macos-arm64"), "tampered\n");
    await expect(verifyNpmRuntimePackage({ packageDir })).rejects.toThrow(/size\/SHA256 does not match/);
  });

  test("does not overwrite an existing stage destination", async () => {
    const value = await fixture({ releaseReady: true, allPlatforms: true });
    await mkdir(value.outputDir);
    await writeFile(join(value.outputDir, "sentinel.txt"), "preserve\n");
    await expect(stageNpmRuntimePackages({
      rootDir: ROOT,
      releaseDir: value.releaseDir,
      outputDir: value.outputDir,
      platformKeys: [PLATFORM],
    })).rejects.toThrow(/stage destination already exists/);
    expect(await readFile(join(value.outputDir, "sentinel.txt"), "utf8")).toBe("preserve\n");
  });
});
