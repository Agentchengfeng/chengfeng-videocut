import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { requiredReleaseAssetNames, writeReleaseChecksums } from "./release-assets";

const rootDir = resolve(import.meta.dir, "..");
const sourceDir = resolve(process.env.CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE ?? join(rootDir, "release"));
const destinationDir = resolve(
  process.env.CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR ?? join(rootDir, "release-native"),
);
const defaultDestination = join(rootDir, "release-native");
const { version } = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};

const sourceMetadata = await lstat(sourceDir);
if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
  throw new Error("Native asset source must be a non-symlink directory");
}
const canonicalSource = await realpath(sourceDir);
const home = resolve(homedir());
for (const forbidden of [parse(destinationDir).root, home, rootDir]) {
  if (
    forbidden && (
      destinationDir === forbidden ||
      forbidden.startsWith(`${destinationDir}${sep}`)
    )
  ) throw new Error(`Refusing broad native release destination: ${destinationDir}`);
}
const destinationMetadata = await lstat(destinationDir).catch(() => null);
let canonicalDestination: string;
if (destinationMetadata) {
  if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) {
    throw new Error("Native release destination must be a non-symlink directory");
  }
  const entries = await readdir(destinationDir);
  if (destinationDir !== defaultDestination && entries.length > 0) {
    throw new Error("Custom native release destination must be empty");
  }
  canonicalDestination = await realpath(destinationDir);
} else {
  const canonicalParent = await realpath(dirname(destinationDir));
  canonicalDestination = join(canonicalParent, basename(destinationDir));
}
if (
  canonicalSource === canonicalDestination ||
  canonicalSource.startsWith(`${canonicalDestination}${sep}`) ||
  canonicalDestination.startsWith(`${canonicalSource}${sep}`)
) throw new Error("Native release source and destination must be disjoint");

const requiredAssets = requiredReleaseAssetNames(version);
for (const name of requiredAssets) {
  const sourceAsset = join(sourceDir, name);
  const metadata = await lstat(sourceAsset);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Native release asset must be a single-link regular file: ${name}`);
  }
}

await rm(destinationDir, { recursive: true, force: true });
await mkdir(destinationDir, { recursive: true });
for (const name of requiredAssets) {
  await copyFile(join(sourceDir, name), join(destinationDir, name));
}
const result = await writeReleaseChecksums({ rootDir, releaseDir: destinationDir, version });
console.log(`Staged ${result.lines.length} assets and ${result.checksumPath}`);
