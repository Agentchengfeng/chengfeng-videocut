import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export function windowsDesktopInstallerName(version: string): string {
  return `Chengfeng-VideoCut-${version}-win-x64.exe`;
}

export function nativeInstallerAssetNames(): string[] {
  return [
    "chengfeng-videocut-installer-macos-arm64",
    "chengfeng-videocut-installer-macos-x64",
    "chengfeng-videocut-installer-windows-x64.exe",
  ];
}

export function requiredReleaseAssetNames(version: string): string[] {
  return [
    "chengfeng-videocut-install-manifest.json",
    `chengfeng-videocut-runtime-${version}.tar.gz`,
    ...nativeInstallerAssetNames(),
    `chengfeng-videocut-tools-${version}-darwin-arm64.tar.gz`,
    `chengfeng-videocut-tools-${version}-darwin-x64.tar.gz`,
    `chengfeng-videocut-tools-${version}-win32-x64.tar.gz`,
  ];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertReleaseFile(path: string, label: string): Promise<{ size: number; sha256: string; mode: number }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  return { size: metadata.size, sha256: sha256(await readFile(path)), mode: metadata.mode };
}

async function runTar(args: string[]): Promise<string> {
  const child = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`tar ${args.join(" ")} exited ${status}: ${stderr.trim().slice(-1_000)}`);
  return stdout;
}

type AssetRecord = { asset?: unknown; root?: unknown; sha256?: unknown; size?: unknown };

