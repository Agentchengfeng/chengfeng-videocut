import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  lstat,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = join(rootDir, "release");
const rootPackage = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version: string;
};
const lock = JSON.parse(
  await readFile(join(rootDir, "installer/managed-tools.lock.json"), "utf8"),
) as {
  productVersion: string;
  tools: {
    bun: { version: string };
    ffmpeg: { version: string };
    ffprobe: { version: string };
    chrome: { browser: string; buildId: string; "darwin-arm64ExecutableSha256"?: string };
  };
  licenseStatus: string;
  licenseNote: string;
};

if (lock.productVersion !== rootPackage.version) {
  throw new Error(`managed-tools.lock.json ${lock.productVersion} != package ${rootPackage.version}`);
}

const platform = process.env.CHENGFENG_VIDEOCUT_TOOLS_PLATFORM ?? process.platform;
const arch = process.env.CHENGFENG_VIDEOCUT_TOOLS_ARCH ?? process.arch;
const platformKey = `${platform}-${arch}`;
if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(platformKey)) {
  throw new Error(`Unsupported managed-tools platform: ${platformKey}`);
}
const suffix = platform === "win32" ? ".exe" : "";
const localFixture = process.env.CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE === "1";
if (!localFixture && lock.licenseStatus !== "VERIFIED") {
  throw new Error(
    "Managed tools redistribution is UNVERIFIED. Public release packaging is blocked; " +
    "use CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE=1 only for isolated engineering smoke.",
  );
}
const requiredSource = (name: string, fallback?: string | null): string => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
};
const bunSource = requiredSource("CHENGFENG_VIDEOCUT_BUN_SOURCE", process.execPath);
// Media binaries must be explicit. Never package the first PATH/Homebrew hit:
// it may have undeclared dylib/DLL dependencies and cannot be a release asset.
const ffmpegSource = requiredSource("CHENGFENG_VIDEOCUT_FFMPEG_SOURCE");
const ffprobeSource = requiredSource("CHENGFENG_VIDEOCUT_FFPROBE_SOURCE");
const chromeRoot = requiredSource("CHENGFENG_VIDEOCUT_CHROME_ROOT");
const chromeExecutableSource = requiredSource("CHENGFENG_VIDEOCUT_CHROME_EXECUTABLE");
const canonicalChromeRoot = await realpath(chromeRoot);
const canonicalChromeExecutable = await realpath(chromeExecutableSource);
const chromeRelative = relative(canonicalChromeRoot, canonicalChromeExecutable);
if (!chromeRelative || chromeRelative.startsWith("..") || resolve(canonicalChromeRoot, chromeRelative) !== canonicalChromeExecutable) {
  throw new Error("Chrome executable must be inside CHENGFENG_VIDEOCUT_CHROME_ROOT");
}

async function assertSingleLinkRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
}

async function assertRegularSourceTree(directory: string, root = directory): Promise<void> {
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = await realpath(directory);
  const relativeDirectory = relative(canonicalRoot, canonicalDirectory);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Managed source tree escaped its canonical root");
  }
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Managed source tree contains non-directory root: ${directory}`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`Managed source tree contains symlink: ${absolute}`);
    if (metadata.isDirectory()) await assertRegularSourceTree(absolute, root);
    else if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Managed source tree contains hardlink/reparse/special entry: ${absolute}`);
    }
  }
}

await Promise.all([
  assertSingleLinkRegularFile(bunSource, "Bun source"),
  assertSingleLinkRegularFile(ffmpegSource, "FFmpeg source"),
  assertSingleLinkRegularFile(ffprobeSource, "FFprobe source"),
  assertRegularSourceTree(chromeRoot),
]);
await assertSingleLinkRegularFile(chromeExecutableSource, "Chrome executable source");

function firstVersionLine(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot verify ${command}: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/, 1)[0];
}

const versions = {
  bun: firstVersionLine(bunSource, ["--version"]),
  ffmpeg: firstVersionLine(ffmpegSource, ["-version"]),
  ffprobe: firstVersionLine(ffprobeSource, ["-version"]),
  chrome: firstVersionLine(chromeExecutableSource, ["--version"]),
};
if (versions.bun !== lock.tools.bun.version) throw new Error(`Bun version drift: ${versions.bun}`);
const exactMediaVersion = (tool: "ffmpeg" | "ffprobe", actual: string, expected: string): boolean =>
  new RegExp(`^${tool} version (?:n)?${expected.replaceAll(".", "\\.")}(?:[-\\s]|$)`).test(actual);
