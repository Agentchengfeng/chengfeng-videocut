import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const EMBEDDED_PAYLOAD_MANIFEST_NAME =
  "chengfeng-videocut-installer-payload-manifest.json";
export const EMBEDDED_PAYLOAD_CHECKSUM_NAME =
  "chengfeng-videocut-installer-payload-SHA256SUMS.txt";

export const NATIVE_INSTALLER_TARGETS = {
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    installerAsset: "chengfeng-videocut-installer-macos-arm64",
  },
  "darwin-x64": {
    bunTarget: "bun-darwin-x64",
    installerAsset: "chengfeng-videocut-installer-macos-x64",
  },
  "win32-x64": {
    bunTarget: "bun-windows-x64",
    installerAsset: "chengfeng-videocut-installer-windows-x64.exe",
  },
} as const;

export type NativeInstallerPlatformKey = keyof typeof NATIVE_INSTALLER_TARGETS;

type ProductPackage = { version: string };
type ManagedToolsLock = {
  product: string;
  productVersion: string;
  licenseStatus: "VERIFIED" | "UNVERIFIED";
  licenseNote: string;
};
type ToolsSidecar = {
  platformKey?: unknown;
  asset?: unknown;
  root?: unknown;
  sha256?: unknown;
  size?: unknown;
  distributionMode?: unknown;
  licenseStatus?: unknown;
};

export interface PayloadAssetRecord {
  asset: string;
  root: string;
  sha256: string;
  size: number;
}

export interface InstallerPayloadManifest {
  schemaVersion: 1;
  product: "chengfeng-videocut";
  productVersion: string;
  releaseTag: string;
  distributionMode: "release-ready" | "local-test-only";
  licenseStatus: "VERIFIED" | "UNVERIFIED";
  licenseNote: string;
  runtime: PayloadAssetRecord;
  platforms: Partial<Record<NativeInstallerPlatformKey, { tools: PayloadAssetRecord }>>;
}

