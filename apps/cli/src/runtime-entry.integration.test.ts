import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "entry-cli-"));
  roots.push(home);
  const data = join(home, ".chengfeng-videocut");
  const launcher = join(data, "bin", process.platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
  await mkdir(join(data, "bin"), { recursive: true });
  await writeFile(launcher, "not executed", { mode: 0o755 });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    CHENGFENG_VIDEOCUT_HOME: data, CHENGFENG_VIDEOCUT_DATA_DIR: data,
    CHENGFENG_VIDEOCUT_EXECUTABLE: launcher, CHENGFENG_VIDEOCUT_SERVICE: "" };
  return { home, data, launcher, env };
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

describe("Runtime entry real CLI regression (isolated roots)", () => {
  it("reports the selected missing entry without claiming global uninstall or creating it", async () => {
    const f = await fixture();
    const missing = join(f.home, "dev");
    const result = await run(["doctor", "--json"], { ...f.env, CHENGFENG_VIDEOCUT_HOME: missing,
      CHENGFENG_VIDEOCUT_DATA_DIR: missing, CHENGFENG_VIDEOCUT_EXECUTABLE: join(missing, "bin", process.platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut") });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.runtimeEntry).toMatchObject({ scope: "selected-runtime-only", state: "target_missing", ok: false });
    // Bun may populate its own transpiler cache under this isolated HOME;
    // the product must not create the missing target or a service definition.
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(f.home, "Library", "LaunchAgents"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.launcher, "utf8")).toBe("not executed");
  });
  it("fails doctor when HOME and DATA_DIR select different installations", async () => {
    const f = await fixture();
    const result = await run(["doctor", "--json"], { ...f.env, CHENGFENG_VIDEOCUT_HOME: join(f.home, "old") });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.runtimeEntry).toMatchObject({ state: "entry_mismatch", ok: false });
  });
  it.skipIf(!["darwin", "win32"].includes(process.platform))("refuses dev service ensure before any global service call", async () => {
    const f = await fixture();
    const dev = join(f.home, "dev");
    const result = await run(["service", "ensure", "--json"], { ...f.env, CHENGFENG_VIDEOCUT_HOME: dev,
      CHENGFENG_VIDEOCUT_DATA_DIR: dev, CHENGFENG_VIDEOCUT_EXECUTABLE: join(dev, "bin", process.platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut") });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout).error.code).toBe("service_target_conflict");
    await expect(lstat(dev)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(f.home, "Library", "LaunchAgents"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reports a foreign-host tombstone and preserves its bytes on startup refusal", async () => {
    const f = await fixture();
    const tombstone = join(f.data, "jobs", `.runtime-owner.json.tombstone.${randomUUID()}`);
    await mkdir(tombstone, { recursive: true });
    const owner = JSON.stringify({ version: 1, pid: 2000000000, token: randomUUID(), hostname: "foreign-host-test.invalid", acquiredAt: new Date().toISOString() });
    await writeFile(join(tombstone, "owner.json"), owner);
    const result = await run(["start", "--port", "0", "--data-dir", f.data, "--projects-dir", join(f.home, "projects"), "--json"], f.env);
    expect(result.exitCode).toBe(10);
    const error = JSON.parse(result.stdout).error;
    expect(error.code).toBe("job_runtime_conflict");
    expect(error.details).toMatchObject({ reason: "hostname_mismatch", recoveryRequired: true });
    expect(await readFile(join(tombstone, "owner.json"), "utf8")).toBe(owner);
    expect(result.stdout).not.toContain(JSON.parse(owner).token);
  });
});
