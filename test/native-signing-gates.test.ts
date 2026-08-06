import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  type NativeSigningPolicy,
  validateNativeSigningPolicy,
  verifyInstallerAttestations,
  verifyMacInstallerSignatures,
  verifyWindowsInstallerSignature,
} from "../scripts/native-release-signatures";

const temporaryRoots: string[] = [];
const CERTIFICATE = new TextEncoder().encode("pinned-developer-id-leaf-certificate");
const CERTIFICATE_SHA256 = createHash("sha256").update(CERTIFICATE).digest("hex");
const MAC_ASSETS = [
  "chengfeng-videocut-installer-macos-arm64",
  "chengfeng-videocut-installer-macos-x64",
] as const;
const WINDOWS_ASSET = "chengfeng-videocut-installer-windows-x64.exe";

function policy(): NativeSigningPolicy {
  return {
    schemaVersion: 2,
    status: "VERIFIED",
    macos: {
      teamIdentifier: "ABCDEFGHIJ",
      certificateCommonName: "Developer ID Application: Test Publisher (ABCDEFGHIJ)",
      certificateSha256: CERTIFICATE_SHA256,
      identifiers: {
        "chengfeng-videocut-installer-macos-arm64":
          "com.agentchengfeng.chengfeng-videocut.installer.arm64",
        "chengfeng-videocut-installer-macos-x64":
          "com.agentchengfeng.chengfeng-videocut.installer.x64",
      },
    },
    windows: {
      certificateSubject: "CN=Test Publisher, O=Test Publisher, C=US",
      certificateSha256: "a".repeat(64),
    },
    githubAttestation: {
      repository: "Agentchengfeng/chengfeng-videocut",
      signerRepository: "Agentchengfeng/chengfeng-release-builder",
      signerWorkflow:
        "Agentchengfeng/chengfeng-release-builder/.github/workflows/native-attest.yml",
      signerDigest: "2".repeat(40),
      denySelfHostedRunners: true,
    },
  };
}

async function fixture(): Promise<{ root: string; releaseDir: string; attestationDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-native-signing-test-"));
  temporaryRoots.push(root);
  const releaseDir = join(root, "release");
  const attestationDir = join(root, "attestations");
  await mkdir(releaseDir);
  await mkdir(attestationDir);
  for (const asset of [...MAC_ASSETS, WINDOWS_ASSET]) {
    await writeFile(join(releaseDir, asset), `installer:${asset}\n`, { mode: 0o755 });
    await writeFile(join(attestationDir, `${asset}.attestation.json`), "{\"forged\":true}\n");
  }
  return { root, releaseDir, attestationDir };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native signing policy", () => {
  test("keeps the checkout policy as a non-authoritative UNCONFIGURED template", async () => {
    const template = JSON.parse(await readFile(
      join(import.meta.dir, "../installer/native-release-signing-policy.json"),
      "utf8",
    ));
    expect(template.status).toBe("UNCONFIGURED");
    expect(template.githubAttestation.signerRepository).toBeNull();
    expect(template.githubAttestation.signerWorkflow).toBeNull();
    expect(template.githubAttestation.signerDigest).toBeNull();
  });

  test("keeps public staging blocked until real publisher identities are pinned", () => {
    expect(() => validateNativeSigningPolicy({ schemaVersion: 2, status: "UNCONFIGURED" }))
      .toThrow(/UNCONFIGURED/);
  });

  test("binds the Developer ID common name to the pinned Team ID", () => {
    const value = policy();
    value.macos.certificateCommonName = "Developer ID Application: Test Publisher (ZZZZZZZZZZ)";
    expect(() => validateNativeSigningPolicy(value)).toThrow(/does not match its Team ID/);
  });

  test("refuses to trust an attestation workflow from the source repository", () => {
    const value = policy();
    value.githubAttestation.signerRepository = value.githubAttestation.repository;
    value.githubAttestation.signerWorkflow =
      "Agentchengfeng/chengfeng-videocut/.github/workflows/native-release-signing.yml";
    expect(() => validateNativeSigningPolicy(value)).toThrow(/independent repository/);
  });

  test("treats repository identity as case-insensitive when enforcing independence", () => {
    const value = policy();
    value.githubAttestation.signerRepository = "agentchengfeng/CHENGFENG-VIDEOCUT";
    value.githubAttestation.signerWorkflow =
      "agentchengfeng/CHENGFENG-VIDEOCUT/.github/workflows/native-release-signing.yml";
    expect(() => validateNativeSigningPolicy(value)).toThrow(/independent repository/);
  });
});

describe("native signing workflow supply chain", () => {
  test("pins every external action to a reviewed immutable commit", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "../.github/workflows/native-release-signing.yml"),
      "utf8",
    );
    const useLines = workflow.split(/\r?\n/).filter((line) => /\buses:/.test(line));
    expect(useLines.length).toBeGreaterThan(0);
    for (const line of useLines) {
      const reference = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line)?.[1];
      expect(reference, `unparsed uses line: ${line}`).toBeDefined();
      expect(reference).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
    }
    expect(workflow).not.toMatch(/\buses:\s*[^\s#]+@v\d+/);
  });

  test("does not claim the source repository is its own attestation trust anchor", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "../.github/workflows/native-release-signing.yml"),
      "utf8",
    );
    expect(workflow).not.toContain("actions/attest@");
    expect(workflow).toContain("independent attestation trust anchor");
    expect(workflow).toContain("protected reusable workflow");
  });
});

