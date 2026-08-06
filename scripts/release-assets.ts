import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function windowsDesktopInstallerName(version: string): string {
  return `Chengfeng-VideoCut-${version}-win-x64.exe`;
}

export function nativeInstallerAssetNames(): string[] {
  return [
    "chengfeng-videocut-installer-macos-arm64",
    "chengfeng-videocut-installer-macos-x64",
    "chengfeng-videocut-installer-windows-x64.exe",
  ];
}

export function requiredReleaseAssetNames(version: string): string[] {
  return [
    "chengfeng-videocut-install-manifest.json",
    `chengfeng-videocut-runtime-${version}.tar.gz`,
    ...nativeInstallerAssetNames(),
    `chengfeng-videocut-tools-${version}-darwin-arm64.tar.gz`,
    `chengfeng-videocut-tools-${version}-darwin-x64.tar.gz`,
    `chengfeng-videocut-tools-${version}-win32-x64.tar.gz`,
  ];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyReleaseAssetManifest(options: {
  releaseDir: string;
  version: string;
}): Promise<{ assetNames: string[]; checksums: Map<string, string> }> {
  const { releaseDir, version } = options;
  const assetNames = requiredReleaseAssetNames(version).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const allowedNames = new Set([...assetNames, "SHA256SUMS.txt"]);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const unexpectedEntries = entries
    .filter((entry) => !entry.isFile() || !allowedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unexpectedEntries.length > 0) {
    throw new Error(`Release contains unexpected assets: ${unexpectedEntries.join(", ")}`);
  }
  const availableNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const missingNames = [...allowedNames].filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) throw new Error(`Release is missing required assets: ${missingNames.join(", ")}`);

  const checksumContent = await readFile(join(releaseDir, "SHA256SUMS.txt"), "utf8");
  const checksums = new Map<string, string>();
  for (const line of checksumContent.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, hash, name] = match;
    if (!assetNames.includes(name)) throw new Error(`SHA256SUMS names unknown asset: ${name}`);
    if (checksums.has(name)) throw new Error(`SHA256SUMS repeats asset: ${name}`);
    checksums.set(name, hash.toLowerCase());
  }
  const unchecked = assetNames.filter((name) => !checksums.has(name));
  if (unchecked.length > 0) throw new Error(`SHA256SUMS does not cover required assets: ${unchecked.join(", ")}`);
  for (const name of assetNames) {
    const actual = sha256(await readFile(join(releaseDir, name)));
    if (actual !== checksums.get(name)) throw new Error(`SHA256 mismatch for ${name}`);
  }
  return { assetNames, checksums };
}

export async function writeReleaseChecksums(options: {
  rootDir: string;
  releaseDir: string;
  version: string;
}): Promise<{ checksumPath: string; lines: string[] }> {
  const { releaseDir, version } = options;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }
  await mkdir(releaseDir, { recursive: true });
  const requiredNames = requiredReleaseAssetNames(version);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const allowedNames = new Set([...requiredNames, "SHA256SUMS.txt"]);
  const unexpectedEntries = entries
    .filter((entry) => !entry.isFile() || !allowedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unexpectedEntries.length > 0) {
    throw new Error(`Release directory contains unsupported assets: ${unexpectedEntries.join(", ")}`);
  }
  const availableNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const missingNames = requiredNames.filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) {
    throw new Error(`Missing chengfeng-videocut ${version} release assets: ${missingNames.join(", ")}`);
  }
  const lines: string[] = [];
  for (const name of [...requiredNames].sort((left, right) => left.localeCompare(right, "en"))) {
    lines.push(`${sha256(await readFile(join(releaseDir, name)))}  ${name}`);
  }
  const checksumPath = join(releaseDir, "SHA256SUMS.txt");
  await writeFile(checksumPath, `${lines.join("\n")}\n`);
  return { checksumPath, lines };
}
