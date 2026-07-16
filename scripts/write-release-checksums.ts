import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const checksumPath = join(releaseDir, "SHA256SUMS.txt");
const productPrefixes = ["chengfeng-VideoCut", "chengfeng-videocut"];

const entries = await readdir(releaseDir, { withFileTypes: true });
const artifactNames = entries
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name !== "SHA256SUMS.txt" &&
      productPrefixes.some((prefix) => entry.name.startsWith(prefix)),
  )
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"));

if (artifactNames.length === 0) {
  throw new Error(`No chengfeng-VideoCut release assets found in ${releaseDir}`);
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
