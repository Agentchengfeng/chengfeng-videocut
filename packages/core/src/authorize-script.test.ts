import { describe, expect, it } from "bun:test";
import { join } from "node:path";

describe("local development authorization script", () => {
  it("loads from a clean source checkout without workspace package links", () => {
    const script = join(import.meta.dir, "../../../scripts/authorize-local-development.ts");
    const result = Bun.spawnSync([process.execPath, script, "--help"], {
      cwd: join(import.meta.dir, "../../.."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(2);
    expect(stderr).toContain("Usage: bun scripts/authorize-local-development.ts");
    expect(stderr).not.toContain("Cannot find module");
  });
});
