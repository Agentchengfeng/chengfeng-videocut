import { execFile, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_COMMAND_MAX_BUFFER = 256 * 1024;

export interface ProcessCommandOptions {
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
  encoding: "utf8";
  signal: AbortSignal;
}

export type ProcessCommandExecutor = (
  file: string,
  args: string[],
  options: ProcessCommandOptions,
) => Promise<unknown>;

const executeProcessCommand: ProcessCommandExecutor = async (file, args, options) =>
  execFileAsync(file, args, options);

function commandOptions(timeoutMs: number, signal: AbortSignal): ProcessCommandOptions {
  return {
    timeout: Math.max(1, Math.floor(timeoutMs)),
    windowsHide: true,
    maxBuffer: PROCESS_COMMAND_MAX_BUFFER,
    encoding: "utf8",
    signal,
  };
}

async function executeBoundedProcessCommand(
  file: string,
  args: string[],
  timeoutMs: number,
  execute: ProcessCommandExecutor,
): Promise<unknown> {
  if (timeoutMs <= 0) throw Object.assign(new Error("Process command deadline expired"), { code: "ETIMEDOUT" });
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error("Process command timed out"), { code: "ETIMEDOUT" });
  // Ask the real child_process executor to kill its helper before the hard
  // deadline. The remaining slice lets its exit callback settle; an injected
  // executor that ignores AbortSignal is still fenced by the outer deadline.
  const terminationGraceMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 10)));
  const executionTimeoutMs = Math.max(1, timeoutMs - terminationGraceMs);
  const abortTimer = setTimeout(() => controller.abort(timeoutError), executionTimeoutMs);
  abortTimer.unref?.();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(timeoutError), timeoutMs);
    deadlineTimer.unref?.();
  });
  try {
    return await Promise.race([
      execute(file, args, commandOptions(executionTimeoutMs, controller.signal)),
      deadline,
    ]);
  } finally {
    clearTimeout(abortTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function stdoutOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("stdout" in result)) return "";
  const stdout = (result as { stdout?: unknown }).stdout;
  if (typeof stdout === "string") return stdout;
  return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : "";
}

export interface TrackedOwnedProcess {
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;
  token: string;
  proveOwnership: (timeoutMs: number) => Promise<boolean>;
}

/**
 * This is only the cheap precondition for a live IPC challenge. It must never
 * authorize a PID-based kill by itself because the child can exit afterward.
 */
export function trackedProcessMatches(
  pid: number,
  token: string,
  tracked?: TrackedOwnedProcess,
): boolean {
  return Boolean(
    tracked &&
    tracked.token === token &&
    tracked.child.pid === pid &&
    tracked.child.exitCode === null &&
    tracked.child.signalCode === null
  );
}

const OWNER_CHALLENGE = "chengfeng-job-owner-challenge-v1";
const OWNER_PROOF = "chengfeng-job-owner-proof-v1";

function ownershipProof(
  secret: string,
  token: string,
  pid: number,
  nonce: string,
  holdMs: number,
): string {
  return createHmac("sha256", secret)
    .update(`${OWNER_PROOF}\0${token}\0${pid}\0${nonce}\0${holdMs}`)
    .digest("hex");
}

/** Install only inside the authenticated internal worker process. */
export function installWorkerOwnershipResponder(token: string, secret: string): () => void {
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (message: unknown) => {
    if (
      !message || typeof message !== "object" ||
      (message as { type?: unknown }).type !== OWNER_CHALLENGE ||
      typeof (message as { nonce?: unknown }).nonce !== "string" ||
      !/^[a-f0-9]{32}$/.test((message as { nonce: string }).nonce) ||
      !Number.isSafeInteger((message as { holdMs?: unknown }).holdMs) ||
      Number((message as { holdMs: number }).holdMs) < 1_000 ||
      Number((message as { holdMs: number }).holdMs) > 10_000 ||
      typeof process.send !== "function" || !process.connected
    ) return;
    const nonce = (message as { nonce: string }).nonce;
    const holdMs = (message as { holdMs: number }).holdMs;
    // Keep the proven worker alive until taskkill has opened its process. This
    // closes the proof-to-kill PID-reuse window for a currently tracked child.
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holdTimer = undefined; }, holdMs);
    try {
      process.send(
        {
          type: OWNER_PROOF,
          nonce,
          pid: process.pid,
          holdMs,
          proof: ownershipProof(secret, token, process.pid, nonce, holdMs),
        },
        () => undefined,
      );
    } catch {
      // A disconnect race means the manager cannot prove ownership and must
      // fail closed or use its bounded operating-system fallback.
    }
  };
  process.on("message", onMessage);
  return () => process.off("message", onMessage);
}

/**
 * Challenge the exact IPC channel opened when this Runtime spawned the
 * worker. This avoids a slow WMI lookup for a live local child, while restart
 * recovery (which has no channel) still needs operating-system proof.
 */
