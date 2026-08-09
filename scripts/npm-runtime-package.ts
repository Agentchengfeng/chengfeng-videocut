import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { verifyNativeReleaseInputs } from "./release-assets";

export const NPM_RUNTIME_PACKAGE_MANIFEST = "chengfeng-videocut-runtime-package.json";

export const NPM_RUNTIME_TARGETS = {
  "darwin-arm64": {
    packageName: "@chengfeng/videocut-runtime-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    installerAsset: "chengfeng-videocut-installer-macos-arm64",
    executable: true,
  },
  "darwin-x64": {
    packageName: "@chengfeng/videocut-runtime-darwin-x64",
    os: "darwin",
    cpu: "x64",
    installerAsset: "chengfeng-videocut-installer-macos-x64",
    executable: true,
  },
  "win32-x64": {
    packageName: "@chengfeng/videocut-runtime-win32-x64",
    os: "win32",
    cpu: "x64",
    installerAsset: "chengfeng-videocut-installer-windows-x64.exe",
    executable: false,
  },
} as const;

export type NpmRuntimePlatformKey = keyof typeof NPM_RUNTIME_TARGETS;
type DistributionMode = "release-ready" | "local-test-only";
type LicenseStatus = "VERIFIED" | "UNVERIFIED";

type InstallManifest = {
  schemaVersion?: unknown;
  product?: unknown;
  productVersion?: unknown;
  releaseTag?: unknown;
  distributionMode?: unknown;
  licenseStatus?: unknown;
  licenseNote?: unknown;
  platforms?: unknown;
};

