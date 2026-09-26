import { randomUUID } from "node:crypto";
import { createDiagnosticLog } from "../service/diagnostics";

/** Diagnostic only: never owns/restarts the service or changes fatal semantics. */
export function createLifecycleLog(dataDir: string) {
  const instanceId = randomUUID();
  const initialParentPid = process.ppid;
  const sink = createDiagnosticLog(dataDir, instanceId);
  const record = (phase: string, details: Record<string, string | number> = {}) => {
    return sink.record(phase, { pid: process.pid, initialParentPid, parentPid: process.ppid, ...details });
  };
  const observe = () => {
    let lastParentPid = initialParentPid;
    let parentEnded = false;
    const timer = setInterval(() => {
      if (process.ppid !== lastParentPid) {
        record("parent_changed", { previousParentPid: lastParentPid });
        lastParentPid = process.ppid;
      }
      // Bun may cache ppid. Probe only existence; EPERM is not proof of exit.
      if (!parentEnded && initialParentPid > 1) {
        try { process.kill(initialParentPid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            parentEnded = true;
            record("parent_unavailable", { observedParentPid: initialParentPid });
          }
        }
      }
    }, 1000);
    timer.unref();
    const exiting = (code: number) => record("process_exit", { code });
    const fatal = (error: Error, origin: string) => record("uncaught_exception", {
      // Do not log error messages/stacks: they may contain credentials or paths.
      errorName: error.name.slice(0, 80), origin: origin.slice(0, 80),
    });
    process.on("exit", exiting);
    process.on("uncaughtExceptionMonitor", fatal);
    return () => {
      clearInterval(timer);
      process.off("exit", exiting);
      process.off("uncaughtExceptionMonitor", fatal);
    };
  };
  return { record, observe, get path() { return sink.path; }, instanceId };
}
