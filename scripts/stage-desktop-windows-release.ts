import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { windowsDesktopInstallerName } from "./release-assets";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version?: string;
};
const version = packageJson.version;

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${String(version)}`);
}

const installerName = windowsDesktopInstallerName(version);
const source = join(rootDir, "apps", "desktop", "release", installerName);
try {
  const metadata = await stat(source);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`${source} is not a non-empty file`);
  }
} catch (error) {
  throw new Error(
    `Verified Windows desktop installer is missing at ${source}. Run the Windows NSIS build and smoke before staging release assets. ${String(error)}`,
  );
}

await mkdir(releaseDir, { recursive: true });
await copyFile(source, join(releaseDir, installerName));
console.log(`Staged ${installerName} from the verified Windows desktop build`);
