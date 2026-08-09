#!/usr/bin/env bun
// This is a source-only repository tool. Import the source entry point directly
// so it works in a clean worktree before workspace package symlinks exist.
import { authorizeLocalDevelopmentRuntime } from "../packages/core/src/node.ts";

const ACKNOWLEDGE = "--acknowledge-unverified-local-runtime";

if (process.argv.length !== 3 || process.argv[2] !== ACKNOWLEDGE) {
  console.error(
    `Usage: bun scripts/authorize-local-development.ts ${ACKNOWLEDGE}\n` +
    "This source-only command authorizes the exact installed local-test-only Runtime identity. " +
    "It does not change release, license, signing or npm publication status.",
  );
  process.exit(2);
}

try {
  const result = await authorizeLocalDevelopmentRuntime({ acknowledged: true });
  console.log(JSON.stringify({
    ok: true,
    path: result.path,
    runtimeVersion: result.authorization.runtime.version,
    toolsVersion: result.authorization.tools.version,
    developmentMode: true,
    releaseReady: false,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
