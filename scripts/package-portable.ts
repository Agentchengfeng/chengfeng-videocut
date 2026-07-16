import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const cliDistDir = join(rootDir, "apps/cli/dist");
const releaseDir = join(rootDir, "release");
const stageDir = join(releaseDir, ".portable-stage");

const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version?: string;
};
const version = packageJson.version;

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${String(version)}`);
}

const bundleName = `chengfeng-videocut-${version}`;
const bundleDir = join(stageDir, bundleName);
const versionedArchive = join(releaseDir, `${bundleName}-portable.tar.gz`);
const stableArchive = join(releaseDir, "chengfeng-videocut-portable.tar.gz");

async function requirePath(path: string, label: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new Error(`${label} is missing at ${path}. Run \`bun run package:build\` first.`);
  }
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${code}`);
  }
}

const launcher = `#!/bin/sh
set -eu

SELF=$0
while [ -L "$SELF" ]; do
  LINK_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
  LINK_TARGET=$(readlink "$SELF")
  case "$LINK_TARGET" in
    /*) SELF=$LINK_TARGET ;;
    *) SELF=$LINK_DIR/$LINK_TARGET ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  if [ -n "\${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\\n' "$HOME/.bun/bin/bun"
    return 0
  fi

  for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s\\n' "$candidate"
      return 0
    fi
  done

  return 1
}

if ! BUN_EXECUTABLE=$(find_bun); then
  printf '%s\\n' 'chengfeng-videocut 需要 Bun 1.2 或更高版本。' >&2
  printf '%s\\n' '安装说明：https://bun.sh/docs/installation' >&2
  exit 127
fi

exec "$BUN_EXECUTABLE" "$SCRIPT_DIR/cli.js" "$@"
`;

const startCommand = `#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/chengfeng-videocut" start --open "$@"
`;

await requirePath(join(cliDistDir, "cli.js"), "Bundled CLI");
await requirePath(join(cliDistDir, "studio/index.html"), "Studio bundle");
await requirePath(join(cliDistDir, "legal/LICENSE"), "Legal files");

await mkdir(releaseDir, { recursive: true });
await rm(stageDir, { recursive: true, force: true });

try {
  await mkdir(bundleDir, { recursive: true });
  await copyFile(join(cliDistDir, "cli.js"), join(bundleDir, "cli.js"));
  await cp(join(cliDistDir, "studio"), join(bundleDir, "studio"), {
    recursive: true,
    force: true,
  });
  await cp(join(cliDistDir, "legal"), join(bundleDir, "legal"), {
    recursive: true,
    force: true,
  });
  await copyFile(join(rootDir, "README.md"), join(bundleDir, "README.md"));
  await writeFile(join(bundleDir, "VERSION"), `${version}\n`);
  await writeFile(join(bundleDir, "chengfeng-videocut"), launcher);
  await writeFile(join(bundleDir, "start.command"), startCommand);
  await chmod(join(bundleDir, "cli.js"), 0o755);
  await chmod(join(bundleDir, "chengfeng-videocut"), 0o755);
  await chmod(join(bundleDir, "start.command"), 0o755);

  await rm(versionedArchive, { force: true });
  await rm(stableArchive, { force: true });
  await run(["tar", "-czf", versionedArchive, "-C", stageDir, bundleName], rootDir);
  await copyFile(versionedArchive, stableArchive);
} finally {
  await rm(stageDir, { recursive: true, force: true });
}

console.log(`Created ${versionedArchive}`);
console.log(`Created ${stableArchive}`);
