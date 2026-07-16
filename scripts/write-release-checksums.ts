import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const checksumPath = join(releaseDir, "SHA256SUMS.txt");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};
const version = packageJson.version;
const releaseAssets = new Set([
  `chengfeng-videocut-${version}-portable.tar.gz`,
  "chengfeng-videocut-portable.tar.gz",
  `chengfeng-videocut-${version}.tgz`,
  "chengfeng-videocut.tgz",
  `chengfeng-videocut-${version}-source.tar.gz`,
]);

const entries = await readdir(releaseDir, { withFileTypes: true });
const artifactNames = entries
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name !== "SHA256SUMS.txt" &&
      releaseAssets.has(entry.name),
  )
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"));

if (artifactNames.length === 0) {
  throw new Error(`No chengfeng-videocut ${version} release assets found in ${releaseDir}`);
}

const lines: string[] = [];
for (const name of artifactNames) {
  const bytes = await Bun.file(join(releaseDir, name)).arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  lines.push(`${hash}  ${name}`);
}

await writeFile(checksumPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${checksumPath}`);
for (const line of lines) console.log(line);
