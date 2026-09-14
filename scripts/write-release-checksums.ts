import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseProfileFromArgs, writeReleaseChecksums } from "./release-assets";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};
const version = packageJson.version;
const profile = releaseProfileFromArgs(process.argv.slice(2));
const { checksumPath, lines } = await writeReleaseChecksums({ rootDir, releaseDir, version, profile });
console.log(`Wrote ${checksumPath}`);
for (const line of lines) console.log(line);