async function verifyAssetRecord(
  releaseDir: string,
  record: AssetRecord,
  expected: { asset: string; root?: string; executable?: boolean },
  label: string,
): Promise<void> {
  if (
    record?.asset !== expected.asset ||
    (expected.root === undefined ? record?.root !== undefined : record?.root !== expected.root) ||
    typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) ||
    !Number.isSafeInteger(record.size) || Number(record.size) <= 0
  ) throw new Error(`${label} manifest record is not exact`);
  const actual = await assertReleaseFile(join(releaseDir, expected.asset), label);
  if (expected.executable && (actual.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable`);
  }
  if (actual.sha256 !== record.sha256 || actual.size !== record.size) {
    throw new Error(`${label} manifest hash/size does not match the asset`);
  }
}

async function verifyManagedToolsArchive(
  releaseDir: string,
  assetName: string,
  rootName: string,
  version: string,
  platformKey: string,
): Promise<void> {
  const archive = join(releaseDir, assetName);
  const listing = (await runTar(["-tzf", archive])).split(/\r?\n/).filter(Boolean);
  for (const raw of listing) {
    const entry = raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (
      entry.startsWith("/") || /^[A-Za-z]:/.test(entry) ||
      entry.split("/").some((part) => part === "..") ||
      (entry !== rootName && !entry.startsWith(`${rootName}/`))
    ) throw new Error(`${assetName} contains an unsafe or unexpected root path`);
  }
  const verbose = (await runTar(["-tvzf", archive])).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => line[0] !== "-" && line[0] !== "d")) {
    throw new Error(`${assetName} contains a link or special entry`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "chengfeng-videocut-release-tools-"));
  try {
    await runTar(["-xzf", archive, "-C", temporary]);
    const root = join(temporary, rootName);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error(`${assetName} root is not a regular directory`);
    }
    const canonicalRoot = await realpath(root);
    const actualFiles = new Map<string, { size: number; sha256: string; mode: number }>();
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) throw new Error(`${assetName} contains a symlink: ${name}`);
        if (metadata.isDirectory()) {
          const canonical = await realpath(absolute);
          const escaped = relative(canonicalRoot, canonical);
          if (escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
            throw new Error(`${assetName} escaped its extracted root`);
          }
          await walk(absolute, name);
        } else if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new Error(`${assetName} contains a hardlink/reparse/special entry: ${name}`);
        } else if (name !== "resources-manifest.json") {
          actualFiles.set(name.replaceAll("\\", "/"), {
            size: metadata.size,
            sha256: sha256(await readFile(absolute)),
            mode: metadata.mode,
          });
        }
      }
    };
    await walk(root);
    const manifestPath = join(root, "resources-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const [platform, arch] = platformKey.split("-");
    if (
      manifest.schemaVersion !== 2 || manifest.product !== "chengfeng-videocut-managed-tools" ||
      manifest.productVersion !== version || manifest.platform !== platform || manifest.arch !== arch ||
      manifest.distributionMode !== "release-ready" || manifest.licenseStatus !== "VERIFIED" ||
      !manifest.executables || !manifest.versions || !Array.isArray(manifest.files)
    ) throw new Error(`${assetName} resources-manifest is not VERIFIED/release-ready/exact-platform`);
    for (const key of ["bun", "ffmpeg", "ffprobe", "chrome"]) {
      const executable = manifest.executables[key];
      if (
        typeof executable !== "string" || !executable || isAbsolute(executable) ||
        executable.split(/[\\/]/).some((part: string) => part === "..") ||
        !actualFiles.has(executable.replaceAll("\\", "/"))
      ) throw new Error(`${assetName} resources-manifest has invalid ${key}`);
      if (platform === "darwin" && (actualFiles.get(executable.replaceAll("\\", "/"))!.mode & 0o111) === 0) {
        throw new Error(`${assetName} managed ${key} is not executable`);
      }
    }
    if (manifest.files.length !== actualFiles.size) {
      throw new Error(`${assetName} resources-manifest file count drifted`);
    }
    const seen = new Set<string>();
    for (const record of manifest.files) {
      if (
        !record || typeof record.path !== "string" || seen.has(record.path) ||
        !Number.isSafeInteger(record.size) || typeof record.sha256 !== "string"
      ) throw new Error(`${assetName} resources-manifest contains an invalid file record`);
      seen.add(record.path);
      const actual = actualFiles.get(record.path);
      if (!actual || actual.size !== record.size || actual.sha256 !== record.sha256) {
        throw new Error(`${assetName} resources-manifest drifted for ${record.path}`);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyNativeReleaseInputs(options: {
  releaseDir: string;
  version: string;
}): Promise<void> {
  const { releaseDir, version } = options;
  const manifestPath = join(releaseDir, "chengfeng-videocut-install-manifest.json");
  await assertReleaseFile(manifestPath, "install manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
  const platformKeys = ["darwin-arm64", "darwin-x64", "win32-x64"];
  if (
    manifest.schemaVersion !== 1 || manifest.product !== "chengfeng-videocut" ||
    manifest.productVersion !== version || manifest.releaseTag !== `v${version}` ||
    manifest.distributionMode !== "release-ready" || manifest.licenseStatus !== "VERIFIED" ||
    !manifest.platforms ||
    Object.keys(manifest.platforms).sort().join(",") !== [...platformKeys].sort().join(",")
  ) throw new Error("Install manifest is not VERIFIED or does not cover exactly three release platforms");
  await verifyAssetRecord(
    releaseDir,
    manifest.runtime,
    { asset: `chengfeng-videocut-runtime-${version}.tar.gz`, root: `chengfeng-videocut-${version}` },
    "Runtime asset",
  );
  for (const platformKey of platformKeys) {
    const installerAsset = platformKey === "darwin-arm64"
      ? "chengfeng-videocut-installer-macos-arm64"
      : platformKey === "darwin-x64"
        ? "chengfeng-videocut-installer-macos-x64"
        : "chengfeng-videocut-installer-windows-x64.exe";
    const toolsAsset = `chengfeng-videocut-tools-${version}-${platformKey}.tar.gz`;
    const platform = manifest.platforms[platformKey];
    if (!platform || platform.installerAsset !== installerAsset) {
      throw new Error(`Install manifest platform ${platformKey} installerAsset is not exact`);
    }
    await verifyAssetRecord(
      releaseDir,
      platform.installer,
      { asset: installerAsset, executable: platformKey.startsWith("darwin-") },
      `${platformKey} installer`,
    );
    await verifyAssetRecord(
      releaseDir,
      platform.tools,
      { asset: toolsAsset, root: toolsAsset.slice(0, -".tar.gz".length) },
      `${platformKey} tools`,
    );
    await verifyManagedToolsArchive(
      releaseDir,
      toolsAsset,
      toolsAsset.slice(0, -".tar.gz".length),
      version,
      platformKey,
    );
  }
}

export async function verifyReleaseAssetManifest(options: {
  releaseDir: string;
  version: string;
}): Promise<{ assetNames: string[]; checksums: Map<string, string> }> {
  const { releaseDir, version } = options;
  const assetNames = requiredReleaseAssetNames(version).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const allowedNames = new Set([...assetNames, "SHA256SUMS.txt"]);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const unexpectedEntries = entries
    .filter((entry) => !entry.isFile() || !allowedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unexpectedEntries.length > 0) {
    throw new Error(`Release contains unexpected assets: ${unexpectedEntries.join(", ")}`);
  }
  const availableNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const missingNames = [...allowedNames].filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) throw new Error(`Release is missing required assets: ${missingNames.join(", ")}`);

  const checksumContent = await readFile(join(releaseDir, "SHA256SUMS.txt"), "utf8");
  const checksums = new Map<string, string>();
  for (const line of checksumContent.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, hash, name] = match;
    if (!assetNames.includes(name)) throw new Error(`SHA256SUMS names unknown asset: ${name}`);
    if (checksums.has(name)) throw new Error(`SHA256SUMS repeats asset: ${name}`);
    checksums.set(name, hash.toLowerCase());
  }
  const unchecked = assetNames.filter((name) => !checksums.has(name));
  if (unchecked.length > 0) throw new Error(`SHA256SUMS does not cover required assets: ${unchecked.join(", ")}`);
  for (const name of assetNames) {
    const actual = sha256(await readFile(join(releaseDir, name)));
    if (actual !== checksums.get(name)) throw new Error(`SHA256 mismatch for ${name}`);
  }
  await verifyNativeReleaseInputs({ releaseDir, version });
  return { assetNames, checksums };
}

export async function writeReleaseChecksums(options: {
  rootDir: string;
  releaseDir: string;
  version: string;
}): Promise<{ checksumPath: string; lines: string[] }> {
  const { releaseDir, version } = options;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }
  await mkdir(releaseDir, { recursive: true });
  const requiredNames = requiredReleaseAssetNames(version);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const allowedNames = new Set([...requiredNames, "SHA256SUMS.txt"]);
  const unexpectedEntries = entries
    .filter((entry) => !entry.isFile() || !allowedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unexpectedEntries.length > 0) {
    throw new Error(`Release directory contains unsupported assets: ${unexpectedEntries.join(", ")}`);
  }
  const availableNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const missingNames = requiredNames.filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) {
    throw new Error(`Missing chengfeng-videocut ${version} release assets: ${missingNames.join(", ")}`);
  }
  const lines: string[] = [];
  for (const name of [...requiredNames].sort((left, right) => left.localeCompare(right, "en"))) {
    lines.push(`${sha256(await readFile(join(releaseDir, name)))}  ${name}`);
  }
  const checksumPath = join(releaseDir, "SHA256SUMS.txt");
  await writeFile(checksumPath, `${lines.join("\n")}\n`);
  return { checksumPath, lines };
}
