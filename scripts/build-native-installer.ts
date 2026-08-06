import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  NATIVE_INSTALLER_TARGETS,
  parseNativeInstallerTargets,
  type NativeInstallerPlatformKey,
  writeInstallerPayloadManifests,
} from "./write-installer-payload-manifest";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = resolve(process.env.CHENGFENG_VIDEOCUT_RELEASE_DIR ?? join(rootDir, "release"));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};

const selected = parseNativeInstallerTargets(process.env.CHENGFENG_VIDEOCUT_INSTALLER_TARGETS);

function importSpecifier(from: string, to: string): string {
  const value = relative(dirname(from), to).replaceAll("\\", "/");
  return value.startsWith(".") ? value : `./${value}`;
}

function wrapperSource(input: {
  wrapperPath: string;
  platformKey: NativeInstallerPlatformKey;
  manifestPath: string;
  checksumPath: string;
  runtimePath: string;
  toolsPath: string;
}): string {
  const specifier = (path: string) => JSON.stringify(importSpecifier(input.wrapperPath, path));
  return `import * as installerModule from ${specifier(join(rootDir, "install.cjs"))};
import manifestPath from ${specifier(input.manifestPath)} with { type: "file" };
import checksumPath from ${specifier(input.checksumPath)} with { type: "file" };
import runtimePath from ${specifier(input.runtimePath)} with { type: "file" };
import toolsPath from ${specifier(input.toolsPath)} with { type: "file" };

const installer = installerModule.default ?? installerModule;
globalThis.__CHENGFENG_VIDEOCUT_EMBEDDED_PAYLOAD__ = Object.freeze({
  schemaVersion: 1,
  platformKey: ${JSON.stringify(input.platformKey)},
  manifestPath,
  checksumPath,
  runtimePath,
  toolsPath,
});

try {
  if (typeof installer.main !== "function" || typeof installer.reportMainFailure !== "function") {
    throw new Error("Compiled installer module does not expose main/reportMainFailure");
  }
  await installer.main();
} catch (error) {
  if (typeof installer.reportMainFailure === "function") installer.reportMainFailure(error);
  else process.stderr.write("错误：" + (error instanceof Error ? error.message : String(error)) + "\\n");
  process.exitCode = 1;
}
`;
}

await mkdir(releaseDir, { recursive: true });
const stagingRoot = await realpath(await mkdtemp(join(tmpdir(), "chengfeng-videocut-installer-payload-")));
try {
  const payloads = await writeInstallerPayloadManifests({
    rootDir,
    releaseDir,
    outputDir: stagingRoot,
    platformKeys: selected,
    managedToolsLockPath: process.env.CHENGFENG_VIDEOCUT_MANAGED_TOOLS_LOCK,
  });
  const payloadByPlatform = new Map(payloads.map((payload) => [payload.platformKey, payload]));
  for (const platformKey of selected) {
    const target = NATIVE_INSTALLER_TARGETS[platformKey];
    const payload = payloadByPlatform.get(platformKey);
    if (!payload) throw new Error(`Missing generated payload receipt for ${platformKey}`);
    const wrapperPath = join(stagingRoot, `${platformKey}.mjs`);
    await writeFile(wrapperPath, wrapperSource({ wrapperPath, platformKey, ...payload }), { mode: 0o600 });
    const output = join(releaseDir, target.installerAsset);
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        `--target=${target.bunTarget}`,
        "--define",
        `CHENGFENG_COMPILED_INSTALLER_VERSION=${JSON.stringify(packageJson.version)}`,
        "--define",
        "CHENGFENG_EMBEDDED_PAYLOAD_BUILD=true",
        wrapperPath,
        `--outfile=${output}`,
      ],
      { cwd: rootDir, stdout: "inherit", stderr: "inherit" },
    );
    const code = await child.exited;
    if (code !== 0) throw new Error(`bun build ${platformKey} exited with ${code}`);
    const outputMetadata = await lstat(output);
    if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink() || outputMetadata.size <= 0) {
      throw new Error(`bun build ${platformKey} did not create a non-empty regular installer: ${output}`);
    }
    if (platformKey !== "win32-x64") await chmod(output, 0o755);
    console.log(`Created ${output}`);
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
