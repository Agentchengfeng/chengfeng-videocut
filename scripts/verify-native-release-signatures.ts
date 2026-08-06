import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readNativeSigningPolicy,
  verifyMacInstallerSignatures,
  verifyNativeReleaseSecurity,
  verifyWindowsInstallerSignature,
} from "./native-release-signatures";

const rootDir = resolve(import.meta.dir, "..");
const [mode, releaseArgument] = process.argv.slice(2);
if (!new Set(["--macos", "--windows", "--stage"]).has(mode) || !releaseArgument) {
  throw new Error(
    "Usage: bun scripts/verify-native-release-signatures.ts <--macos|--windows|--stage> <absolute-release-dir>",
  );
}
if (!releaseArgument.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(releaseArgument)) {
  throw new Error("Native signature verification release directory must be absolute");
}
const releaseDir = await realpath(releaseArgument);
const { version } = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
  version?: string;
};
if (!version) throw new Error("Product version is missing");

if (mode === "--stage") {
  await verifyNativeReleaseSecurity({ rootDir, releaseDir, version });
} else {
  const policy = await readNativeSigningPolicy(rootDir);
  if (mode === "--macos") {
    await verifyMacInstallerSignatures({ releaseDir, policy });
  } else {
    await verifyWindowsInstallerSignature({ rootDir, releaseDir, policy });
  }
}
console.log(`Native ${mode.slice(2)} signature gate passed for ${version}`);
