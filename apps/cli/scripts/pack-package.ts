import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliDir = resolve(import.meta.dir, "..");
const rootDir = resolve(cliDir, "../..");
const releaseDir = resolve(rootDir, "release");

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}

await run(["bun", "run", "build"], cliDir);
await run(["bun", "run", "package:check"], cliDir);
await mkdir(releaseDir, { recursive: true });
const npmCacheDir = await mkdtemp(join(tmpdir(), "chengfeng-videocut-npm-pack-"));
try {
  await run(
    ["npm", "pack", cliDir, "--pack-destination", releaseDir, "--cache", npmCacheDir],
    rootDir,
  );
} finally {
  await rm(npmCacheDir, { recursive: true, force: true });
}
const packageJson = JSON.parse(await readFile(resolve(cliDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
await copyFile(
  resolve(releaseDir, `${packageJson.name}-${packageJson.version}.tgz`),
  resolve(releaseDir, `${packageJson.name}.tgz`),
);
