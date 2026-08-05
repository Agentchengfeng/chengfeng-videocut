import { existsSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDesktopSmoke } from "./smoke-lib.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const releaseRoot = join(appRoot, "release");
const configured = process.env.CHENGFENG_VIDEOCUT_PACKAGED_APP;
const candidates = configured
  ? [resolve(configured)]
  : platform === "darwin"
  ? [
      join(releaseRoot, `mac-${arch}`, "Chengfeng VideoCut.app", "Contents", "MacOS", "Chengfeng VideoCut"),
      join(releaseRoot, "mac", "Chengfeng VideoCut.app", "Contents", "MacOS", "Chengfeng VideoCut"),
    ]
  : platform === "win32"
  ? [join(releaseRoot, "win-unpacked", "Chengfeng VideoCut.exe")]
  : [join(releaseRoot, "linux-unpacked", "chengfeng-videocut")];
const executable = candidates.find((candidate) => existsSync(candidate));
if (!executable) {
  throw new Error(`Packaged desktop executable was not found. Tried:\n${candidates.join("\n")}`);
}

await runDesktopSmoke({ executable, args: [] });
