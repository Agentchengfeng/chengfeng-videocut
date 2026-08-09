#!/usr/bin/env bun
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ACKNOWLEDGE = "--acknowledge-unverified-local-runtime";
const REEXEC_TARGET = "CHENGFENG_VIDEOCUT_LOCAL_AUTH_REEXEC_TARGET";

async function defaultManagedBun(): Promise<string> {
  const defaultRoot = resolve(join(homedir(), ".chengfeng-videocut"));
  const rootMetadata = await lstat(defaultRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("default Product root must be a regular directory");
  }
  const root = await realpath(defaultRoot);

  const toolsRoot = join(root, "tools");
  const current = join(toolsRoot, "current");
  const currentMetadata = await lstat(current);
  if (!currentMetadata.isSymbolicLink()) {
    throw new Error("tools/current must be a managed symlink or junction");
  }
  const [canonicalToolsRoot, canonicalCurrent] = await Promise.all([
    realpath(toolsRoot),
    realpath(current),
  ]);
  const version = relative(canonicalToolsRoot, canonicalCurrent);
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    version.includes("/") || version.includes("\\")
  ) throw new Error("tools/current does not target an exact managed version directory");

  const manifest = JSON.parse(await readFile(join(canonicalCurrent, "resources-manifest.json"), "utf8")) as {
    schemaVersion?: number;
    product?: string;
    executables?: { bun?: unknown };
  };
  const bunRelative = manifest.executables?.bun;
  if (
    manifest.schemaVersion !== 4 || manifest.product !== "chengfeng-videocut-managed-tools" ||
    typeof bunRelative !== "string" || !bunRelative || bunRelative.includes("\0")
  ) throw new Error("resources-manifest does not identify a managed Bun");
  const normalized = bunRelative.replaceAll("\\", "/");
  if (
    isAbsolute(bunRelative) || /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("managed Bun path is invalid");
  const bun = resolve(canonicalCurrent, normalized);
  const escaped = relative(canonicalCurrent, bun);
  if (!escaped || escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("managed Bun escaped tools/current");
  }
  const metadata = await lstat(bun);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("managed Bun must be a single-link regular file");
  }
  await access(bun, process.platform === "win32" ? fsConstants.R_OK : fsConstants.R_OK | fsConstants.X_OK);
  const canonicalBun = await realpath(bun);
  const canonicalEscaped = relative(canonicalCurrent, canonicalBun);
  if (!canonicalEscaped || canonicalEscaped === ".." || canonicalEscaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("managed Bun canonical path escaped tools/current");
  }
  return canonicalBun;
}

if (process.argv.length !== 3 || process.argv[2] !== ACKNOWLEDGE) {
  console.error(
    `Usage: bun scripts/authorize-local-development.ts ${ACKNOWLEDGE}\n` +
    "This source-only command authorizes the exact installed local-test-only Runtime identity. " +
    "It does not change release, license, signing or npm publication status.",
  );
  process.exit(2);
}

try {
  const managedBun = await defaultManagedBun();
  const currentBun = await realpath(process.execPath);
  if (currentBun !== managedBun) {
    if (process.env[REEXEC_TARGET]) {
      throw new Error(
        `managed Bun re-exec loop rejected: child executable ${currentBun} did not match ${managedBun}`,
      );
    }
    const child = spawnSync(
      managedBun,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...process.env, [REEXEC_TARGET]: managedBun },
      },
    );
    if (child.error) throw new Error(`failed to re-exec managed Bun: ${child.error.message}`);
    if (child.signal) throw new Error(`managed Bun authorization child stopped by ${child.signal}`);
    process.exit(child.status ?? 1);
  }
  if (process.env[REEXEC_TARGET] && process.env[REEXEC_TARGET] !== managedBun) {
    throw new Error("managed Bun re-exec target changed before authorization");
  }
  const { authorizeLocalDevelopmentRuntime } = await import("../packages/core/src/node.ts");
  const result = await authorizeLocalDevelopmentRuntime({ acknowledged: true });
  console.log(JSON.stringify({
    ok: true,
    path: result.path,
    runtimeVersion: result.authorization.runtime.version,
    toolsVersion: result.authorization.tools.version,
    developmentMode: true,
    releaseReady: false,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
