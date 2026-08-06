import { chmod, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};

const targets = {
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    asset: "chengfeng-videocut-installer-macos-arm64",
  },
  "darwin-x64": {
    bunTarget: "bun-darwin-x64",
    asset: "chengfeng-videocut-installer-macos-x64",
  },
  "win32-x64": {
    bunTarget: "bun-windows-x64",
    asset: "chengfeng-videocut-installer-windows-x64.exe",
  },
} as const;

const selected = (process.env.CHENGFENG_VIDEOCUT_INSTALLER_TARGETS
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean) ?? Object.keys(targets)) as Array<keyof typeof targets>;

await mkdir(releaseDir, { recursive: true });
for (const platformKey of selected) {
  const target = targets[platformKey];
  if (!target) throw new Error(`Unsupported installer target: ${platformKey}`);
  const output = join(releaseDir, target.asset);
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      "--define",
      `CHENGFENG_COMPILED_INSTALLER_VERSION=${JSON.stringify(packageJson.version)}`,
      join(rootDir, "install.cjs"),
      `--outfile=${output}`,
    ],
    { cwd: rootDir, stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  if (code !== 0) throw new Error(`bun build ${platformKey} exited with ${code}`);
  if (platformKey !== "win32-x64") await chmod(output, 0o755);
  console.log(`Created ${output}`);
}
