import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  requiredReleaseAssetNames,
  verifyNativeReleaseInputs,
  verifyReleaseAssetManifest,
  writeReleaseChecksums,
} from "./release-assets";
import {
  nativeInstallerAssets,
  verifyNativeReleaseSecurity,
} from "./native-release-signatures";

const moduleRootDir = resolve(import.meta.dir, "..");
export type StageNativeReleaseTestHooks = {
  afterSnapshot?: (context: {
    sourceDir: string;
    snapshotReleaseDir: string;
    snapshotAttestationDir?: string;
  }) => Promise<void>;
};

export type StageNativeReleaseOptions = {
  rootDir?: string;
  sourceDir?: string;
  destinationDir?: string;
  attestationDir?: string;
  testHooks?: StageNativeReleaseTestHooks;
};

type FileState = Awaited<ReturnType<typeof stableFileState>>;

async function stableFileState(path: string) {
  return lstat(path, { bigint: true });
}

function sameFileState(left: FileState, right: FileState): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function copyStableSingleLinkFile(
  source: string,
  destination: string,
  label: string,
  options: { requireReadOnly?: boolean } = {},
): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error(`${label} must be a single-link regular file`);
    }
    if (options.requireReadOnly && (before.mode & 0o222n) !== 0n) {
      throw new Error(`${label} must be mounted read-only by the external release orchestrator`);
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} is too large to snapshot safely`);
    }
    const mode = Number(before.mode & 0o777n);
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) throw new Error(`${label} snapshot write made no progress`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.chmod(mode);
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameFileState(before, after) || BigInt(position) !== before.size) {
      throw new Error(`${label} changed while its immutable snapshot was being created`);
    }
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

async function canonicalInputDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  return realpath(path);
}

async function destinationState(path: string): Promise<FileState | null> {
  try {
    return await stableFileState(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertDestinationUnchanged(path: string, expected: FileState | null): Promise<void> {
  const actual = await destinationState(path);
  if (expected === null ? actual !== null : actual === null || !sameFileState(expected, actual)) {
    throw new Error("Native release destination changed while staging; refusing to replace it");
  }
}

async function cleanSnapshot(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function containsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

export async function stageNativeRelease(options: StageNativeReleaseOptions = {}): Promise<{
  destinationDir: string;
  assetCount: number;
  checksumPath: string;
}> {
  const rootDir = resolve(options.rootDir ?? moduleRootDir);
  const sourceDir = resolve(
    options.sourceDir ?? process.env.CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE ?? join(rootDir, "release"),
  );
  const destinationDir = resolve(
    options.destinationDir ??
      process.env.CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR ??
      join(rootDir, "release-native"),
  );
  const defaultDestination = join(rootDir, "release-native");
  const attestationInput = options.attestationDir ??
    process.env.CHENGFENG_VIDEOCUT_NATIVE_ATTESTATION_DIR;
  const trustPolicyInput = process.env.CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY;
  const trustPolicySha256 = process.env.CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY_SHA256;
  const { version } = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
    version: string;
  };

  if (process.env.CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE === "1") {
    throw new Error("LOCAL_TOOLS_FIXTURE assets can never be staged for a native release");
  }

  const canonicalSource = await canonicalInputDirectory(sourceDir, "Native asset source");
  const canonicalRoot = await realpath(rootDir);
  const home = resolve(homedir());
  for (const forbidden of [parse(destinationDir).root, home, rootDir]) {
    if (
      forbidden && (
        destinationDir === forbidden ||
        forbidden.startsWith(`${destinationDir}${sep}`)
      )
    ) throw new Error(`Refusing broad native release destination: ${destinationDir}`);
  }

  const initialDestination = await destinationState(destinationDir);
  if (initialDestination && (!initialDestination.isDirectory() || initialDestination.isSymbolicLink())) {
    throw new Error("Native release destination must be a non-symlink directory");
  }
  const canonicalDestinationParent = await realpath(dirname(destinationDir));
  const canonicalDestination = initialDestination
    ? await realpath(destinationDir)
    : join(canonicalDestinationParent, basename(destinationDir));
  if (
    canonicalSource === canonicalDestination ||
    canonicalSource.startsWith(`${canonicalDestination}${sep}`) ||
    canonicalDestination.startsWith(`${canonicalSource}${sep}`)
  ) throw new Error("Native release source and destination must be disjoint");

  let canonicalTrustPolicy: string | undefined;
  if (trustPolicyInput || trustPolicySha256) {
    if (!trustPolicyInput || !trustPolicySha256) {
      throw new Error("Out-of-band native trust policy path and SHA256 must be supplied together");
    }
    if (!isAbsolute(trustPolicyInput) || !/^[a-f0-9]{64}$/.test(trustPolicySha256)) {
      throw new Error("Out-of-band native trust policy requires an absolute path and exact lowercase SHA256");
    }
    canonicalTrustPolicy = await realpath(trustPolicyInput);
    if (
      containsPath(canonicalRoot, canonicalTrustPolicy) ||
      containsPath(canonicalSource, canonicalTrustPolicy) ||
      containsPath(canonicalDestination, canonicalTrustPolicy)
    ) {
      throw new Error("Out-of-band native trust policy must live outside the release checkout, source, and destination");
    }
  }

  const requiredAssets = requiredReleaseAssetNames(version);
  const snapshotRoot = await mkdtemp(
    join(canonicalDestinationParent, `.${basename(destinationDir)}.snapshot-`),
  );
  const snapshotReleaseDir = join(snapshotRoot, "release");
  const snapshotPolicyPath = canonicalTrustPolicy
    ? join(snapshotRoot, "native-trust-policy.json")
    : undefined;
  const snapshotAttestationDir = attestationInput
    ? join(snapshotRoot, "attestations")
    : undefined;
  let previousDestination: string | undefined;
  let destinationBackedUp = false;
  let published = false;

  try {
    await chmod(snapshotRoot, 0o700);
    await mkdir(snapshotReleaseDir, { mode: 0o700 });
    for (const name of requiredAssets) {
      await copyStableSingleLinkFile(
        join(canonicalSource, name),
        join(snapshotReleaseDir, name),
        `Native release asset ${name}`,
      );
    }
    if (canonicalTrustPolicy && snapshotPolicyPath) {
      await copyStableSingleLinkFile(
        canonicalTrustPolicy,
        snapshotPolicyPath,
        "Out-of-band native trust policy",
        { requireReadOnly: true },
      );
      const actualPolicySha256 = createHash("sha256")
        .update(await readFile(snapshotPolicyPath))
        .digest("hex");
      if (actualPolicySha256 !== trustPolicySha256) {
        throw new Error("Out-of-band native trust policy SHA256 does not match the protected release input");
      }
    }

    if (attestationInput && snapshotAttestationDir) {
      const canonicalAttestationSource = await canonicalInputDirectory(
        resolve(attestationInput),
        "Native attestation source",
      );
      await mkdir(snapshotAttestationDir, { mode: 0o700 });
      for (const installer of nativeInstallerAssets) {
        const bundle = `${installer}.attestation.json`;
        await copyStableSingleLinkFile(
          join(canonicalAttestationSource, bundle),
          join(snapshotAttestationDir, bundle),
          `Native attestation bundle ${bundle}`,
        );
      }
    }

    await options.testHooks?.afterSnapshot?.({
      sourceDir: canonicalSource,
      snapshotReleaseDir,
      snapshotAttestationDir,
    });

    // Every content, signature, and attestation check below reads only the
    // private snapshot. The mutable input paths are never opened again.
    await verifyNativeReleaseInputs({ releaseDir: snapshotReleaseDir, version });
    if (!snapshotPolicyPath) {
      throw new Error(
        "Out-of-band native trust policy is required; the checkout policy is only an UNCONFIGURED template",
      );
    }
    await verifyNativeReleaseSecurity({
      rootDir,
      policyPath: snapshotPolicyPath,
      releaseDir: snapshotReleaseDir,
      version,
      attestationDir: snapshotAttestationDir,
    });
    const result = await writeReleaseChecksums({
      rootDir,
      releaseDir: snapshotReleaseDir,
      version,
    });
    await verifyReleaseAssetManifest({ releaseDir: snapshotReleaseDir, version });

    // Preserve the prior contract: a custom target may be supplied only when
    // it is absent or empty. This check remains after validation so malformed
    // source material can never trigger destination handling.
    if (initialDestination && destinationDir !== defaultDestination) {
      const entries = await readdir(canonicalDestination);
      if (entries.length > 0) throw new Error("Custom native release destination must be empty");
    }
    await assertDestinationUnchanged(canonicalDestination, initialDestination);
    await chmod(snapshotReleaseDir, 0o755);

    if (initialDestination) {
      previousDestination = join(snapshotRoot, "previous-destination");
      await rename(canonicalDestination, previousDestination);
      destinationBackedUp = true;
    }
    try {
      // snapshotRoot is created in the destination's canonical parent, so the
      // final rename is one same-filesystem atomic publication step.
      await rename(snapshotReleaseDir, canonicalDestination);
      published = true;
    } catch (publishError) {
      if (destinationBackedUp && previousDestination) {
        try {
          await rename(previousDestination, canonicalDestination);
          destinationBackedUp = false;
        } catch (rollbackError) {
          throw new AggregateError(
            [publishError, rollbackError],
            `Native release publication failed and the previous destination remains at ${previousDestination}`,
          );
        }
      }
      throw publishError;
    }

    console.log(
      `Staged ${result.lines.length} assets and ${join(canonicalDestination, basename(result.checksumPath))}`,
    );
    return {
      destinationDir: canonicalDestination,
      assetCount: result.lines.length,
      checksumPath: join(canonicalDestination, basename(result.checksumPath)),
    };
  } catch (error) {
    if (destinationBackedUp && previousDestination && !published) {
      try {
        await rename(previousDestination, canonicalDestination);
        destinationBackedUp = false;
      } catch (rollbackError) {
        // Do not clean snapshotRoot in this exceptional case: it contains the
        // only known copy of the user's previous destination.
        throw new AggregateError(
          [error, rollbackError],
          `Native release staging failed and the previous destination remains at ${previousDestination}`,
        );
      }
    }
    await cleanSnapshot(snapshotRoot).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], "Native release staging and snapshot cleanup failed");
    });
    throw error;
  } finally {
    if (published) {
      // Publication is already committed. Cleanup cannot be allowed to turn a
      // successful atomic replacement into a reported failed release.
      await cleanSnapshot(snapshotRoot).catch((cleanupError) => {
        console.warn(`Warning: native release snapshot cleanup failed: ${cleanupError}`);
      });
    }
  }
}

if (import.meta.main) {
  await stageNativeRelease();
}
