#!/usr/bin/env bun

import { runCli } from "./run";
import { runJobWorker } from "./jobs/runners";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "__job-worker") {
    const jobId = argv[1];
    const dataDirIndex = argv.indexOf("--data-dir");
    const tokenIndex = argv.indexOf("--owner-token");
    try {
      const ownerToken = tokenIndex >= 0 ? argv[tokenIndex + 1] : undefined;
      const workerSecret = process.env.CHENGFENG_INTERNAL_JOB_WORKER_SECRET;
      if (!jobId || dataDirIndex < 0 || tokenIndex < 0 || !argv[dataDirIndex + 1] || !ownerToken) {
        throw Object.assign(new Error("Invalid internal worker arguments"), { code: "invalid_argument" });
      }
      if (!ownerToken || !workerSecret) {
        throw Object.assign(new Error("Internal job worker capability is missing"), {
          code: "job_worker_unauthorized",
        });
      }
      await runJobWorker(argv[dataDirIndex + 1]!, jobId, ownerToken, workerSecret);
      process.exitCode = 0;
    } catch (error) {
      const value = error as { code?: string; message?: string; details?: Record<string, unknown> };
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: {
          code: value.code ?? "job_worker_failed",
          message: value.message ?? "Job worker failed",
          ...(value.details ? { details: value.details } : {}),
        },
      })}\n`);
      process.exitCode = 1;
    }
  } else {
    process.exitCode = await runCli(argv);
  }
}
