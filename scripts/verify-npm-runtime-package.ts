import { resolve } from "node:path";
import { verifyNpmRuntimePackage } from "./npm-runtime-package";

const args = process.argv.slice(2);
const allowLocalFixtureIndex = args.indexOf("--allow-local-fixture");
const allowLocalFixture = allowLocalFixtureIndex >= 0;
if (allowLocalFixture) args.splice(allowLocalFixtureIndex, 1);
if (args.length !== 1) {
  throw new Error("Usage: bun scripts/verify-npm-runtime-package.ts [--allow-local-fixture] <package-directory>");
}
if (allowLocalFixture && process.env.NODE_ENV !== "test") {
  throw new Error("--allow-local-fixture requires NODE_ENV=test");
}
const manifest = await verifyNpmRuntimePackage({
  packageDir: resolve(args[0]),
  allowLocalFixture,
});
console.log(JSON.stringify({
  status: "verified",
  productVersion: manifest.productVersion,
  platformKey: manifest.platformKey,
  packageName: manifest.npmPackage.name,
  distributionMode: manifest.distributionMode,
  licenseStatus: manifest.licenseStatus,
  installerSha256: manifest.installer.sha256,
}));