export async function proveWorkerOwnership(
  child: ChildProcess,
  token: string,
  secret: string,
  timeoutMs: number,
): Promise<boolean> {
  if (
    timeoutMs <= 0 || !child.pid || !child.connected || typeof child.send !== "function" ||
    child.exitCode !== null || child.signalCode !== null
  ) return false;
  const pid = child.pid;
  const nonce = randomBytes(16).toString("hex");
  const holdMs = Math.min(10_000, Math.max(1_000, Math.ceil(timeoutMs) + 1_000));
  const expected = Buffer.from(ownershipProof(secret, token, pid, nonce, holdMs), "hex");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("message", onMessage);
      child.off("disconnect", onFailure);
      child.off("error", onFailure);
      child.off("exit", onFailure);
      resolve(value);
    };
    const onFailure = () => finish(false);
    const onMessage = (message: unknown) => {
      if (
        !message || typeof message !== "object" ||
        (message as { type?: unknown }).type !== OWNER_PROOF ||
        (message as { nonce?: unknown }).nonce !== nonce ||
        (message as { pid?: unknown }).pid !== pid ||
        (message as { holdMs?: unknown }).holdMs !== holdMs ||
        typeof (message as { proof?: unknown }).proof !== "string"
      ) return;
      const actual = Buffer.from((message as { proof: string }).proof, "hex");
      finish(
        actual.length === expected.length && timingSafeEqual(actual, expected) &&
        child.exitCode === null && child.signalCode === null,
      );
    };
    child.on("message", onMessage);
    child.once("disconnect", onFailure);
    child.once("error", onFailure);
    child.once("exit", onFailure);
    timer = setTimeout(onFailure, timeoutMs);
    timer.unref?.();
    try {
      child.send!({ type: OWNER_CHALLENGE, nonce, holdMs }, (error) => {
        if (error) finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

export async function runWindowsTaskkill(
  pid: number,
  execute: ProcessCommandExecutor = executeProcessCommand,
  timeoutMs = 5_000,
): Promise<"terminated" | "cleanup_failed"> {
  if (timeoutMs <= 0) return "cleanup_failed";
  try {
    await executeBoundedProcessCommand(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      timeoutMs,
      execute,
    );
    return "terminated";
  } catch {
    // The root disappearing cannot prove that taskkill removed descendants.
    return "cleanup_failed";
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupExists(pgid: number): boolean {
  if (process.platform === "win32") return processExists(pgid);
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function processGroupMatchesToken(
  pgid: number,
  token: string,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  try {
    const result = await executeBoundedProcessCommand(
      "ps",
      ["-axeww", "-o", "pid=,pgid=,command="],
      timeoutMs,
      executeProcessCommand,
    );
    const stdout = stdoutOf(result);
    const members = stdout.split(/\r?\n/).filter((line) => {
      const match = /^\s*\d+\s+(\d+)\s+/.exec(line);
      return match?.[1] === String(pgid);
    });
    return members.length > 0 && members.every((line) => line.includes(`CHENGFENG_JOB_OWNER_TOKEN=${token}`));
  } catch { return false; }
}

export async function windowsProcessMatchesToken(
  pid: number,
  token: string,
  timeoutMs: number,
  execute: ProcessCommandExecutor = executeProcessCommand,
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  try {
    const result = await executeBoundedProcessCommand(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CommandLine`,
      ],
      timeoutMs,
      execute,
    );
    return stdoutOf(result).includes(token);
  } catch {
    return false;
  }
}

export async function processMatchesToken(
  pid: number,
  token: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (!processExists(pid)) return false;
  if (process.platform === "win32") {
    return windowsProcessMatchesToken(pid, token, timeoutMs);
  }
  if (timeoutMs <= 0) return false;
  try {
    const result = await executeBoundedProcessCommand(
      "ps",
      ["-o", "command=", "-p", String(pid)],
      timeoutMs,
      executeProcessCommand,
    );
    return stdoutOf(result).includes(token);
  } catch { return false; }
}

export async function terminateOwnedProcessTree(
  pid: number,
  token: string,
  timeoutMs = 5_000,
  tracked?: TrackedOwnedProcess,
): Promise<"absent" | "terminated" | "identity_mismatch" | "cleanup_failed"> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const rootExists = processExists(pid);
  if (process.platform === "win32" && !rootExists) return "identity_mismatch";
  if (process.platform !== "win32" && !processGroupExists(pid)) return "absent";
  if (rootExists) {
    let proven = false;
    if (process.platform === "win32" && trackedProcessMatches(pid, token, tracked)) {
      proven = await tracked!.proveOwnership(remainingMs(deadline));
      // The authenticated response proves which worker answered. Re-check the
      // local handle immediately before the PID-based tree termination.
      proven = proven && trackedProcessMatches(pid, token, tracked);
    }
    if (!proven && !(await processMatchesToken(pid, token, remainingMs(deadline)))) {
      return "identity_mismatch";
    }
  } else if (!(await processGroupMatchesToken(pid, token, remainingMs(deadline)))) {
    return "identity_mismatch";
  }
  if (process.platform === "win32") {
    if (await runWindowsTaskkill(pid, executeProcessCommand, remainingMs(deadline)) === "cleanup_failed") {
      return "cleanup_failed";
    }
  } else {
    try {
      try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
    } catch {
      if (processExists(pid)) return "cleanup_failed";
    }
    while (Date.now() < deadline && processGroupExists(pid)) await Bun.sleep(25);
    if (processGroupExists(pid)) {
      try {
        try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
      } catch {
        if (processGroupExists(pid)) return "cleanup_failed";
      }
    }
  }
  while (Date.now() < deadline && processGroupExists(pid)) await Bun.sleep(25);
  return processGroupExists(pid) ? "cleanup_failed" : "terminated";
}
