import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function windowsDesktopInstallerName(version: string): string {
  return `Chengfeng-VideoCut-${version}-win-x64.exe`;
}

export function requiredReleaseAssetNames(version: string): string[] {
  return [
    "install.sh",
    "install.cjs",
    `chengfeng-videocut-${version}-portable.tar.gz`,
    "chengfeng-videocut-portable.tar.gz",
    `chengfeng-videocut-${version}.tgz`,
    "chengfeng-videocut.tgz",
    windowsDesktopInstallerName(version),
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
  if (missingNames.length > 0) {
    throw new Error(`Release is missing required assets: ${missingNames.join(", ")}`);
  }

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
  if (unchecked.length > 0) {
    throw new Error(`SHA256SUMS does not cover required assets: ${unchecked.join(", ")}`);
  }
  if (checksums.size !== assetNames.length) {
    throw new Error("SHA256SUMS contains an unexpected number of assets");
  }

  for (const name of assetNames) {
    const actual = sha256(await readFile(join(releaseDir, name)));
    if (actual !== checksums.get(name)) throw new Error(`SHA256 mismatch for ${name}`);
  }

  for (const [versioned, stable] of [
    [`chengfeng-videocut-${version}-portable.tar.gz`, "chengfeng-videocut-portable.tar.gz"],
    [`chengfeng-videocut-${version}.tgz`, "chengfeng-videocut.tgz"],
  ]) {
    if (checksums.get(versioned) !== checksums.get(stable)) {
      throw new Error(`${versioned} and ${stable} do not have identical content`);
    }
  }
  return { assetNames, checksums };
}

export async function writeReleaseChecksums(options: {
  rootDir: string;
  releaseDir: string;
  version: string;
}): Promise<{ checksumPath: string; lines: string[] }> {
  const { rootDir, releaseDir, version } = options;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }

  await mkdir(releaseDir, { recursive: true });
  await copyFile(join(rootDir, "install.sh"), join(releaseDir, "install.sh"));
  await copyFile(join(rootDir, "install.cjs"), join(releaseDir, "install.cjs"));

  const requiredNames = requiredReleaseAssetNames(version);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const allowedNames = new Set([...requiredNames, "SHA256SUMS.txt"]);
  const unexpectedEntries = entries
    .filter((entry) => !entry.isFile() || !allowedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `Windows prerelease release directory contains unsupported assets: ${unexpectedEntries.join(", ")}`,
    );
  }
  const availableNames = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const missingNames = requiredNames.filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) {
    throw new Error(
      `Missing chengfeng-videocut ${version} release assets: ${missingNames.join(", ")}`,
    );
  }

  const artifactNames = [...requiredNames].sort((left, right) => left.localeCompare(right, "en"));
  const lines: string[] = [];
  for (const name of artifactNames) {
    const bytes = await readFile(join(releaseDir, name));
    const hash = sha256(bytes);
    lines.push(`${hash}  ${name}`);
  }

  const checksumPath = join(releaseDir, "SHA256SUMS.txt");
  await writeFile(checksumPath, `${lines.join("\n")}\n`);
  return { checksumPath, lines };
}
