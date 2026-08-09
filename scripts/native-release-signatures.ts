import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAC_INSTALLERS = [
  "chengfeng-videocut-installer-macos-arm64",
  "chengfeng-videocut-installer-macos-x64",
] as const;
const WINDOWS_INSTALLER = "chengfeng-videocut-installer-windows-x64.exe";
export const WINDOWS_AUTHENTICODE_RECEIPT = "chengfeng-videocut-windows-authenticode-receipt.json";
const ALL_INSTALLERS = [...MAC_INSTALLERS, WINDOWS_INSTALLER] as const;
const EXPECTED_MAC_IDENTIFIERS = {
  "chengfeng-videocut-installer-macos-arm64":
    "com.agentchengfeng.chengfeng-videocut.installer.arm64",
  "chengfeng-videocut-installer-macos-x64":
    "com.agentchengfeng.chengfeng-videocut.installer.x64",
} as const;
const EXPECTED_ATTESTATION_REPOSITORY = "Agentchengfeng/chengfeng-videocut";

export type NativeSigningPolicy = {
  schemaVersion: 2;
  status: "VERIFIED" | "UNCONFIGURED";
  macos: {
    teamIdentifier: string | null;
    certificateCommonName: string | null;
    certificateSha256: string | null;
    identifiers: Record<(typeof MAC_INSTALLERS)[number], string>;
  };
  windows: {
    certificateSubject: string | null;
    certificateSha256: string | null;
  };
  githubAttestation: {
    repository: string;
    signerRepository: string;
    signerWorkflow: string;
    signerDigest: string;
    denySelfHostedRunners: true;
  };
  note?: string;
};

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (command, args) => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
};

function commandText(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function assertCommand(result: CommandResult, label: string): void {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${commandText(result).slice(-2_000)}`);
  }
}

function requireExactString(value: unknown, label: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Native signing policy ${label} is not configured exactly`);
  }
}

export function validateNativeSigningPolicy(policy: unknown): asserts policy is NativeSigningPolicy {
  const value = policy as Record<string, any>;
  if (value?.schemaVersion !== 2 || value?.status !== "VERIFIED") {
    throw new Error("Native signing policy is UNCONFIGURED; public native staging is blocked");
  }
  requireExactString(value.macos?.teamIdentifier, "macOS teamIdentifier", /^[A-Z0-9]{10}$/);
  requireExactString(
    value.macos?.certificateCommonName,
    "macOS certificateCommonName",
    /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/,
  );
  if (!value.macos.certificateCommonName.endsWith(`(${value.macos.teamIdentifier})`)) {
    throw new Error("Native signing policy macOS certificate identity does not match its Team ID");
  }
  requireExactString(value.macos?.certificateSha256, "macOS certificateSha256", /^[A-Fa-f0-9]{64}$/);
  for (const asset of MAC_INSTALLERS) {
    requireExactString(
      value.macos?.identifiers?.[asset],
      `macOS identifier for ${asset}`,
      /^com\.agentchengfeng\.[A-Za-z0-9.-]+$/,
    );
    if (value.macos.identifiers[asset] !== EXPECTED_MAC_IDENTIFIERS[asset]) {
      throw new Error(`Native signing policy macOS identifier for ${asset} is not the Product identifier`);
    }
  }
  requireExactString(value.windows?.certificateSubject, "Windows certificateSubject", /^.{3,512}$/);
  requireExactString(value.windows?.certificateSha256, "Windows certificateSha256", /^[A-Fa-f0-9]{64}$/);
  requireExactString(
    value.githubAttestation?.repository,
    "GitHub attestation repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  requireExactString(
    value.githubAttestation?.signerRepository,
    "GitHub signer repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  if (
    value.githubAttestation.signerRepository.toLowerCase() ===
      EXPECTED_ATTESTATION_REPOSITORY.toLowerCase()
  ) {
    throw new Error("Native attestation signer must be an independent repository");
  }
  requireExactString(
    value.githubAttestation?.signerWorkflow,
    "GitHub signerWorkflow",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,
  );
  if (!value.githubAttestation.signerWorkflow.startsWith(`${value.githubAttestation.signerRepository}/`)) {
    throw new Error("Native attestation signer workflow does not belong to its pinned repository");
  }
  requireExactString(
    value.githubAttestation?.signerDigest,
    "GitHub signerDigest",
    /^[a-f0-9]{40}$/,
  );
  if (
    value.githubAttestation.repository !== EXPECTED_ATTESTATION_REPOSITORY ||
    value.githubAttestation.denySelfHostedRunners !== true
  ) throw new Error("Native signing policy GitHub attestation identity is not exact");
}