export type NpmRuntimePackageManifest = {
  schemaVersion: 1;
  product: "chengfeng-videocut";
  productVersion: string;
  platformKey: NpmRuntimePlatformKey;
  npmPackage: {
    name: string;
    version: string;
    os: [string];
    cpu: [string];
  };
  distributionMode: DistributionMode;
  licenseStatus: LicenseStatus;
  licenseNote: string;
  installer: {
    asset: string;
    path: string;
    sha256: string;
    size: number;
    executable: boolean;
  };
};

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALL_PLATFORM_KEYS = Object.keys(NPM_RUNTIME_TARGETS).sort();

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  check(actual.join("\0") === wanted.join("\0"), `${label} keys are not exact`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFile(path: string, label: string): Promise<{ bytes: Buffer; size: number; mode: number }> {
  const metadata = await lstat(path);
  check(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size > 0,
    `${label} must be a non-empty single-link regular file`,
  );
  const bytes = await readFile(path);
  check(bytes.length === metadata.size, `${label} changed while being read`);
  return { bytes, size: metadata.size, mode: metadata.mode };
}

function isPlatformKey(value: string): value is NpmRuntimePlatformKey {
  return Object.hasOwn(NPM_RUNTIME_TARGETS, value);
}

export function parseNpmRuntimeTargets(value: string | undefined): NpmRuntimePlatformKey[] {
  const raw = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? ALL_PLATFORM_KEYS;
  check(raw.length > 0, "No npm Runtime package targets were selected");
  const selected: NpmRuntimePlatformKey[] = [];
  for (const entry of raw) {
    check(isPlatformKey(entry), `Unsupported npm Runtime package target: ${entry}`);
    if (!selected.includes(entry)) selected.push(entry);
  }
  return selected;
}

function validateDistributionPair(
  distributionMode: unknown,
  licenseStatus: unknown,
  allowLocalFixture: boolean,
  label: string,
): asserts distributionMode is DistributionMode {
  const isRelease = distributionMode === "release-ready" && licenseStatus === "VERIFIED";
  const isFixture = distributionMode === "local-test-only" && licenseStatus === "UNVERIFIED";
  check(isRelease || (allowLocalFixture && isFixture),
    `${label} must be release-ready / VERIFIED${allowLocalFixture ? " or an explicit local-test-only / UNVERIFIED fixture" : ""}`);
}

function parseInstallManifest(
  value: InstallManifest,
  version: string,
  selected: readonly NpmRuntimePlatformKey[],
  allowLocalFixture: boolean,
): {
  distributionMode: DistributionMode;
  licenseStatus: LicenseStatus;
  licenseNote: string;
  platforms: Record<string, unknown>;
} {
  check(value.schemaVersion === 1 && value.product === "chengfeng-videocut", "Install manifest identity is invalid");
  check(value.productVersion === version && value.releaseTag === `v${version}`, "Install manifest version is not exact");
  validateDistributionPair(value.distributionMode, value.licenseStatus, allowLocalFixture, "Install manifest");
  check(typeof value.licenseNote === "string" && value.licenseNote.trim().length > 0,
    "Install manifest licenseNote is required");
  check(isRecord(value.platforms), "Install manifest platforms are invalid");
  const platformKeys = Object.keys(value.platforms).sort();
  if (value.distributionMode === "release-ready") {
    check(platformKeys.join("\0") === ALL_PLATFORM_KEYS.join("\0"),
      "Release-ready install manifest must cover exactly all supported platforms");
  } else {
    check(platformKeys.length === selected.length && selected.every((key) => platformKeys.includes(key)),
      "Local fixture install manifest must cover exactly the selected platforms");
  }
  return {
    distributionMode: value.distributionMode,
    licenseStatus: value.licenseStatus as LicenseStatus,
    licenseNote: value.licenseNote.trim(),
    platforms: value.platforms,
  };
}

function readInstallerRecord(
  platforms: Record<string, unknown>,
  platformKey: NpmRuntimePlatformKey,
): { asset: string; sha256: string; size: number } {
  const target = NPM_RUNTIME_TARGETS[platformKey];
  const platform = platforms[platformKey];
  check(isRecord(platform), `Install manifest is missing ${platformKey}`);
  check(platform.installerAsset === target.installerAsset, `${platformKey} installerAsset is not exact`);
  check(isRecord(platform.installer), `${platformKey} installer record is invalid`);
  exactKeys(platform.installer, ["asset", "sha256", "size"], `${platformKey} installer record`);
  check(platform.installer.asset === target.installerAsset, `${platformKey} installer record asset is not exact`);
  check(typeof platform.installer.sha256 === "string" && SHA256_PATTERN.test(platform.installer.sha256),
    `${platformKey} installer SHA256 is invalid`);
  check(Number.isSafeInteger(platform.installer.size) && Number(platform.installer.size) > 0,
    `${platformKey} installer size is invalid`);
  return {
    asset: target.installerAsset,
    sha256: platform.installer.sha256,
    size: Number(platform.installer.size),
  };
}

function packageJsonFor(
  manifest: NpmRuntimePackageManifest,
  localFixture: boolean,
): Record<string, unknown> {
  const files = [NPM_RUNTIME_PACKAGE_MANIFEST, manifest.installer.path];
  return {
    name: manifest.npmPackage.name,
    version: manifest.npmPackage.version,
    description: `Managed Chengfeng VideoCut Product Runtime payload for ${manifest.platformKey}`,
    license: "Apache-2.0",
    os: manifest.npmPackage.os,
    cpu: manifest.npmPackage.cpu,
    files,
    ...(localFixture ? { private: true } : { publishConfig: { access: "public" } }),
  };
}

async function verifyPackageJson(
  value: unknown,
  manifest: NpmRuntimePackageManifest,
  allowLocalFixture: boolean,
): Promise<void> {
  check(isRecord(value), "package.json must be an object");
  const localFixture = manifest.distributionMode === "local-test-only";
  const keys = ["name", "version", "description", "license", "os", "cpu", "files",
    localFixture ? "private" : "publishConfig"];
  exactKeys(value, keys, "package.json");
  check(!Object.hasOwn(value, "scripts") && !Object.hasOwn(value, "bin"),
    "npm Runtime package must not expose lifecycle scripts or bin");
  check(value.name === manifest.npmPackage.name && value.version === manifest.npmPackage.version,
    "package.json name/version does not match the package manifest");
  check(value.description === `Managed Chengfeng VideoCut Product Runtime payload for ${manifest.platformKey}`,
    "package.json description is not exact");
  check(value.license === "Apache-2.0", "package.json license is not exact");
  check(JSON.stringify(value.os) === JSON.stringify(manifest.npmPackage.os), "package.json os is not exact");
  check(JSON.stringify(value.cpu) === JSON.stringify(manifest.npmPackage.cpu), "package.json cpu is not exact");
  check(JSON.stringify(value.files) === JSON.stringify([NPM_RUNTIME_PACKAGE_MANIFEST, manifest.installer.path]),
    "package.json files allowlist is not exact");
  if (localFixture) {
    check(allowLocalFixture && value.private === true, "Local fixture npm package must stay private");
  } else {
    check(isRecord(value.publishConfig), "Release-ready package publishConfig is invalid");
    exactKeys(value.publishConfig, ["access"], "package.json publishConfig");
    check(value.publishConfig.access === "public", "package.json publishConfig access is not exact");
  }
}

function validatePackageManifest(
  value: unknown,
  allowLocalFixture: boolean,
): NpmRuntimePackageManifest {
  check(isRecord(value), "npm Runtime package manifest must be an object");
  exactKeys(value, [
    "schemaVersion", "product", "productVersion", "platformKey", "npmPackage",
    "distributionMode", "licenseStatus", "licenseNote", "installer",
  ], "npm Runtime package manifest");
  check(value.schemaVersion === 1 && value.product === "chengfeng-videocut", "npm Runtime package identity is invalid");
  check(typeof value.productVersion === "string" && VERSION_PATTERN.test(value.productVersion),
    "npm Runtime package productVersion is invalid");
  check(typeof value.platformKey === "string" && isPlatformKey(value.platformKey),
    "npm Runtime package platformKey is invalid");
  const platformKey = value.platformKey;
  const target = NPM_RUNTIME_TARGETS[platformKey];
  validateDistributionPair(value.distributionMode, value.licenseStatus, allowLocalFixture, "npm Runtime package manifest");
  check(typeof value.licenseNote === "string" && value.licenseNote.trim().length > 0,
    "npm Runtime package licenseNote is required");
  check(isRecord(value.npmPackage), "npmPackage metadata is invalid");
  exactKeys(value.npmPackage, ["name", "version", "os", "cpu"], "npmPackage metadata");
  check(value.npmPackage.name === target.packageName && value.npmPackage.version === value.productVersion,
    "npmPackage name/version is not exact");
  check(JSON.stringify(value.npmPackage.os) === JSON.stringify([target.os]), "npmPackage os is not exact");
  check(JSON.stringify(value.npmPackage.cpu) === JSON.stringify([target.cpu]), "npmPackage cpu is not exact");
  check(isRecord(value.installer), "installer record is invalid");
  exactKeys(value.installer, ["asset", "path", "sha256", "size", "executable"], "installer record");
  check(value.installer.asset === target.installerAsset, "installer asset is not exact");
  check(value.installer.path === `payload/${target.installerAsset}`, "installer path is not exact");
  check(typeof value.installer.sha256 === "string" && SHA256_PATTERN.test(value.installer.sha256),
    "installer SHA256 is invalid");
  check(Number.isSafeInteger(value.installer.size) && Number(value.installer.size) > 0,
    "installer size is invalid");
  check(value.installer.executable === target.executable, "installer executable contract is not exact");
  return value as unknown as NpmRuntimePackageManifest;
}

async function assertExactLayout(packageDir: string, manifest: NpmRuntimePackageManifest): Promise<void> {
  const expectedFiles = new Set(["package.json", NPM_RUNTIME_PACKAGE_MANIFEST, manifest.installer.path]);
  const expectedDirectories = new Set(["payload"]);
  const canonicalRoot = await realpath(packageDir);
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const name = (prefix ? `${prefix}/${entry.name}` : entry.name).replaceAll("\\", "/");
      const metadata = await lstat(absolute);
      check(!metadata.isSymbolicLink(), `npm Runtime package contains a symlink: ${name}`);
      if (metadata.isDirectory()) {
        check(expectedDirectories.has(name), `npm Runtime package contains an unexpected directory: ${name}`);
        const canonical = await realpath(absolute);
        const escaped = relative(canonicalRoot, canonical);
        check(escaped !== ".." && !escaped.startsWith("../") && !escaped.startsWith("..\\"),
          `npm Runtime package directory escaped its root: ${name}`);
        seenDirectories.add(name);
        await walk(absolute, name);
      } else {
        check(metadata.isFile() && metadata.nlink === 1,
          `npm Runtime package contains a hardlink/reparse/special entry: ${name}`);
        check(expectedFiles.has(name), `npm Runtime package contains an unexpected file: ${name}`);
        seenFiles.add(name);
      }
    }
  };
  await walk(packageDir);
  check(seenFiles.size === expectedFiles.size && [...expectedFiles].every((name) => seenFiles.has(name)),
    "npm Runtime package file allowlist is incomplete");
  check(seenDirectories.size === expectedDirectories.size && [...expectedDirectories].every((name) => seenDirectories.has(name)),
    "npm Runtime package directory allowlist is incomplete");
}