if (!exactMediaVersion("ffmpeg", versions.ffmpeg, lock.tools.ffmpeg.version)) {
  throw new Error(`FFmpeg version drift: ${versions.ffmpeg}`);
}
if (!exactMediaVersion("ffprobe", versions.ffprobe, lock.tools.ffprobe.version)) {
  throw new Error(`FFprobe version drift: ${versions.ffprobe}`);
}
if (versions.chrome !== `Google Chrome for Testing ${lock.tools.chrome.buildId}`) {
  throw new Error(`Chrome version drift: ${versions.chrome}`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const ffmpegContract = spawnSync(ffmpegSource, ["-version"], {
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
const ffmpegContractText = `${ffmpegContract.stdout ?? ""}${ffmpegContract.stderr ?? ""}`;
if (!localFixture && /--enable-nonfree|--enable-gpl/.test(ffmpegContractText)) {
  throw new Error("FFmpeg source has GPL/nonfree configuration; release-ready packaging is blocked");
}

const sourceDigests = {
  bun: await sha256(bunSource),
  ffmpeg: await sha256(ffmpegSource),
  ffprobe: await sha256(ffprobeSource),
  chromeExecutable: await sha256(chromeExecutableSource),
};
for (const [key, actual] of Object.entries(sourceDigests)) {
  const envName = `CHENGFENG_VIDEOCUT_${key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_SHA256`;
  const expected = process.env[envName];
  if (!localFixture && !expected) throw new Error(`${envName} is required for release-ready packaging`);
  if (expected && expected.toLowerCase() !== actual) throw new Error(`${envName} mismatch`);
}

const expectedChromeSha = platformKey === "darwin-arm64"
  ? lock.tools.chrome["darwin-arm64ExecutableSha256"]
  : undefined;
if (expectedChromeSha && sourceDigests.chromeExecutable !== expectedChromeSha) {
  throw new Error("Pinned Chrome Headless Shell executable SHA-256 mismatch");
}

const stageRoot = await mkdtemp(join(tmpdir(), "chengfeng-videocut-tools-"));
const rootName = `chengfeng-videocut-tools-${rootPackage.version}-${platformKey}`;
const bundleRoot = join(stageRoot, rootName);
const chromeTarget = join(bundleRoot, "chrome");
const executableNames = {
  bun: `bun${suffix}`,
  ffmpeg: `ffmpeg${suffix}`,
  ffprobe: `ffprobe${suffix}`,
  chrome: join("chrome", chromeRelative),
};

type FileRecord = { path: string; size: number; sha256: string };
async function collectFiles(directory: string, prefix = ""): Promise<FileRecord[]> {
  const records: FileRecord[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Managed tools source contains symlink: ${childPrefix}`);
    if (entry.isDirectory()) records.push(...await collectFiles(absolute, childPrefix));
    else if (entry.isFile() && childPrefix !== "resources-manifest.json") {
      const metadata = await stat(absolute);
      records.push({ path: childPrefix, size: metadata.size, sha256: await sha256(absolute) });
    } else if (!entry.isFile()) throw new Error(`Managed tools source contains special entry: ${childPrefix}`);
  }
  return records;
}

await rm(join(releaseDir, `${rootName}.tar.gz`), { force: true });
try {
  await mkdir(bundleRoot, { recursive: true });
  await Promise.all([
    copyFile(bunSource, join(bundleRoot, executableNames.bun)),
    copyFile(ffmpegSource, join(bundleRoot, executableNames.ffmpeg)),
    copyFile(ffprobeSource, join(bundleRoot, executableNames.ffprobe)),
    cp(canonicalChromeRoot, chromeTarget, { recursive: true, force: true, verbatimSymlinks: true }),
  ]);
  await writeFile(
    join(bundleRoot, "THIRD_PARTY-NOTICE-STATUS.txt"),
    `${lock.licenseStatus}\n${lock.licenseNote}\n`,
  );
  if (platform !== "win32") {
    await Promise.all(Object.values(executableNames).map((value) => chmod(join(bundleRoot, value), 0o755)));
  }
  const manifest = {
    schemaVersion: 2,
    product: "chengfeng-videocut-managed-tools",
    productVersion: rootPackage.version,
    platform,
    arch,
    executables: Object.fromEntries(
      Object.entries(executableNames).map(([key, value]) => [key, value.replaceAll("\\", "/")]),
    ),
    versions,
    sourceDigests,
    distributionMode: localFixture ? "local-test-only" : "release-ready",
    files: await collectFiles(bundleRoot),
    licenseStatus: lock.licenseStatus,
    licenseNote: lock.licenseNote,
  };
  await writeFile(join(bundleRoot, "resources-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(releaseDir, { recursive: true });
  const asset = `${rootName}.tar.gz`;
  const output = join(releaseDir, asset);
  const tar = Bun.spawn(["tar", "-czf", output, "-C", stageRoot, rootName], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await tar.exited;
  if (code !== 0) throw new Error(`tar exited with ${code}`);
  const sidecar = {
    platformKey,
    asset,
    root: rootName,
    sha256: await sha256(output),
    size: (await stat(output)).size,
    resourcesManifestSha256: await sha256(join(bundleRoot, "resources-manifest.json")),
    distributionMode: localFixture ? "local-test-only" : "release-ready",
    licenseStatus: lock.licenseStatus,
  };
  await writeFile(join(releaseDir, `${asset}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(JSON.stringify(sidecar));
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
