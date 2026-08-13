import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/e2e-installed-product.ts");

function runScript(args: readonly string[], env: Record<string, string> = {}) {
  const childEnv = { ...process.env, ...env };
  if (!Object.hasOwn(env, "CHENGFENG_VIDEOCUT_INSTALLED_E2E")) {
    delete childEnv.CHENGFENG_VIDEOCUT_INSTALLED_E2E;
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: childEnv,
    encoding: "utf8",
  });
}

describe("installed-product E2E harness entrypoint", () => {
  it("keeps the harness source off user state, default service probes, and host Bun fallback", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const docs = readFileSync(join(ROOT, "docs/installed-product-e2e.md"), "utf8");
    for (const text of [source, docs]) {
      expect(text).not.toContain("127.0.0.1:5190");
      expect(text).not.toContain("port5190");
      expect(text).not.toContain(".chengfeng-videocut/projects");
      expect(text).not.toContain("command -v bun");
      expect(text).not.toContain("$HOME/.bun");
      expect(text).not.toContain("/opt/homebrew");
      expect(text).not.toContain("/usr/local/bin/bun");
    }
    expect(source).toContain("cleanup-fatal");
    expect(source).toContain("endpointAlive");
  });

  it("defaults to a JSON skip without loading the Product CLI graph", () => {
    const result = runScript(["--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      status: "SKIP",
      command: "installed-product-e2e",
      optIn: "CHENGFENG_VIDEOCUT_INSTALLED_E2E",
    });
  });

  it("rejects an opt-in root outside the system temp directory before building", () => {
    const outsideTemp = join(dirname(tmpdir()), "chengfeng-videocut-installed-e2e-not-temp");
    const result = runScript([
      "--output-root",
      outsideTemp,
      "--json",
    ], { CHENGFENG_VIDEOCUT_INSTALLED_E2E: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--output-root must live under the system temp directory");
    expect(result.stderr).not.toContain("package:build");
  });

  it("treats cleanup survivors as fatal", () => {
    const result = runScript(["--json"], {
      CHENGFENG_VIDEOCUT_INSTALLED_E2E: "1",
      CHENGFENG_VIDEOCUT_INSTALLED_E2E_SELFTEST_SURVIVOR: "1",
    });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      stages: Array<{ name: string; status: string }>;
      cleanup: { childAlive: number[]; runRootRemoved: boolean };
    };
    expect(payload.status).toBe("FAIL");
    expect(payload.stages).toContainEqual(expect.objectContaining({
      name: "cleanup-fatal",
      status: "FAIL",
    }));
    expect(payload.cleanup.childAlive.length).toBeGreaterThan(0);
    expect(payload.cleanup.runRootRemoved).toBe(true);
  });
});
