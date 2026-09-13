import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const studioRoot = join(repoRoot, "apps/studio");

function discoveredTestFiles() {
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--json"],
    { cwd: studioRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).map(({ file }) => file.replaceAll("\\", "/"));
}

test("Studio does not collect immutable upstream tests", () => {
  const files = discoveredTestFiles();
  const upstream = files.filter((file) => file.includes("/hf-upstream-0.7.60/"));
  const boundary = files.filter((file) => file.endsWith("/TimelineForkBoundary.test.ts"));

  assert.equal(upstream.length, 0, "upstream audit snapshot must stay out of Product test collection");
  assert.deepEqual(boundary.length, 1, "Product-owned boundary test must remain collected");
});
