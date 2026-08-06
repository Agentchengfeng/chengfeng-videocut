import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};
// Source snapshots are a developer aid, not a Runtime Release attachment.  A
// Windows prerelease release/ directory is deliberately limited to the exact
// checksummed payload contract in release-assets.ts.
const sourceArchiveDir = join(root, "source-archives");
const folderName = `chengfeng-videocut-${pkg.version}`;
const archive = join(sourceArchiveDir, `${folderName}-source.tar.gz`);

await import("./release-check");
mkdirSync(sourceArchiveDir, { recursive: true });
const stageRoot = mkdtempSync(join(tmpdir(), "video-workbench-source-"));
const stageDir = join(stageRoot, folderName);
mkdirSync(stageDir, { recursive: true });

const excludedNames = new Set([
  ".git",
  ".workbench",
  "node_modules",
  "dist",
  // Electron resource preparation materializes the bundled Runtime, Bun, and
  // media executables here. It is a local build cache, never source material.
  "dist-resources",
  "release",
  "source-archives",
  "logs",
  ".thumbnails",
  ".DS_Store",
]);

cpSync(root, stageDir, {
  recursive: true,
  filter(source) {
    const name = basename(source);
    if (source !== root && excludedNames.has(name)) return false;
    const relativePath = source.slice(root.length + 1);
    if (/^docs\/[^/]+-architecture\.html$/.test(relativePath)) return false;
    if (relativePath.startsWith("apps/studio/data/projects/")) {
      return relativePath === "apps/studio/data/projects/.gitkeep";
    }
    if (relativePath.startsWith("apps/studio/data/renders")) return false;
    if (relativePath.startsWith("apps/studio/data/sessions")) return false;
    if (name.startsWith(".env")) return false;
    return true;
  },
});

if (existsSync(archive)) rmSync(archive);
const result = Bun.spawnSync(["tar", "-czf", archive, "-C", stageRoot, folderName], {
  stdout: "inherit",
  stderr: "inherit",
});
rmSync(stageRoot, { recursive: true, force: true });
if (result.exitCode !== 0) throw new Error("Failed to create source archive");

console.log(`Created developer source archive ${archive}`);