async function assertSingleLinkFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
}

export async function readNativeSigningPolicy(rootDir: string): Promise<NativeSigningPolicy> {
  return readNativeSigningPolicyFile(join(rootDir, "installer/native-release-signing-policy.json"));
}

export async function readNativeSigningPolicyFile(path: string): Promise<NativeSigningPolicy> {
  await assertSingleLinkFile(path, "Native signing policy");
  const policy = JSON.parse(await readFile(path, "utf8")) as unknown;
  validateNativeSigningPolicy(policy);
  return policy;
}

function parseCodesignDetails(text: string): {
  identifier?: string;
  teamIdentifier?: string;
  authorities: string[];
  flags?: string;
  timestamp?: string;
} {
  const result: {
    identifier?: string;
    teamIdentifier?: string;
    authorities: string[];
    flags?: string;
    timestamp?: string;
  } = { authorities: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "Identifier") result.identifier = value;
    else if (key === "TeamIdentifier") result.teamIdentifier = value;
    else if (key === "Authority") result.authorities.push(value);
    else if (key === "flags") result.flags = value;
    else if (key === "Timestamp") result.timestamp = value;
  }
  return result;
}

export async function verifyMacInstallerSignatures(options: {
  releaseDir: string;
  policy: NativeSigningPolicy;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}): Promise<void> {
  validateNativeSigningPolicy(options.policy);
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("macOS Developer ID and Gatekeeper checks must run on a native macOS runner");
  }
  const runner = options.runner ?? defaultRunner;
  for (const asset of MAC_INSTALLERS) {
    const path = join(options.releaseDir, asset);
    await assertSingleLinkFile(path, asset);
    const verified = await runner("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", path]);
    assertCommand(verified, `${asset} strict codesign verification`);

    const displayed = await runner("/usr/bin/codesign", ["--display", "--verbose=4", path]);
    assertCommand(displayed, `${asset} codesign identity inspection`);
    const details = parseCodesignDetails(commandText(displayed));
    if (details.identifier !== options.policy.macos.identifiers[asset]) {
      throw new Error(`${asset} code-signing identifier is not pinned`);
    }
    if (details.teamIdentifier !== options.policy.macos.teamIdentifier) {
      throw new Error(`${asset} Developer ID TeamIdentifier is not pinned`);
    }
    if (details.authorities[0] !== options.policy.macos.certificateCommonName) {
      throw new Error(`${asset} Developer ID certificate common name is not pinned`);
    }
    if (!details.flags?.includes("runtime")) {
      throw new Error(`${asset} is missing the hardened runtime code-signing flag`);
    }
    if (!details.timestamp || details.timestamp.toLowerCase() === "none") {
      throw new Error(`${asset} is missing a secure code-signing timestamp`);
    }

    const temporary = await mkdtemp(join(tmpdir(), "chengfeng-videocut-codesign-cert-"));
    try {
      const prefix = join(temporary, "certificate");
      // codesign treats the long option's prefix as optional, so a separate
      // argv element is parsed as the code object. `=` is required here.
      const extracted = await runner("/usr/bin/codesign", ["--display", `--extract-certificates=${prefix}`, path]);
      assertCommand(extracted, `${asset} certificate extraction`);
      const certificatePath = `${prefix}0`;
      await assertSingleLinkFile(certificatePath, `${asset} leaf certificate`);
      const certificateSha256 = createHash("sha256")
        .update(await readFile(certificatePath))
        .digest("hex");
      if (certificateSha256 !== options.policy.macos.certificateSha256.toLowerCase()) {
        throw new Error(`${asset} Developer ID leaf certificate fingerprint is not pinned`);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    const gatekeeper = await runner("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      path,
    ]);
    assertCommand(gatekeeper, `${asset} Gatekeeper assessment`);
    if (!/^source=Notarized Developer ID$/m.test(commandText(gatekeeper))) {
      throw new Error(`${asset} was not accepted by Gatekeeper as Notarized Developer ID`);
    }
  }
}

