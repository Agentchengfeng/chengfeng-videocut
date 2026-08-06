import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = resolve(process.env.CHENGFENG_VIDEOCUT_RELEASE_DIR ?? join(rootDir, "release"));
const { version } = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};
const toolsLock = JSON.parse(
  await readFile(
    resolve(
      process.env.CHENGFENG_VIDEOCUT_MANAGED_TOOLS_LOCK ??
      join(rootDir, "installer/managed-tools.lock.json"),
    ),
    "utf8",
  ),
) as { licenseStatus: "VERIFIED" | "UNVERIFIED"; licenseNote: string };
const runtimeAsset = `chengfeng-videocut-runtime-${version}.tar.gz`;
const runtimeRoot = `chengfeng-videocut-${version}`;
const platformAssets = {
  "darwin-arm64": {
    installerAsset: "chengfeng-videocut-installer-macos-arm64",
    toolsAsset: `chengfeng-videocut-tools-${version}-darwin-arm64.tar.gz`,
  },
  "darwin-x64": {
    installerAsset: "chengfeng-videocut-installer-macos-x64",
    toolsAsset: `chengfeng-videocut-tools-${version}-darwin-x64.tar.gz`,
  },
  "win32-x64": {
    installerAsset: "chengfeng-videocut-installer-windows-x64.exe",
    toolsAsset: `chengfeng-videocut-tools-${version}-win32-x64.tar.gz`,
  },
} as const;
const allowPartial = process.env.CHENGFENG_VIDEOCUT_ALLOW_PARTIAL_MANIFEST === "1";
const allowLocalFixture = process.env.CHENGFENG_VIDEOCUT_ALLOW_LOCAL_TOOLS_FIXTURE === "1";
const selectedLicenseStatuses: string[] = [];

async function exists(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isFile()).catch(() => false);
}
async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

if (!await exists(join(releaseDir, runtimeAsset))) {
  throw new Error(`Missing Runtime asset: ${runtimeAsset}`);
}
const platforms: Record<string, unknown> = {};
for (const [platformKey, names] of Object.entries(platformAssets)) {
  const installerPath = join(releaseDir, names.installerAsset);
  const toolsPath = join(releaseDir, names.toolsAsset);
  if (!await exists(installerPath) || !await exists(toolsPath)) {
    if (allowPartial) continue;
    throw new Error(`Missing ${platformKey} installer/tools assets`);
  }
  const sidecar = JSON.parse(
    await readFile(`${toolsPath}.json`, "utf8"),
  ) as { distributionMode?: string; licenseStatus?: string; sha256?: string; size?: number };
  if (sidecar.sha256 !== await sha256(toolsPath)) {
    throw new Error(`${platformKey} tools sidecar digest does not match the asset`);
  }
  const toolsSize = (await stat(toolsPath)).size;
  if (sidecar.size !== toolsSize) {
    throw new Error(`${platformKey} tools sidecar size does not match the asset`);
  }
  if (sidecar.distributionMode !== "release-ready" && !allowLocalFixture) {
    throw new Error(`${platformKey} tools are local-test-only; public manifest generation is blocked`);
  }
  if (sidecar.licenseStatus !== "VERIFIED" && !allowLocalFixture) {
    throw new Error(`${platformKey} tools license status is not VERIFIED`);
  }
  selectedLicenseStatuses.push(sidecar.licenseStatus ?? "UNVERIFIED");
  platforms[platformKey] = {
    installerAsset: names.installerAsset,
    tools: {
      asset: names.toolsAsset,
      root: names.toolsAsset.slice(0, -".tar.gz".length),
      sha256: await sha256(toolsPath),
      size: toolsSize,
    },
  };
}
if (Object.keys(platforms).length === 0) throw new Error("No complete platform assets were found");
const manifestLicenseStatus =
  !allowLocalFixture &&
  toolsLock.licenseStatus === "VERIFIED" &&
  selectedLicenseStatuses.every((status) => status === "VERIFIED")
    ? "VERIFIED"
    : "UNVERIFIED";
const runtimePath = join(releaseDir, runtimeAsset);

const manifest = {
  schemaVersion: 1,
  product: "chengfeng-videocut",
  productVersion: version,
  releaseTag: `v${version}`,
  runtime: {
    asset: runtimeAsset,
    root: runtimeRoot,
    sha256: await sha256(runtimePath),
    size: (await stat(runtimePath)).size,
  },
  platforms,
  licenseStatus: manifestLicenseStatus,
  licenseNote: toolsLock.licenseNote,
};
const output = join(releaseDir, "chengfeng-videocut-install-manifest.json");
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${output}`);