export interface WrittenInstallerPayload {
  platformKey: NativeInstallerPlatformKey;
  directory: string;
  manifestPath: string;
  checksumPath: string;
  runtimePath: string;
  toolsPath: string;
  manifest: InstallerPayloadManifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFileRecord(path: string, label: string): Promise<{ sha256: string; size: number }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size <= 0) {
    throw new Error(`${label} must be a non-empty single-link regular file: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error(`${label} changed while it was being hashed: ${path}`);
  return { sha256: sha256(bytes), size: metadata.size };
}

function isPlatformKey(value: string): value is NativeInstallerPlatformKey {
  return Object.hasOwn(NATIVE_INSTALLER_TARGETS, value);
}

export function parseNativeInstallerTargets(value: string | undefined): NativeInstallerPlatformKey[] {
  const raw = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ??
    Object.keys(NATIVE_INSTALLER_TARGETS);
  if (raw.length === 0) throw new Error("No native installer targets were selected");
  const selected: NativeInstallerPlatformKey[] = [];
  for (const entry of raw) {
    if (!isPlatformKey(entry)) throw new Error(`Unsupported installer target: ${entry}`);
    if (!selected.includes(entry)) selected.push(entry);
  }
  return selected;
}

function expectedToolsAsset(version: string, platformKey: NativeInstallerPlatformKey): string {
  return `chengfeng-videocut-tools-${version}-${platformKey}.tar.gz`;
}

function assertToolsSidecar(
  sidecar: ToolsSidecar,
  platformKey: NativeInstallerPlatformKey,
  asset: string,
  observed: { sha256: string; size: number },
): { distributionMode: "release-ready" | "local-test-only"; licenseStatus: "VERIFIED" | "UNVERIFIED" } {
  const expectedRoot = asset.slice(0, -".tar.gz".length);
  if (
    sidecar.platformKey !== platformKey || sidecar.asset !== asset || sidecar.root !== expectedRoot ||
    sidecar.sha256 !== observed.sha256 || sidecar.size !== observed.size
  ) {
    throw new Error(`${platformKey} managed tools sidecar does not match its exact archive`);
  }
  if (sidecar.distributionMode !== "release-ready" && sidecar.distributionMode !== "local-test-only") {
    throw new Error(`${platformKey} managed tools sidecar distributionMode is invalid`);
  }
  if (sidecar.licenseStatus !== "VERIFIED" && sidecar.licenseStatus !== "UNVERIFIED") {
    throw new Error(`${platformKey} managed tools sidecar licenseStatus is invalid`);
  }
  return {
    distributionMode: sidecar.distributionMode,
    licenseStatus: sidecar.licenseStatus,
  };
}

export async function writeInstallerPayloadManifests(options: {
  rootDir: string;
  releaseDir: string;
  outputDir: string;
  platformKeys: readonly NativeInstallerPlatformKey[];
  managedToolsLockPath?: string;
}): Promise<WrittenInstallerPayload[]> {
  const rootDir = resolve(options.rootDir);
  const releaseDir = resolve(options.releaseDir);
  const outputDir = resolve(options.outputDir);
  const product = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as ProductPackage;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(product.version)) {
    throw new Error(`Invalid package version: ${String(product.version)}`);
  }
  const lockPath = resolve(options.managedToolsLockPath ?? join(rootDir, "installer/managed-tools.lock.json"));
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as ManagedToolsLock;
  if (
    lock.product !== "chengfeng-videocut" || lock.productVersion !== product.version ||
    (lock.licenseStatus !== "VERIFIED" && lock.licenseStatus !== "UNVERIFIED") ||
    typeof lock.licenseNote !== "string" || !lock.licenseNote.trim()
  ) {
    throw new Error("managed-tools.lock.json is not an exact Product license contract");
  }

  const runtimeAsset = `chengfeng-videocut-runtime-${product.version}.tar.gz`;
  const runtimePath = join(releaseDir, runtimeAsset);
  const runtime = {
    asset: runtimeAsset,
    root: `chengfeng-videocut-${product.version}`,
    ...await regularFileRecord(runtimePath, "Runtime archive"),
  };

  const written: WrittenInstallerPayload[] = [];
  for (const platformKey of options.platformKeys) {
    if (!isPlatformKey(platformKey)) throw new Error(`Unsupported installer target: ${platformKey}`);
    const toolsAsset = expectedToolsAsset(product.version, platformKey);
    const toolsPath = join(releaseDir, toolsAsset);
    const toolsObserved = await regularFileRecord(toolsPath, `${platformKey} managed tools archive`);
    const sidecar = JSON.parse(await readFile(`${toolsPath}.json`, "utf8")) as ToolsSidecar;
    const sidecarStatus = assertToolsSidecar(sidecar, platformKey, toolsAsset, toolsObserved);
    const releaseReady =
      lock.licenseStatus === "VERIFIED" &&
      sidecarStatus.licenseStatus === "VERIFIED" &&
      sidecarStatus.distributionMode === "release-ready";
    const manifest: InstallerPayloadManifest = {
      schemaVersion: 1,
      product: "chengfeng-videocut",
      productVersion: product.version,
      releaseTag: `v${product.version}`,
      distributionMode: releaseReady ? "release-ready" : "local-test-only",
      licenseStatus: releaseReady ? "VERIFIED" : "UNVERIFIED",
      licenseNote: lock.licenseNote,
      runtime,
      platforms: {
        [platformKey]: {
          tools: {
            asset: toolsAsset,
            root: toolsAsset.slice(0, -".tar.gz".length),
            ...toolsObserved,
          },
        },
      },
    };
    const directory = join(outputDir, platformKey);
    await mkdir(directory, { recursive: true });
    const manifestPath = join(directory, EMBEDDED_PAYLOAD_MANIFEST_NAME);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    const checksumPath = join(directory, EMBEDDED_PAYLOAD_CHECKSUM_NAME);
    const checksumLines = [
      `${sha256(manifestBytes)}  ${EMBEDDED_PAYLOAD_MANIFEST_NAME}`,
      `${runtime.sha256}  ${runtime.asset}`,
      `${toolsObserved.sha256}  ${toolsAsset}`,
    ];
    await writeFile(checksumPath, `${checksumLines.join("\n")}\n`, { mode: 0o600 });
    written.push({
      platformKey,
      directory,
      manifestPath,
      checksumPath,
      runtimePath,
      toolsPath,
      manifest,
    });
  }
  return written;
}

if (import.meta.main) {
  const rootDir = resolve(import.meta.dir, "..");
  const releaseDir = resolve(process.env.CHENGFENG_VIDEOCUT_RELEASE_DIR ?? join(rootDir, "release"));
  const outputDirectory = process.env.CHENGFENG_VIDEOCUT_INSTALLER_PAYLOAD_DIR;
  if (!outputDirectory) {
    throw new Error(
      "CHENGFENG_VIDEOCUT_INSTALLER_PAYLOAD_DIR is required; inner payload receipts must not be left in release/.",
    );
  }
  const outputDir = resolve(outputDirectory);
  const payloads = await writeInstallerPayloadManifests({
    rootDir,
    releaseDir,
    outputDir,
    platformKeys: parseNativeInstallerTargets(process.env.CHENGFENG_VIDEOCUT_INSTALLER_TARGETS),
    managedToolsLockPath: process.env.CHENGFENG_VIDEOCUT_MANAGED_TOOLS_LOCK,
  });
  for (const payload of payloads) {
    console.log(JSON.stringify({
      platformKey: payload.platformKey,
      manifestPath: payload.manifestPath,
      checksumPath: payload.checksumPath,
      runtimePath: payload.runtimePath,
      toolsPath: payload.toolsPath,
      distributionMode: payload.manifest.distributionMode,
      licenseStatus: payload.manifest.licenseStatus,
    }));
  }
}