type WindowsSignatureReport = {
  status?: unknown;
  signatureType?: unknown;
  certificateSubject?: unknown;
  certificateSha256?: unknown;
  hasCodeSigningEku?: unknown;
  hasTrustedTimestamp?: unknown;
};

export type WindowsAuthenticodeReceipt = {
  schemaVersion: 1;
  kind: "chengfeng-videocut-windows-authenticode-verification";
  productVersion: string;
  releaseTag: string;
  sourceDigest: string;
  platform: "win32";
  verifier: "Get-AuthenticodeSignature";
  signingPolicySha256: string;
  workflowRun: {
    repository: "Agentchengfeng/chengfeng-videocut";
    runId: string;
    runAttempt: number;
    workflowRef: string;
    environment: "native-release";
  };
  installer: {
    asset: typeof WINDOWS_INSTALLER;
    sha256: string;
    size: number;
  };
};

export async function verifyWindowsInstallerSignature(options: {
  rootDir: string;
  releaseDir: string;
  policy: NativeSigningPolicy;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}): Promise<void> {
  validateNativeSigningPolicy(options.policy);
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("Windows Authenticode checks must run on a native Windows runner");
  }
  const path = join(options.releaseDir, WINDOWS_INSTALLER);
  await assertSingleLinkFile(path, WINDOWS_INSTALLER);
  const runner = options.runner ?? defaultRunner;
  const powershell = process.env.ComSpec ? "powershell.exe" : "pwsh";
  const result = await runner(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(options.rootDir, "scripts/verify-windows-authenticode.ps1"),
    "-InstallerPath",
    path,
  ]);
  assertCommand(result, `${WINDOWS_INSTALLER} native Authenticode verification`);
  let report: WindowsSignatureReport;
  try {
    report = JSON.parse(result.stdout.trim()) as WindowsSignatureReport;
  } catch {
    throw new Error("Windows Authenticode verifier did not return one JSON report");
  }
  if (
    report.status !== "Valid" || report.signatureType !== "Authenticode" ||
    report.certificateSubject !== options.policy.windows.certificateSubject ||
    typeof report.certificateSha256 !== "string" ||
    report.certificateSha256.toLowerCase() !== options.policy.windows.certificateSha256.toLowerCase() ||
    report.hasCodeSigningEku !== true || report.hasTrustedTimestamp !== true
  ) throw new Error("Windows Authenticode signer identity or trust result is not pinned and valid");
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) throw new Error(`${label} keys are not exact`);
}

