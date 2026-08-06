import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function processGroupMatchesToken(pgid: number, token: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axeww", "-o", "pid=,pgid=,command="]);
    const members = stdout.split(/\r?\n/).filter((line) => {
      const match = /^\s*\d+\s+(\d+)\s+/.exec(line);
      return match?.[1] === String(pgid);
    });
    return members.length > 0 && members.every((line) => line.includes(`CHENGFENG_JOB_OWNER_TOKEN=${token}`));
  } catch { return false; }
}

export async function processMatchesToken(pid: number, token: string): Promise<boolean> {
  if (!processExists(pid)) return false;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CommandLine`,
      ]);
      return stdout.includes(token);
    } catch { return false; }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
    return stdout.includes(token);
  } catch { return false; }
}

export async function terminateOwnedProcessTree(
  pid: number,
  token: string,
  timeoutMs = 5_000,
): Promise<"absent" | "terminated" | "identity_mismatch" | "cleanup_failed"> {
  const rootExists = processExists(pid);
  if (process.platform === "win32" && !rootExists) return "identity_mismatch";
  if (process.platform !== "win32" && !processGroupExists(pid)) return "absent";
  if (rootExists) {
    if (!(await processMatchesToken(pid, token))) return "identity_mismatch";
  } else if (!(await processGroupMatchesToken(pid, token))) {
    return "identity_mismatch";
  }
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      if (processExists(pid)) return "cleanup_failed";
    }
  } else {
    try {
      try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
    } catch {
      if (processExists(pid)) return "cleanup_failed";
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && processGroupExists(pid)) await Bun.sleep(25);
    if (processGroupExists(pid)) {
      try {
        try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
      } catch {
        if (processGroupExists(pid)) return "cleanup_failed";
      }
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processGroupExists(pid)) await Bun.sleep(25);
  return processGroupExists(pid) ? "cleanup_failed" : "terminated";
}
