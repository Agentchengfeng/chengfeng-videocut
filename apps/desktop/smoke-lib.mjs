import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

async function allocatePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a smoke-test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function runProcess(executable, args, env, timeoutMs = 90_000) {
  const child = spawn(executable, args, {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-1024 * 1024);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
  });
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExit({ ...result, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish({ timeout: true, code: null, signal: null });
    }, timeoutMs);
    child.once("exit", (code, signal) => finish({ code, signal }));
    child.once("error", (error) => finish({ code: null, signal: null, error }));
  });
}

async function assertRuntimeStopped(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(300),
      });
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Runtime still answers on port ${port} after the desktop app exited`);
}

async function withConflictServer(port, run) {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      product: "another-application",
      productVersion: "0.4.7",
    }));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  try {
    return await run();
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function describeFailure(label, result) {
  return `${label} failed: ${JSON.stringify({
    code: result.code,
    signal: result.signal,
    timeout: result.timeout,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  })}`;
}

export async function runDesktopSmoke(options) {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-desktop-smoke-"));
  try {
    const successPort = await allocatePort();
    const screenshot = join(root, "desktop.png");
    const success = await runProcess(options.executable, options.args, {
      CHENGFENG_VIDEOCUT_DESKTOP_SMOKE: "1",
      CHENGFENG_VIDEOCUT_DESKTOP_PORT: String(successPort),
      CHENGFENG_VIDEOCUT_DESKTOP_DATA_DIR: join(root, "success-data"),
      CHENGFENG_VIDEOCUT_DESKTOP_SMOKE_SCREENSHOT: screenshot,
      CHENGFENG_VIDEOCUT_DESKTOP_SMOKE_NORMAL_QUIT: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    });
    if (success.code !== 0 || !success.stdout.includes("DESKTOP_SMOKE_OK")) {
      throw new Error(describeFailure("success path", success));
    }
    const screenshotInfo = await stat(screenshot);
    if (!screenshotInfo.isFile() || screenshotInfo.size < 1_000) {
      throw new Error(`Smoke screenshot is missing or empty: ${screenshot}`);
    }
    const evidenceScreenshot =
      process.env.CHENGFENG_VIDEOCUT_DESKTOP_SMOKE_EVIDENCE_SCREENSHOT;
    if (evidenceScreenshot) await copyFile(screenshot, evidenceScreenshot);
    await assertRuntimeStopped(successPort);

    const missingBunPort = await allocatePort();
    const missingBun = await runProcess(options.executable, options.args, {
      CHENGFENG_VIDEOCUT_DESKTOP_SMOKE: "1",
      CHENGFENG_VIDEOCUT_DESKTOP_PORT: String(missingBunPort),
      CHENGFENG_VIDEOCUT_DESKTOP_DATA_DIR: join(root, "missing-bun-data"),
      CHENGFENG_VIDEOCUT_DESKTOP_BUN: join(root, "does-not-exist", "bun"),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    });
    if (
      missingBun.code === 0 ||
      !`${missingBun.stdout}\n${missingBun.stderr}`.includes("Bundled Bun is missing")
    ) {
      throw new Error(describeFailure("missing Bun path", missingBun));
    }
    await assertRuntimeStopped(missingBunPort);

    const conflictPort = await allocatePort();
    const conflict = await withConflictServer(conflictPort, () =>
      runProcess(options.executable, options.args, {
        CHENGFENG_VIDEOCUT_DESKTOP_SMOKE: "1",
        CHENGFENG_VIDEOCUT_DESKTOP_PORT: String(conflictPort),
        CHENGFENG_VIDEOCUT_DESKTOP_DATA_DIR: join(root, "conflict-data"),
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      })
    );
    if (
      conflict.code === 0 ||
      !`${conflict.stdout}\n${conflict.stderr}`.includes("does not belong to a compatible")
    ) {
      throw new Error(describeFailure("port conflict path", conflict));
    }

    console.log(JSON.stringify({
      status: "desktop_smoke_passed",
      successPort,
      screenshotBytes: screenshotInfo.size,
      missingBunExitCode: missingBun.code,
      conflictExitCode: conflict.code,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
