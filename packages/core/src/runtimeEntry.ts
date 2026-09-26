import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface RuntimeEntryStatus {
  scope: "selected-runtime-only";
  state: "source-development" | "consistent" | "entry_mismatch" | "target_missing" | "unverified";
  ok: boolean;
  dataDir: string;
  launcher: string | null;
  expectedLauncher: string;
  detail: string;
}

/** Read-only configuration check, not a signature check or an installation scan. */
export async function inspectRuntimeEntry(input: {
  dataDir: string;
  launcher?: string;
  configuredHome?: string;
  platform?: string;
}): Promise<RuntimeEntryStatus> {
  const platform = input.platform ?? process.platform;
  const dataDir = resolve(input.dataDir);
  const launcher = input.launcher?.trim() || null;
  const expectedLauncher = join(dataDir, "bin", platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
  const result = (state: RuntimeEntryStatus["state"], detail: string): RuntimeEntryStatus => ({
    scope: "selected-runtime-only", state,
    ok: state === "consistent" || state === "source-development",
    dataDir, launcher, expectedLauncher, detail,
  });
  const samePath = (left: string, right: string) => platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
  if (!isAbsolute(input.dataDir) || (input.configuredHome && !isAbsolute(input.configuredHome))) {
    return result("entry_mismatch", "Selected Runtime roots must be absolute paths; no fallback was attempted");
  }
  if (input.configuredHome && !samePath(input.configuredHome, dataDir)) {
    return result("entry_mismatch", "CHENGFENG_VIDEOCUT_HOME and the selected data directory disagree; choose one Runtime root");
  }
  if (!launcher) {
    return result("source-development", "Direct source/development execution; this does not verify the Plugin or managed service installation");
  }
  if (!isAbsolute(launcher) || !samePath(launcher, expectedLauncher)) {
    return result("entry_mismatch", "Selected launcher is not the managed bin entry of the selected Runtime root; no PATH fallback was attempted");
  }
  try {
    const [root, bin, file] = await Promise.all([lstat(dataDir), lstat(join(dataDir, "bin")), lstat(launcher)]);
    if (!root.isDirectory() || root.isSymbolicLink() || !bin.isDirectory() || bin.isSymbolicLink()
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
      return result("unverified", "Selected Runtime root/bin must be ordinary directories and launcher a single-link regular file");
    }
    if (platform !== "win32" && (file.mode & 0o111) === 0) {
      return result("unverified", "Selected Runtime launcher is not executable");
    }
    const [canonicalRoot, canonicalLauncher] = await Promise.all([realpath(dataDir), realpath(launcher)]);
    if (!samePath(canonicalLauncher, join(canonicalRoot, "bin", platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut"))) {
      return result("entry_mismatch", "Selected launcher resolves outside the managed bin entry");
    }
    return result("consistent", "Selected launcher and Runtime root agree; service identity and installed payload integrity require their separate checks");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? result("target_missing", "The selected Runtime entry is absent; this does not mean no Runtime is installed elsewhere")
      : result("unverified", "Cannot verify the selected Runtime entry; no installation or fallback was attempted");
  }
}