export async function verifyNpmRuntimePackage(options: {
  packageDir: string;
  allowLocalFixture?: boolean;
}): Promise<NpmRuntimePackageManifest> {
  const packageDir = resolve(options.packageDir);
  const rootMetadata = await lstat(packageDir);
  check(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "npm Runtime package root must be a regular directory");
  const manifestFile = await regularFile(join(packageDir, NPM_RUNTIME_PACKAGE_MANIFEST), "npm Runtime package manifest");
  const manifest = validatePackageManifest(JSON.parse(manifestFile.bytes.toString("utf8")), options.allowLocalFixture === true);
  await assertExactLayout(packageDir, manifest);
  const packageJsonFile = await regularFile(join(packageDir, "package.json"), "package.json");
  await verifyPackageJson(JSON.parse(packageJsonFile.bytes.toString("utf8")), manifest, options.allowLocalFixture === true);
  const installerFile = await regularFile(join(packageDir, manifest.installer.path), "embedded native installer");
  check(installerFile.size === manifest.installer.size && sha256(installerFile.bytes) === manifest.installer.sha256,
    "embedded native installer size/SHA256 does not match the package manifest");
  if (manifest.installer.executable) {
    check((installerFile.mode & 0o111) !== 0, "embedded native installer is not executable");
  }
  return manifest;
}