export async function verifyWindowsAuthenticodeReceipt(options: {
  releaseDir: string;
  attestationDir: string;
  version: string;
  sourceDigest: string;
  signingPolicySha256: string;
  expectedWorkflowRunId: string;
  policy: NativeSigningPolicy;
  runner?: CommandRunner;
}): Promise<void> {
  validateNativeSigningPolicy(options.policy);
  if (!/^[a-f0-9]{40,64}$/.test(options.sourceDigest)) {
    throw new Error("Windows Authenticode receipt source digest must be the exact release commit");
  }
  if (!/^[a-f0-9]{64}$/.test(options.signingPolicySha256)) {
    throw new Error("Windows Authenticode receipt signing policy digest is invalid");
  }
  const attestationDir = await canonicalAttestationDirectory(options.attestationDir);
  const receiptPath = join(attestationDir, WINDOWS_AUTHENTICODE_RECEIPT);
  const bundlePath = join(attestationDir, `${WINDOWS_AUTHENTICODE_RECEIPT}.attestation.json`);
  await assertSingleLinkFile(receiptPath, "Windows Authenticode verification receipt");
  await assertSingleLinkFile(bundlePath, "Windows Authenticode receipt attestation bundle");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  exactObjectKeys(receipt, [
    "schemaVersion", "kind", "productVersion", "releaseTag", "sourceDigest", "platform",
    "verifier", "signingPolicySha256", "workflowRun", "installer",
  ], "Windows Authenticode receipt");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "chengfeng-videocut-windows-authenticode-verification" ||
    receipt.productVersion !== options.version ||
    receipt.releaseTag !== `v${options.version}` ||
    receipt.sourceDigest !== options.sourceDigest ||
    receipt.platform !== "win32" ||
    receipt.verifier !== "Get-AuthenticodeSignature" ||
    receipt.signingPolicySha256 !== options.signingPolicySha256
  ) throw new Error("Windows Authenticode receipt identity is not exact");
  if (!receipt.workflowRun || typeof receipt.workflowRun !== "object" || Array.isArray(receipt.workflowRun)) {
    throw new Error("Windows Authenticode receipt workflow run is invalid");
  }
  const workflowRun = receipt.workflowRun as Record<string, unknown>;
  exactObjectKeys(workflowRun, ["repository", "runId", "runAttempt", "workflowRef", "environment"],
    "Windows Authenticode receipt workflow run");
  if (
    workflowRun.repository !== "Agentchengfeng/chengfeng-videocut" ||
    workflowRun.runId !== options.expectedWorkflowRunId ||
    !/^[1-9][0-9]*$/.test(options.expectedWorkflowRunId) ||
    !Number.isSafeInteger(workflowRun.runAttempt) || Number(workflowRun.runAttempt) < 1 ||
    workflowRun.workflowRef !==
      `Agentchengfeng/chengfeng-videocut/.github/workflows/native-release-signing.yml@refs/tags/v${options.version}` ||
    workflowRun.environment !== "native-release"
  ) throw new Error("Windows Authenticode receipt is not bound to the expected protected workflow run");
  if (!receipt.installer || typeof receipt.installer !== "object" || Array.isArray(receipt.installer)) {
    throw new Error("Windows Authenticode receipt installer record is invalid");
  }
  const installer = receipt.installer as Record<string, unknown>;
  exactObjectKeys(installer, ["asset", "sha256", "size"], "Windows Authenticode receipt installer");
  const installerPath = join(options.releaseDir, WINDOWS_INSTALLER);
  await assertSingleLinkFile(installerPath, WINDOWS_INSTALLER);
  const installerBytes = await readFile(installerPath);
  const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
  if (
    installer.asset !== WINDOWS_INSTALLER ||
    installer.sha256 !== installerSha256 ||
    installer.size !== installerBytes.length
  ) throw new Error("Windows Authenticode receipt does not bind the exact installer bytes");

  const runner = options.runner ?? defaultRunner;
  const args = [
    "attestation", "verify", receiptPath,
    "--bundle", bundlePath,
    "--repo", options.policy.githubAttestation.repository,
    "--signer-workflow", options.policy.githubAttestation.signerWorkflow,
    "--signer-digest", options.policy.githubAttestation.signerDigest,
    "--source-ref", `refs/tags/v${options.version}`,
    "--source-digest", options.sourceDigest,
    "--predicate-type", "https://slsa.dev/provenance/v1",
    "--format", "json",
  ];
  if (options.policy.githubAttestation.denySelfHostedRunners) args.push("--deny-self-hosted-runners");
  const result = await runner("gh", args);
  assertCommand(result, "Windows Authenticode receipt GitHub attestation verification");
  let verified: unknown;
  try {
    verified = JSON.parse(result.stdout);
  } catch {
    throw new Error("Windows Authenticode receipt attestation verifier returned invalid JSON");
  }
  if (!Array.isArray(verified) || verified.length < 1) {
    throw new Error("Windows Authenticode receipt has no verified GitHub artifact attestation");
  }
}

async function canonicalAttestationDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Native attestation directory must be absolute");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Native attestation directory must be a non-symlink directory");
  }
  return realpath(path);
}

