import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("internal job worker entry", () => {
  it("rejects direct stable CLI invocation without the manager-only capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-worker-access-"));
    try {
      const env = { ...process.env };
      delete env.CHENGFENG_INTERNAL_JOB_WORKER_SECRET;
      delete env.CHENGFENG_JOB_OWNER_TOKEN;
      const child = Bun.spawn([
        process.execPath,
        resolve("apps/cli/src/cli.ts"),
        "__job-worker",
        "known-job",
        "--data-dir",
        root,
        "--owner-token",
        "known-owner-token",
      ], { env, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: { code: "job_worker_unauthorized" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
