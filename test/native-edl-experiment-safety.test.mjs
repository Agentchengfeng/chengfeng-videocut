import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const generator = join(repoRoot, "scripts/experiments/generate-native-hyperframes-edl.mjs");

function runGenerator(sourceProject, outputDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [generator, "--source-project", sourceProject, "--output-dir", outputDir, "--force"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("native EDL experiment refuses destructive overlapping output paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-edl-safety-"));
  try {
    const source = join(root, "source");
    const outputInsideSource = join(source, "generated");
    await mkdir(outputInsideSource, { recursive: true });
    const marker = join(outputInsideSource, "keep.txt");
    await writeFile(marker, "must survive\n");

    const result = await runGenerator(source, outputInsideSource);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /independent directory/);
    assert.equal(await readFile(marker, "utf8"), "must survive\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
