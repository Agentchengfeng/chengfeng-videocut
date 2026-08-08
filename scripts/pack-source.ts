import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

// A source archive is a reproducible snapshot of committed public source, not
// an export of whatever happens to be in a developer's working directory.
// In particular, `cpSync(root)` used to pick up untracked renderer experiments,
// local test media and `.env` files. Git's tracked file list is the allowlist.
const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
if (tracked.exitCode !== 0) {
  throw new Error(`Unable to list tracked source files: ${tracked.stderr.toString().trim()}`);
}
for (const relativePath of tracked.stdout.toString().split("\0")) {
  if (!relativePath) continue;
  const source = join(root, relativePath);
  const target = join(stageDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: true, verbatimSymlinks: true });
}

if (existsSync(archive)) rmSync(archive);
const result = Bun.spawnSync(["tar", "-czf", archive, "-C", stageRoot, folderName], {
  stdout: "inherit",
  stderr: "inherit",
});
rmSync(stageRoot, { recursive: true, force: true });
if (result.exitCode !== 0) throw new Error("Failed to create source archive");

console.log(`Created developer source archive ${archive}`);
