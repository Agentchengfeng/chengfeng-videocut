import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("local development authorization script", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  const sourceRoot = join(import.meta.dir, "../../..");
  const script = join(sourceRoot, "scripts/authorize-local-development.ts");

  async function fakeManagedRoot(program: string): Promise<{ home: string; marker: string }> {
    const temporary = await mkdtemp(join(tmpdir(), "videocut-authorize-script-"));
    cleanup.push(temporary);
    const home = join(temporary, "home");
    const root = join(home, ".chengfeng-videocut");
    const tools = join(root, "tools");
    const version = join(tools, "0.5.2");
    const managedBun = join(version, "bun");
    const marker = join(temporary, "managed-child.txt");
    await mkdir(version, { recursive: true });
    await writeFile(managedBun, program);
    await chmod(managedBun, 0o755);
    await writeFile(join(version, "resources-manifest.json"), `${JSON.stringify({
      schemaVersion: 4,
      product: "chengfeng-videocut-managed-tools",
      executables: { bun: "bun" },
    })}\n`);
    await symlink("0.5.2", join(tools, "current"));
    return { home, marker };
  }

  it("loads from a clean source checkout without workspace package links", () => {
    const result = Bun.spawnSync([process.execPath, script, "--help"], {
      cwd: sourceRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(2);
    expect(stderr).toContain("Usage: bun scripts/authorize-local-development.ts");
    expect(stderr).not.toContain("Cannot find module");
  });

  it("re-execs the exact managed child and preserves a failed child exit", async () => {
    if (process.platform === "win32") return;
    const fixture = await fakeManagedRoot(
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$VIDEOCUT_AUTH_TEST_MARKER"\nexit 23\n',
    );
    const result = Bun.spawnSync([
      process.execPath,
      script,
      "--acknowledge-unverified-local-runtime",
    ], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        HOME: fixture.home,
        VIDEOCUT_AUTH_TEST_MARKER: fixture.marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(23);
    expect(await Bun.file(fixture.marker).text()).toContain("--acknowledge-unverified-local-runtime");
  });

  it("rejects a managed launcher that returns to the source Bun instead of looping", async () => {
    if (process.platform === "win32") return;
    const fixture = await fakeManagedRoot(
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
    );
    const result = Bun.spawnSync([
      process.execPath,
      script,
      "--acknowledge-unverified-local-runtime",
    ], {
      cwd: sourceRoot,
      env: { ...process.env, HOME: fixture.home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("managed Bun re-exec loop rejected");
  });
});
