import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeReleaseChecksums } from "./release-assets";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};
const version = packageJson.version;
const { checksumPath, lines } = await writeReleaseChecksums({ rootDir, releaseDir, version });
console.log(`Wrote ${checksumPath}`);
for (const line of lines) console.log(line);
