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
  const optionalNames = [`chengfeng-videocut-${version}-source.tar.gz`];
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const availableNames = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const missingNames = requiredNames.filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) {
    throw new Error(
      `Missing chengfeng-videocut ${version} release assets: ${missingNames.join(", ")}`,
    );
  }

  const artifactNames = [
    ...requiredNames,
    ...optionalNames.filter((name) => availableNames.has(name)),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const lines: string[] = [];
  for (const name of artifactNames) {
    const bytes = await readFile(join(releaseDir, name));
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    lines.push(`${hash}  ${name}`);
  }

  const checksumPath = join(releaseDir, "SHA256SUMS.txt");
  await writeFile(checksumPath, `${lines.join("\n")}\n`);
  return { checksumPath, lines };
}