export async function verifyInstallerAttestations(options: {
  releaseDir: string;
  attestationDir: string;
  version: string;
  sourceDigest: string;
  policy: NativeSigningPolicy;
  runner?: CommandRunner;
}): Promise<void> {
  validateNativeSigningPolicy(options.policy);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error(`Invalid native attestation version: ${options.version}`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(options.sourceDigest)) {
    throw new Error("Native attestation source digest must be the exact release commit");
  }
  if (options.sourceDigest === options.policy.githubAttestation.signerDigest) {
    throw new Error("Native attestation signer digest must be independent from the source digest");
  }
  const attestationDir = await canonicalAttestationDirectory(options.attestationDir);
  const runner = options.runner ?? defaultRunner;
  for (const asset of ALL_INSTALLERS) {
    const subject = join(options.releaseDir, asset);
    const bundle = join(attestationDir, `${asset}.attestation.json`);
    await assertSingleLinkFile(subject, asset);
    await assertSingleLinkFile(bundle, `${asset} GitHub attestation bundle`);
    const args = [
      "attestation",
      "verify",
      subject,
      "--bundle",
      bundle,
      "--repo",
      options.policy.githubAttestation.repository,
      "--signer-workflow",
      options.policy.githubAttestation.signerWorkflow,
      "--signer-digest",
      options.policy.githubAttestation.signerDigest,
      "--source-ref",
      `refs/tags/v${options.version}`,
      "--source-digest",
      options.sourceDigest,
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--format",
      "json",
    ];
    if (options.policy.githubAttestation.denySelfHostedRunners) args.push("--deny-self-hosted-runners");
    const result = await runner("gh", args);
    assertCommand(result, `${asset} GitHub artifact attestation verification`);
    let verified: unknown;
    try {
      verified = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${asset} GitHub attestation verifier returned invalid JSON`);
    }
    if (!Array.isArray(verified) || verified.length < 1) {
      throw new Error(`${asset} has no verified GitHub artifact attestation`);
    }
  }
}

export async function verifyNativeReleaseSecurity(options: {
  rootDir: string;
  policyPath?: string;
  releaseDir: string;
  version: string;
  attestationDir?: string;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  expectedWorkflowRunId?: string;
}): Promise<void> {
  const policy = options.policyPath
    ? await readNativeSigningPolicyFile(options.policyPath)
    : await readNativeSigningPolicy(options.rootDir);
  const policyPath = options.policyPath ?? join(options.rootDir, "installer/native-release-signing-policy.json");
  const signingPolicySha256 = createHash("sha256").update(await readFile(policyPath)).digest("hex");
  const attestationDir = options.attestationDir ?? process.env.CHENGFENG_VIDEOCUT_NATIVE_ATTESTATION_DIR;
  if (!attestationDir) {
    throw new Error("CHENGFENG_VIDEOCUT_NATIVE_ATTESTATION_DIR is required for public native staging");
  }
  const expectedWorkflowRunId = options.expectedWorkflowRunId ??
    process.env.CHENGFENG_VIDEOCUT_NATIVE_WORKFLOW_RUN_ID;
  if (!expectedWorkflowRunId || !/^[1-9][0-9]*$/.test(expectedWorkflowRunId)) {
    throw new Error("CHENGFENG_VIDEOCUT_NATIVE_WORKFLOW_RUN_ID is required for public native staging");
  }
  await verifyMacInstallerSignatures({
    releaseDir: options.releaseDir,
    policy,
    runner: options.runner,
    platform: options.platform,
  });
  const runner = options.runner ?? defaultRunner;
  const head = await runner("git", ["-C", options.rootDir, "rev-parse", "HEAD"]);
  assertCommand(head, "Native Release source commit resolution");
  const sourceDigest = head.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(sourceDigest)) {
    throw new Error("Native Release source commit is not an exact Git digest");
  }
  await verifyInstallerAttestations({
    releaseDir: options.releaseDir,
    attestationDir,
    version: options.version,
    sourceDigest,
    policy,
    runner,
  });
  // Authenticode trust can only be established on native Windows. The protected,
  // independently-attested receipt binds that native result to these exact bytes,
  // source commit and signing policy before a macOS stage may aggregate packages.
  await verifyWindowsAuthenticodeReceipt({
    releaseDir: options.releaseDir,
    attestationDir,
    version: options.version,
    sourceDigest,
    signingPolicySha256,
    expectedWorkflowRunId,
    policy,
    runner,
  });
}

export const nativeInstallerAssets = ALL_INSTALLERS;
