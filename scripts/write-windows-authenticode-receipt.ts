import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  readNativeSigningPolicy,
  verifyWindowsInstallerSignature,
  WINDOWS_AUTHENTICODE_RECEIPT,
  type WindowsAuthenticodeReceipt,
} from "./native-release-signatures";

const rootDir = resolve(import.meta.dir, "..");
const releaseDir = resolve(process.argv[2] ?? join(rootDir, "release"));
const outputPath = resolve(process.argv[3] ?? join(releaseDir, WINDOWS_AUTHENTICODE_RECEIPT));
if (!isAbsolute(outputPath)) throw new Error("Windows Authenticode receipt output must be absolute");
if (outputPath !== join(releaseDir, WINDOWS_AUTHENTICODE_RECEIPT)) {
  throw new Error("Windows Authenticode receipt output must be the exact release receipt path");
}
const workflowRepository = process.env.GITHUB_REPOSITORY;
const workflowRunId = process.env.GITHUB_RUN_ID;
const workflowRunAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const workflowRef = process.env.GITHUB_WORKFLOW_REF;
if (
  workflowRepository !== "Agentchengfeng/chengfeng-videocut" ||
  !workflowRunId || !/^[1-9][0-9]*$/.test(workflowRunId) ||
  !Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt < 1 ||
  typeof workflowRef !== "string"
) throw new Error("A protected GitHub native-release workflow identity is required");

const product = await Bun.file(join(rootDir, "package.json")).json() as { version?: unknown };
if (typeof product.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(product.version)) {
  throw new Error("Product version is invalid");
}
const expectedWorkflowRef =
  `Agentchengfeng/chengfeng-videocut/.github/workflows/native-release-signing.yml@refs/tags/v${product.version}`;
if (workflowRef !== expectedWorkflowRef) {
  throw new Error("Windows Authenticode receipt workflow ref is not the exact Product tag");
}
const policy = await readNativeSigningPolicy(rootDir);
await verifyWindowsInstallerSignature({ rootDir, releaseDir, policy });

const head = Bun.spawnSync(["git", "-C", rootDir, "rev-parse", "HEAD"]);
if (head.exitCode !== 0) throw new Error("Cannot resolve the exact release commit");
const sourceDigest = head.stdout.toString().trim();
if (!/^[a-f0-9]{40,64}$/.test(sourceDigest)) throw new Error("Release commit is not an exact Git digest");

const installerAsset = "chengfeng-videocut-installer-windows-x64.exe" as const;
const installerPath = join(releaseDir, installerAsset);
const installerMetadata = await lstat(installerPath);
if (!installerMetadata.isFile() || installerMetadata.isSymbolicLink() || installerMetadata.nlink !== 1) {
  throw new Error("Windows installer must be a single-link regular file");
}
const installerBytes = await readFile(installerPath);
const policyBytes = await readFile(join(rootDir, "installer/native-release-signing-policy.json"));
const receipt: WindowsAuthenticodeReceipt = {
  schemaVersion: 1,
  kind: "chengfeng-videocut-windows-authenticode-verification",
  productVersion: product.version,
  releaseTag: `v${product.version}`,
  sourceDigest,
  platform: "win32",
  verifier: "Get-AuthenticodeSignature",
  signingPolicySha256: createHash("sha256").update(policyBytes).digest("hex"),
  workflowRun: {
    repository: "Agentchengfeng/chengfeng-videocut",
    runId: workflowRunId,
    runAttempt: workflowRunAttempt,
    workflowRef: expectedWorkflowRef,
    environment: "native-release",
  },
  installer: {
    asset: installerAsset,
    sha256: createHash("sha256").update(installerBytes).digest("hex"),
    size: installerBytes.length,
  },
};
await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
console.log(JSON.stringify({ receipt: outputPath, sourceDigest, installer: receipt.installer }, null, 2));