export async function stageNpmRuntimePackages(options: {
  rootDir: string;
  releaseDir: string;
  outputDir: string;
  platformKeys: readonly NpmRuntimePlatformKey[];
  allowLocalFixture?: boolean;
}): Promise<Array<{ platformKey: NpmRuntimePlatformKey; packageDir: string; manifest: NpmRuntimePackageManifest }>> {
  const rootDir = resolve(options.rootDir);
  const releaseDir = resolve(options.releaseDir);
  const outputDir = resolve(options.outputDir);
  const allowLocalFixture = options.allowLocalFixture === true;
  const product = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as { version?: unknown };
  check(typeof product.version === "string" && VERSION_PATTERN.test(product.version), "Product package version is invalid");
  const version = product.version;
  const selected = [...options.platformKeys];
  check(selected.length > 0 && selected.every((key) => isPlatformKey(key)), "npm Runtime package targets are invalid");
  check(new Set(selected).size === selected.length, "npm Runtime package targets contain duplicates");
  const installManifestFile = await regularFile(
    join(releaseDir, "chengfeng-videocut-install-manifest.json"),
    "Product Runtime install manifest",
  );
  const installManifest = parseInstallManifest(
    JSON.parse(installManifestFile.bytes.toString("utf8")),
    version,
    selected,
    allowLocalFixture,
  );
  if (!allowLocalFixture) {
    await verifyNativeReleaseInputs({ releaseDir, version });
  }
  try {
    await lstat(outputDir);
    throw new Error(`npm Runtime stage destination already exists: ${outputDir}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  await mkdir(dirname(outputDir), { recursive: true });
  const stagingRoot = await realpath(await mkdtemp(join(dirname(outputDir), ".npm-runtime-stage-")));
  const receipts: Array<{ platformKey: NpmRuntimePlatformKey; packageDir: string; manifest: NpmRuntimePackageManifest }> = [];
  try {
    for (const platformKey of selected) {
      const target = NPM_RUNTIME_TARGETS[platformKey];
      const installerRecord = readInstallerRecord(installManifest.platforms, platformKey);
      const sourceInstaller = await regularFile(join(releaseDir, installerRecord.asset), `${platformKey} native installer`);
      check(sourceInstaller.size === installerRecord.size && sha256(sourceInstaller.bytes) === installerRecord.sha256,
        `${platformKey} native installer size/SHA256 does not match the install manifest`);
      if (target.executable) check((sourceInstaller.mode & 0o111) !== 0, `${platformKey} native installer is not executable`);
      const packageDir = join(stagingRoot, platformKey);
      const payloadDir = join(packageDir, "payload");
      await mkdir(payloadDir, { recursive: true });
      const installerPath = `payload/${target.installerAsset}`;
      const destinationInstaller = join(packageDir, installerPath);
      await copyFile(join(releaseDir, installerRecord.asset), destinationInstaller);
      if (target.executable) await chmod(destinationInstaller, 0o755);
      const manifest: NpmRuntimePackageManifest = {
        schemaVersion: 1,
        product: "chengfeng-videocut",
        productVersion: version,
        platformKey,
        npmPackage: {
          name: target.packageName,
          version,
          os: [target.os],
          cpu: [target.cpu],
        },
        distributionMode: installManifest.distributionMode,
        licenseStatus: installManifest.licenseStatus,
        licenseNote: installManifest.licenseNote,
        installer: {
          asset: target.installerAsset,
          path: installerPath,
          sha256: installerRecord.sha256,
          size: installerRecord.size,
          executable: target.executable,
        },
      };
      await writeFile(join(packageDir, NPM_RUNTIME_PACKAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      await writeFile(join(packageDir, "package.json"), `${JSON.stringify(
        packageJsonFor(manifest, installManifest.distributionMode === "local-test-only"),
        null,
        2,
      )}\n`, { mode: 0o644 });
      await verifyNpmRuntimePackage({ packageDir, allowLocalFixture });
      receipts.push({ platformKey, packageDir: join(outputDir, platformKey), manifest });
    }
    await rename(stagingRoot, outputDir);
    return receipts;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}
