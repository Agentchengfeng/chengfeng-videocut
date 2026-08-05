import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "@derhuerst/ffprobe-static";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, "../..");
const cliRoot = resolve(appRoot, "../cli");
const cliDist = join(cliRoot, "dist");
const resourcesRoot = join(appRoot, "dist-resources");
const runtimeTarget = join(resourcesRoot, "runtime");
const runtimeBinTarget = join(runtimeTarget, "bin");
const toolsTarget = join(resourcesRoot, "tools");
const installerTarget = join(resourcesRoot, "installer");
const portableArchive = join(repositoryRoot, "release", "chengfeng-videocut-portable.tar.gz");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const bunTarget = join(runtimeBinTarget, `bun${executableSuffix}`);
const ffmpegTarget = join(toolsTarget, `ffmpeg${executableSuffix}`);
const ffprobeTarget = join(toolsTarget, `ffprobe${executableSuffix}`);

async function requireFile(path, label) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`${label} is missing at ${path}`);
  }
}

function executableVersion(path, args = ["--version"]) {
  const result = spawnSync(path, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot verify ${path}: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    );
  }
  return String(result.stdout).trim().split(/\r?\n/, 1)[0];
}

function runOrThrow(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed: ${
        result.error?.message ?? result.stderr ?? result.stdout ?? `exit ${result.status}`
      }`,
    );
  }
}

async function verifyMediaToolContract(ffmpeg, ffprobe) {
  const workDir = await mkdtemp(join(tmpdir(), "chengfeng-videocut-desktop-tools-"));
  const fixture = join(workDir, "probe.mp4");
  try {
    const generate = spawnSync(ffmpeg, [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=16x16:d=0.1",
      "-frames:v", "1",
      "-c:v", "mpeg4",
      "-y", fixture,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (generate.error || generate.status !== 0) {
      throw new Error(
        `Bundled FFmpeg contract check failed: ${
          generate.error?.message ?? generate.stderr ?? `exit ${generate.status}`
        }`,
      );
    }

    const probe = spawnSync(ffprobe, [
      "-v", "error",
      "-show_entries",
      "format=duration,start_time:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,start_time:stream_side_data=rotation:stream_tags=rotate",
      "-of", "json",
      fixture,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `Bundled FFprobe contract check failed: ${
          probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`
        }`,
      );
    }
    const result = JSON.parse(probe.stdout);
    if (!Array.isArray(result.streams) || result.streams.length !== 1) {
      throw new Error("Bundled FFprobe contract check returned no video stream");
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const bunSource = resolve(process.env.CHENGFENG_VIDEOCUT_BUN_SOURCE ?? process.execPath);
if (!ffmpegPath) throw new Error("ffmpeg-static did not provide a binary for this platform");
if (!ffprobePath) throw new Error("@derhuerst/ffprobe-static did not provide a binary path");

await Promise.all([
  requireFile(join(cliDist, "cli.js"), "Built Runtime CLI"),
  requireFile(join(cliDist, "studio/index.html"), "Built Studio"),
  requireFile(bunSource, "Bun executable"),
  requireFile(ffmpegPath, "FFmpeg executable"),
  requireFile(ffprobePath, "FFprobe executable"),
  requireFile(join(repositoryRoot, "install.cjs"), "Cross-platform Runtime installer"),
  requireFile(join(repositoryRoot, "scripts/package-portable.ts"), "Portable packager"),
]);
await verifyMediaToolContract(ffmpegPath, ffprobePath);
runOrThrow(bunSource, [join(repositoryRoot, "scripts/package-portable.ts")], "Portable Runtime packaging");
await requireFile(portableArchive, "Portable Runtime archive");

await rm(resourcesRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(runtimeBinTarget, { recursive: true }),
  mkdir(toolsTarget, { recursive: true }),
  mkdir(installerTarget, { recursive: true }),
]);
await cp(cliDist, runtimeTarget, { recursive: true, force: true });
await Promise.all([
  copyFile(bunSource, bunTarget),
  copyFile(ffmpegPath, ffmpegTarget),
  copyFile(ffprobePath, ffprobeTarget),
  copyFile(join(repositoryRoot, "install.cjs"), join(installerTarget, "install.cjs")),
  copyFile(
    portableArchive,
    join(installerTarget, "chengfeng-videocut-portable.tar.gz"),
  ),
]);
if (process.platform !== "win32") {
  await Promise.all([
    chmod(bunTarget, 0o755),
    chmod(ffmpegTarget, 0o755),
    chmod(ffprobeTarget, 0o755),
  ]);
}

const cliPackage = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
const archiveBytes = await readFile(portableArchive);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
await writeFile(
  join(installerTarget, "SHA256SUMS.txt"),
  `${archiveSha256}  chengfeng-videocut-portable.tar.gz\n`,
);
const manifest = {
  schemaVersion: 1,
  product: "chengfeng-videocut",
  productVersion: cliPackage.version,
  platform: process.platform,
  arch: process.arch,
  bun: executableVersion(bunTarget),
  ffmpeg: executableVersion(ffmpegTarget, ["-version"]),
  ffprobe: executableVersion(ffprobeTarget, ["-version"]),
};
await writeFile(
  join(resourcesRoot, "resources-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest));
