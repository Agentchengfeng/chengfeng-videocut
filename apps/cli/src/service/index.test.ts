import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderStudioLaunchAgent,
  runStudioServiceCommand,
  studioServicePaths,
  type CommandRunner,
  type StudioServiceDependencies,
} from "./index";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "videocut-service-"));
  cleanup.push(home);
  const paths = studioServicePaths(home);
  await mkdir(join(paths.dataDir, "bin"), { recursive: true });
  await writeFile(paths.launcherPath, "#!/bin/sh\nexit 0\n");
  await chmod(paths.launcherPath, 0o755);
  return home;
}

function fakeRuntime(homeDir: string, owner: "none" | "managed" | "foreground" | "unknown" = "none") {
  const state = {
    owner,
    loaded: false,
    enabled: false,
    pid: null as number | null,
    nextPid: 4100,
    deferKickstart: false,
    pendingPid: null as number | null,
    healthHung: false,
    operations: [] as string[],
  };
  const runCommand: CommandRunner = async (_executable, args) => {
    state.operations.push(args.join(" "));
    const [operation] = args;
    if (operation === "print") {
      return state.loaded
        ? { code: 0, stdout: state.pid ? `state = running\n\tpid = ${state.pid}\n` : "state = waiting\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "Could not find service" };
    }
    if (operation === "enable") state.enabled = true;
    if (operation === "disable") state.enabled = false;
    if (operation === "bootstrap") {
      state.loaded = true;
      state.pid = ++state.nextPid;
      state.owner = "managed";
      state.healthHung = false;
    }
    if (operation === "bootout") {
      const wasLoaded = state.loaded;
      state.loaded = false;
      state.pid = null;
      if (wasLoaded) state.owner = "none";
    }
    if (operation === "kickstart") {
      state.loaded = true;
      const nextPid = ++state.nextPid;
      if (state.deferKickstart) {
        state.pendingPid = nextPid;
      } else {
        state.pid = nextPid;
        state.owner = "managed";
        state.healthHung = false;
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (state.healthHung) throw new TypeError("health timeout");
    if (state.owner === "none") throw new TypeError("connection refused");
    if (url.endsWith("chengfeng-videocut-capabilities.json")) {
      return Response.json({
        schemaVersion: 1,
        product: state.owner === "unknown" ? "not-videocut" : "chengfeng-videocut",
        studioVersion: "0.2.0",
      });
    }
    if (state.owner === "unknown") {
      return Response.json({ ok: true, product: "another-product" });
    }
    return Response.json({
      schemaVersion: 1,
      ok: true,
      product: "chengfeng-videocut",
      productVersion: "0.2.0",
      pid: state.owner === "managed" || (state.owner === "foreground" && state.loaded)
        ? state.pid
        : 9999,
      runtimeMode: state.owner === "managed" ? "launchd" : "foreground",
      studioBuildId: "test-build",
    });
  };
  const dependencies: StudioServiceDependencies = {
    platform: "darwin",
    homeDir,
    uid: 501,
    pid: 9001,
    isProcessAlive: (pid) => pid === 9001,
    runCommand,
    fetch: fakeFetch as typeof globalThis.fetch,
    isPortOccupied: async () => state.owner !== "none",
    getPortOwnerPid: async () => {
      if (state.owner === "none") return null;
      if (state.loaded && state.owner !== "unknown") return state.pid;
      return 9999;
    },
    sleep: async () => {
      if (state.pendingPid !== null) {
        state.pid = state.pendingPid;
        state.pendingPid = null;
        state.owner = "managed";
        state.healthHung = false;
      }
    },
    readyTimeoutMs: 100,
    lockTimeoutMs: 100,
  };
  return { state, dependencies };
}

describe("Studio user service", () => {
  it("renders a stable, throttled LaunchAgent contract without a source path", async () => {
    const home = await testHome();
    const paths = studioServicePaths(home);
    const plist = renderStudioLaunchAgent(paths);
    expect(plist).toContain("com.chengfeng.videocut.studio");
    expect(plist).toContain(paths.launcherPath);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("CHENGFENG_VIDEOCUT_SERVICE");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).not.toContain(`/${"Volumes"}/`);
  });

  it("keeps the macOS user home separate from a custom Runtime root and launcher", async () => {
    const home = await testHome();
    const runtimeRoot = join(home, "custom-runtime");
    const launcherPath = join(runtimeRoot, "bin", "chengfeng-videocut");
    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await writeFile(launcherPath, "#!/bin/sh\nexit 0\n");
    await chmod(launcherPath, 0o755);
    const { dependencies } = fakeRuntime(home);

    const result = await runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      dataDir: runtimeRoot,
      launcherPath,
    });

    expect(result.ready).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.paths.homeDir).toBe(home);
    expect(result.paths.dataDir).toBe(runtimeRoot);
    expect(result.paths.launcherPath).toBe(launcherPath);
    expect(result.paths.plistPath).toBe(join(
      home,
      "Library",
      "LaunchAgents",
      "com.chengfeng.videocut.studio.plist",
    ));
    const plist = await readFile(result.paths.plistPath, "utf8");
    expect(plist).toContain(launcherPath);
    expect(plist).toContain(runtimeRoot);
  });

  it("uses an explicit managed install root while keeping the user LaunchAgents directory", async () => {
    const home = await testHome();
    const { dependencies } = fakeRuntime(home);
    const customRoot = join(home, "custom-videocut-home");
    const customPaths = studioServicePaths(home, customRoot);
    await mkdir(join(customRoot, "bin"), { recursive: true });
    await writeFile(customPaths.launcherPath, "#!/bin/sh\nexit 0\n");
    await chmod(customPaths.launcherPath, 0o755);

    const result = await runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      dataDir: customRoot,
    });

    expect(result.paths.dataDir).toBe(customRoot);
    expect(result.paths.plistPath).toBe(join(home, "Library", "LaunchAgents", "com.chengfeng.videocut.studio.plist"));
    expect(await readFile(result.paths.plistPath, "utf8")).toContain(customPaths.launcherPath);
  });

  it("installs once and makes concurrent ensure calls converge on one PID", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    const [first, second] = await Promise.all([
      runStudioServiceCommand("ensure", {}, dependencies),
      runStudioServiceCommand("ensure", {}, dependencies),
    ]);

    expect(first.ready).toBe(true);
    expect(first.configured).toBe(true);
    expect(first.healthy).toBe(true);
    expect(first.runtimeMode).toBe("launchd");
    expect(first.productVersion).toBe("0.2.0");
    expect(first.studioBuildId).toBe("test-build");
    expect(first).toMatchObject({
      healthy: true,
      runtimeMode: "launchd",
      productVersion: "0.2.0",
    });
    expect(second.ready).toBe(true);
    expect(first.pid).toBe(second.pid);
    expect(state.operations.filter((operation) => operation.startsWith("bootstrap "))).toHaveLength(1);
    expect(await readFile(studioServicePaths(home).plistPath, "utf8"))
      .toContain(studioServicePaths(home).launcherPath);
    expect((await readdir(join(home, "Library", "LaunchAgents")))
      .filter((name) => name.includes(".tmp"))).toEqual([]);

    const operations = state.operations.length;
    const third = await runStudioServiceCommand("ensure", {}, dependencies);
    expect(third.changed).toBe(false);
    expect(third.pid).toBe(first.pid);
    expect(state.operations.slice(operations).some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("reconciles a stale or damaged LaunchAgent before starting", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    const paths = studioServicePaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(paths.plistPath, "STALE-PLIST\n");

    const result = await runStudioServiceCommand("ensure", {}, dependencies);

    expect(result.ready).toBe(true);
    expect(await readFile(paths.plistPath, "utf8")).toBe(renderStudioLaunchAgent(paths));
    expect(state.operations.some((operation) => operation.startsWith("bootstrap "))).toBe(true);
  });

  it("reconciles a loaded stale LaunchAgent whose PID still owns Product health", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home, "managed");
    const paths = studioServicePaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(paths.plistPath, "STALE-PLIST-WITHOUT-SERVICE-MODE\n");
    state.loaded = true;
    state.pid = 5151;

    const result = await runStudioServiceCommand("ensure", {}, dependencies);

    expect(result.ready).toBe(true);
    expect(result.runtimeMode).toBe("launchd");
    expect(result.pid).not.toBe(5151);
    expect(await readFile(paths.plistPath, "utf8")).toBe(renderStudioLaunchAgent(paths));
  });

  it("fails closed when a loaded job owns the port but health cannot prove Product identity", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home, "managed");
    const paths = studioServicePaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(paths.plistPath, renderStudioLaunchAgent(paths));
    state.loaded = true;
    state.pid = 5152;
    state.healthHung = true;

    const operationsBefore = state.operations.length;
    await expect(runStudioServiceCommand("ensure", {}, dependencies))
      .rejects.toMatchObject({ code: "service_port_conflict" });

    expect(state.pid).toBe(5152);
    expect(state.operations.slice(operationsBefore).some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("waits for launchd to publish the replacement PID before restart returns", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    const installed = await runStudioServiceCommand("ensure", {}, dependencies);
    const previousPid = installed.pid;
    state.deferKickstart = true;

    const restarted = await runStudioServiceCommand("restart", {}, dependencies);

    expect(previousPid).not.toBeNull();
    expect(restarted.ready).toBe(true);
    expect(restarted.pid).not.toBe(previousPid);
    expect(restarted.pid).toBe(state.pid);
    expect(state.pendingPid).toBeNull();
    expect(state.operations.some((operation) => operation.startsWith("kickstart -k "))).toBe(true);
  });

  it("recreates deleted log directories before starting an installed service", async () => {
    const home = await testHome();
    const { dependencies } = fakeRuntime(home);
    const paths = studioServicePaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(paths.plistPath, renderStudioLaunchAgent(paths));
    await rm(join(paths.dataDir, "logs"), { recursive: true, force: true });

    const result = await runStudioServiceCommand("start", {}, dependencies);

    expect(result.ready).toBe(true);
    expect((await readdir(paths.dataDir)).includes("logs")).toBe(true);
  });

  it("stop disables and boots out; start re-enables the installed service", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    await runStudioServiceCommand("ensure", {}, dependencies);
    const stopped = await runStudioServiceCommand("stop", {}, dependencies);
    expect(stopped.loaded).toBe(false);
    expect(stopped.ready).toBe(false);
    expect(state.enabled).toBe(false);
    expect(state.operations.some((operation) => operation.startsWith("disable "))).toBe(true);
    expect(state.operations.some((operation) => operation.startsWith("bootout "))).toBe(true);

    const started = await runStudioServiceCommand("start", {}, dependencies);
    expect(started.ready).toBe(true);
    expect(state.enabled).toBe(true);
  });

  it("fails closed when port 5190 is owned by foreground Runtime", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home, "foreground");
    await expect(runStudioServiceCommand("ensure", {}, dependencies))
      .rejects.toMatchObject({ code: "service_port_conflict" });
    expect(state.owner).toBe("foreground");
    expect(state.operations.some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("fails closed before launchctl when an unknown TCP service has no valid health", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home, "unknown");
    const operationsBefore = state.operations.length;
    await expect(runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      fetch: (async () => { throw new TypeError("invalid HTTP service"); }) as unknown as typeof globalThis.fetch,
      isPortOccupied: async () => true,
    })).rejects.toMatchObject({ code: "service_port_conflict" });
    expect(state.operations.slice(operationsBefore).some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("does not trust a loaded label when another process owns the Studio port", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home, "unknown");
    state.loaded = true;
    state.pid = 5153;
    const operationsBefore = state.operations.length;

    await expect(runStudioServiceCommand("ensure", {}, dependencies))
      .rejects.toMatchObject({ code: "service_port_conflict" });

    expect(state.operations.slice(operationsBefore).some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("fails closed on an HTTP response that is not Product health", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home, "unknown");
    await expect(runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      fetch: (async () => new Response("not found", { status: 404 })) as unknown as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: "service_port_conflict" });
    expect(state.operations.some((operation) => operation.startsWith("bootstrap "))).toBe(false);
  });

  it("does not accept a managed-looking health response without PID and runtime mode", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    await runStudioServiceCommand("ensure", {}, dependencies);
    let clock = 0;
    const incompleteFetch = async (input: string | URL | Request) => {
      if (String(input).endsWith("chengfeng-videocut-capabilities.json")) {
        return Response.json({ product: "chengfeng-videocut", studioVersion: "0.2.0" });
      }
      return Response.json({
        schemaVersion: 1,
        ok: true,
        product: "chengfeng-videocut",
        productVersion: "0.2.0",
        studioBuildId: "legacy-build",
      });
    };
    const operationsBefore = state.operations.length;
    await expect(runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      fetch: incompleteFetch as typeof globalThis.fetch,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      readyTimeoutMs: 100,
    })).rejects.toMatchObject({ code: "service_port_conflict" });
    expect(state.operations.slice(operationsBefore).some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("does not reinterpret a launchctl inspection failure as an unloaded service", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    await expect(runStudioServiceCommand("status", {}, {
      ...dependencies,
      runCommand: async (_executable, args) => {
        state.operations.push(args.join(" "));
        return { code: 1, stdout: "", stderr: "Operation not permitted" };
      },
    })).rejects.toMatchObject({ code: "service_unavailable" });
    expect(state.operations).toEqual([
      "print gui/501/com.chengfeng.videocut.studio",
    ]);
  });

  it("does not backfill a missing health productVersion from static capabilities", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    await runStudioServiceCommand("ensure", {}, dependencies);
    let clock = 0;
    const missingVersionFetch = async () => Response.json({
      schemaVersion: 1,
      ok: true,
      product: "chengfeng-videocut",
      pid: state.pid,
      runtimeMode: "launchd",
      studioBuildId: "build-without-version",
    });

    const operationsBefore = state.operations.length;
    await expect(runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      fetch: missingVersionFetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      readyTimeoutMs: 100,
    })).rejects.toMatchObject({ code: "service_port_conflict" });
    expect(state.operations.slice(operationsBefore).some((operation) =>
      /^(bootstrap|bootout|kickstart|enable|disable) /.test(operation)
    )).toBe(false);
  });

  it("fails closed outside macOS before touching launchctl", async () => {
    const home = await testHome();
    const { state, dependencies } = fakeRuntime(home);
    await expect(runStudioServiceCommand("status", {}, {
      ...dependencies,
      platform: "linux",
    })).rejects.toMatchObject({ code: "service_unsupported" });
    expect(state.operations).toEqual([]);
  });

  it("reads only a bounded tail of each persistent log", async () => {
    const home = await testHome();
    const { dependencies } = fakeRuntime(home);
    const paths = studioServicePaths(home);
    await mkdir(join(paths.dataDir, "logs"), { recursive: true });
    await writeFile(paths.stdoutLogPath, `${Array.from({ length: 30 }, (_, index) => `out-${index}`).join("\n")}\n`);
    await writeFile(paths.stderrLogPath, `${Array.from({ length: 30 }, (_, index) => `err-${index}`).join("\n")}\n`);
    const result = await runStudioServiceCommand("logs", { lines: 3 }, dependencies);
    expect(result.logs?.stdout).toBe("out-27\nout-28\nout-29");
    expect(result.logs?.stderr).toBe("err-27\nerr-28\nerr-29");
  });

  it("recovers an abandoned stale operation lock without removing a live lock", async () => {
    const home = await testHome();
    const { dependencies } = fakeRuntime(home);
    const paths = studioServicePaths(home);
    await mkdir(paths.operationLockPath, { recursive: true });
    await writeFile(join(paths.operationLockPath, "owner.json"), JSON.stringify({
      pid: 7777,
      acquiredAt: 1,
    }));
    const result = await runStudioServiceCommand("ensure", {}, {
      ...dependencies,
      now: () => 100_000,
      isProcessAlive: () => false,
    });
    expect(result.ready).toBe(true);
  });
});
