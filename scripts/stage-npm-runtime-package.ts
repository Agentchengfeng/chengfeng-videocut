import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseNpmRuntimeTargets, stageNpmRuntimePackages } from "./npm-runtime-package";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = resolve(process.env.CHENGFENG_VIDEOCUT_RELEASE_DIR ?? join(rootDir, "release"));
const output = process.env.CHENGFENG_VIDEOCUT_NPM_RUNTIME_STAGE_DIR;
if (!output) {
  throw new Error("CHENGFENG_VIDEOCUT_NPM_RUNTIME_STAGE_DIR is required; staging never publishes a package");
}
const allowLocalFixture = process.env.CHENGFENG_VIDEOCUT_NPM_RUNTIME_LOCAL_FIXTURE === "1";
const allowPublicBeta = process.env.CHENGFENG_VIDEOCUT_NPM_RUNTIME_PUBLIC_BETA === "1";
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as { version?: unknown };
if (allowLocalFixture && allowPublicBeta) {
  throw new Error("CHENGFENG_VIDEOCUT_NPM_RUNTIME_LOCAL_FIXTURE and CHENGFENG_VIDEOCUT_NPM_RUNTIME_PUBLIC_BETA are mutually exclusive");
}
if (allowLocalFixture && process.env.NODE_ENV !== "test") {
  throw new Error("CHENGFENG_VIDEOCUT_NPM_RUNTIME_LOCAL_FIXTURE=1 requires NODE_ENV=test");
}

const receipts = await stageNpmRuntimePackages({
  rootDir,
  releaseDir,
  outputDir: resolve(output),
  sbomDir: process.env.CHENGFENG_VIDEOCUT_NPM_RUNTIME_SBOM_DIR,
  platformKeys: parseNpmRuntimeTargets(process.env.CHENGFENG_VIDEOCUT_NPM_RUNTIME_TARGETS),
  allowLocalFixture,
  allowPublicBeta,
});
for (const receipt of receipts) {
  console.log(JSON.stringify({
    productVersion: packageJson.version,
    platformKey: receipt.platformKey,
    packageName: receipt.manifest.npmPackage.name,
    packageDir: receipt.packageDir,
    distributionMode: receipt.manifest.distributionMode,
    licenseStatus: receipt.manifest.licenseStatus,
    installerSha256: receipt.manifest.installer.sha256,
  }));
}
