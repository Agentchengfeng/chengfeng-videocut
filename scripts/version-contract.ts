import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HELP_TEXT, PRODUCT_VERSION } from "../apps/cli/src/output";

const defaultRootDir = resolve(import.meta.dir, "..");

const packageManifestPaths = [
  "package.json",
  "apps/cli/package.json",
  "apps/studio/package.json",
  "packages/contracts/package.json",
  "packages/core/package.json",
  "packages/hyperframes-adapter/package.json",
  "packages/koubo-adapter/package.json",
] as const;

const lockWorkspacePaths = packageManifestPaths.slice(1).map((path) =>
  path.slice(0, -"/package.json".length),
);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function captureVersion(content: string, pattern: RegExp, label: string): string {
  const match = content.match(pattern);
  check(match?.[1], `${label} does not declare a version`);
  return match[1];
}

function lockWorkspaceBlock(lockfile: string, workspacePath: string): string {
  const marker = `    "${workspacePath}": {`;
  const start = lockfile.indexOf(marker);
  check(start >= 0, `bun.lock is missing workspace ${workspacePath}`);
  const end = lockfile.indexOf("\n    },", start);
  check(end >= 0, `bun.lock has an invalid workspace block for ${workspacePath}`);
  return lockfile.slice(start, end);
}

export async function checkVersionContract(rootDir = defaultRootDir): Promise<string> {
  check(
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(PRODUCT_VERSION),
    `Invalid PRODUCT_VERSION: ${PRODUCT_VERSION}`,
  );

  for (const path of packageManifestPaths) {
    const manifest = JSON.parse(await readFile(join(rootDir, path), "utf8")) as {
      version?: string;
    };
    check(
      manifest.version === PRODUCT_VERSION,
      `${path} version ${String(manifest.version)} does not match ${PRODUCT_VERSION}`,
    );
  }

  const installer = await readFile(join(rootDir, "install.sh"), "utf8");
  check(
    captureVersion(installer, /^VERSION="([^"]+)"$/m, "install.sh") === PRODUCT_VERSION,
    `install.sh version does not match ${PRODUCT_VERSION}`,
  );
  check(
    installer.includes("releases/download/v$VERSION") &&
      !installer.includes("releases/latest/download"),
    "install.sh must download the exact versioned GitHub Release",
  );

  const nodeInstaller = await readFile(join(rootDir, "install.cjs"), "utf8");
  check(
    captureVersion(nodeInstaller, /^const VERSION = "([^"]+)";$/m, "install.cjs") === PRODUCT_VERSION,
    `install.cjs version does not match ${PRODUCT_VERSION}`,
  );
  check(
    nodeInstaller.includes("releases/download/v${VERSION}") &&
      !nodeInstaller.includes("releases/latest/download"),
    "install.cjs must download the exact versioned GitHub Release",
  );

  const citation = await readFile(join(rootDir, "CITATION.cff"), "utf8");
  check(
    captureVersion(citation, /^version:\s*([^\s]+)$/m, "CITATION.cff") === PRODUCT_VERSION,
    `CITATION.cff version does not match ${PRODUCT_VERSION}`,
  );

  const capabilities = JSON.parse(
    await readFile(
      join(rootDir, "apps/studio/public/chengfeng-videocut-capabilities.json"),
      "utf8",
    ),
  ) as { studioVersion?: string };
  check(
    capabilities.studioVersion === PRODUCT_VERSION,
    `Studio capability version ${String(capabilities.studioVersion)} does not match ${PRODUCT_VERSION}`,
  );

  check(
    HELP_TEXT.startsWith(`chengfeng-videocut ${PRODUCT_VERSION}\n`),
    `CLI help version does not match ${PRODUCT_VERSION}`,
  );

  const lockfile = await readFile(join(rootDir, "bun.lock"), "utf8");
  for (const workspacePath of lockWorkspacePaths) {
    const block = lockWorkspaceBlock(lockfile, workspacePath);
    check(
      captureVersion(block, /"version":\s*"([^"]+)"/, `bun.lock ${workspacePath}`) ===
        PRODUCT_VERSION,
      `bun.lock workspace ${workspacePath} does not match ${PRODUCT_VERSION}`,
    );
  }

  return PRODUCT_VERSION;
}