describe("macOS native installer signature gate", () => {
  test("checks strict codesign, exact identity/certificate, hardened runtime, timestamp, and Gatekeeper", async () => {
    const { releaseDir } = await fixture();
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      const extract = args.find((arg) => arg.startsWith("--extract-certificates="));
      if (extract) {
        const prefix = extract.slice("--extract-certificates=".length);
        await writeFile(`${prefix}0`, CERTIFICATE);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/codesign" && args.includes("--display")) {
        const asset = args.at(-1)!;
        const identifier = asset.endsWith("arm64")
          ? "com.agentchengfeng.chengfeng-videocut.installer.arm64"
          : "com.agentchengfeng.chengfeng-videocut.installer.x64";
        return {
          status: 0,
          stdout: "",
          stderr: [
            `Identifier=${identifier}`,
            "TeamIdentifier=ABCDEFGHIJ",
            "Authority=Developer ID Application: Test Publisher (ABCDEFGHIJ)",
            "Authority=Developer ID Certification Authority",
            "flags=0x10000(runtime)",
            "Timestamp=Aug 7, 2026 at 12:00:00",
          ].join("\n"),
        };
      }
      if (command === "/usr/sbin/spctl") {
        return {
          status: 0,
          stdout: "",
          stderr: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n`,
        };
      }
      return { status: 0, stdout: "", stderr: "valid on disk\n" };
    };

    await verifyMacInstallerSignatures({ releaseDir, policy: policy(), runner, platform: "darwin" });
    expect(calls.filter((call) => call[0] === "/usr/sbin/spctl")).toHaveLength(2);
    expect(calls.filter((call) => call.some((arg) => arg.startsWith("--extract-certificates="))))
      .toHaveLength(2);
  });

  test("does not mistake a merely Developer ID-signed binary for a notarized one", async () => {
    const { releaseDir } = await fixture();
    const runner: CommandRunner = async (command, args) => {
      const extract = args.find((arg) => arg.startsWith("--extract-certificates="));
      if (extract) {
        await writeFile(`${extract.slice("--extract-certificates=".length)}0`, CERTIFICATE);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/codesign" && args.includes("--display")) {
        const identifier = args.at(-1)!.endsWith("arm64")
          ? "com.agentchengfeng.chengfeng-videocut.installer.arm64"
          : "com.agentchengfeng.chengfeng-videocut.installer.x64";
        return {
          status: 0,
          stdout: "",
          stderr: `Identifier=${identifier}\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Test Publisher (ABCDEFGHIJ)\nflags=0x10000(runtime)\nTimestamp=now\n`,
        };
      }
      if (command === "/usr/sbin/spctl") {
        return { status: 0, stdout: "", stderr: "accepted\nsource=Developer ID\n" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    await expect(verifyMacInstallerSignatures({ releaseDir, policy: policy(), runner, platform: "darwin" }))
      .rejects.toThrow(/Notarized Developer ID/);
  });
});

describe("Windows native installer signature gate", () => {
  test("requires a native valid Authenticode result bound to the pinned signer", async () => {
    const { root, releaseDir } = await fixture();
    const runner: CommandRunner = async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: "Valid",
        signatureType: "Authenticode",
        certificateSubject: policy().windows.certificateSubject,
        certificateSha256: policy().windows.certificateSha256,
        hasCodeSigningEku: true,
        hasTrustedTimestamp: true,
      }),
    });
    await verifyWindowsInstallerSignature({
      rootDir: root,
      releaseDir,
      policy: policy(),
      runner,
      platform: "win32",
    });
  });

  test("rejects a different otherwise-valid Authenticode signer", async () => {
    const { root, releaseDir } = await fixture();
    const runner: CommandRunner = async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: "Valid",
        signatureType: "Authenticode",
        certificateSubject: "CN=Other Publisher",
        certificateSha256: "b".repeat(64),
        hasCodeSigningEku: true,
        hasTrustedTimestamp: true,
      }),
    });
    await expect(verifyWindowsInstallerSignature({
      rootDir: root,
      releaseDir,
      policy: policy(),
      runner,
      platform: "win32",
    })).rejects.toThrow(/not pinned and valid/);
  });
});

describe("protected cross-platform attestation summary", () => {
  test("binds each exact installer to repo, signer workflow, tag, and GitHub-hosted runner", async () => {
    const { releaseDir, attestationDir } = await fixture();
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "[{\"verificationResult\":{}}]", stderr: "" };
    };
    await verifyInstallerAttestations({
      releaseDir,
      attestationDir,
      version: "0.5.0",
      sourceDigest: "1".repeat(40),
      policy: policy(),
      runner,
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.slice(0, 3)).toEqual(["gh", "attestation", "verify"]);
      expect(call).toContain("Agentchengfeng/chengfeng-release-builder/.github/workflows/native-attest.yml");
      expect(call).toContain("2".repeat(40));
      expect(call).toContain("refs/tags/v0.5.0");
      expect(call).toContain("1".repeat(40));
      expect(call).toContain("--deny-self-hosted-runners");
    }
  });

  test("never trusts an ordinary JSON sidecar when cryptographic verification fails", async () => {
    const { releaseDir, attestationDir } = await fixture();
    const runner: CommandRunner = async () => ({
      status: 1,
      stdout: "",
      stderr: "bundle signature could not be verified",
    });
    await expect(verifyInstallerAttestations({
      releaseDir,
      attestationDir,
      version: "0.5.0",
      sourceDigest: "1".repeat(40),
      policy: policy(),
      runner,
    })).rejects.toThrow(/bundle signature could not be verified/);
  });

  test("rejects using the source commit as the supposedly independent signer digest", async () => {
    const { releaseDir, attestationDir } = await fixture();
    const value = policy();
    await expect(verifyInstallerAttestations({
      releaseDir,
      attestationDir,
      version: "0.5.0",
      sourceDigest: value.githubAttestation.signerDigest,
      policy: value,
      runner: async () => ({ status: 0, stdout: "[]", stderr: "" }),
    })).rejects.toThrow(/independent from the source digest/);
  });
});
