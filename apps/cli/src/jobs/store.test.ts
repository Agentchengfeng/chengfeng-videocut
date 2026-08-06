import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { JobStore, writeJsonAtomic } from "./store";

function validInput(root: string, jobId: string, target = join(root, "project")) {
  const jobDirectory = join(root, "jobs", jobId);
  const outputPath = join(root, `${jobId}.mp4`);
  return {
    jobId,
    kind: "export" as const,
    targetKey: `project:${target}`,
    projectId: "one",
    target,
    params: {
      outputPath,
      candidatePath: join(root, `.${jobId}.mp4.${jobId}.candidate`),
      workDirectory: join(jobDirectory, "work"),
      snapshotDirectory: join(jobDirectory, "snapshot"),
    },
    frozen: {
      dependencyFingerprint: "a".repeat(64),
      snapshotFingerprint: "b".repeat(64),
      projectRevision: "c".repeat(64),
    },
  };
}

describe("durable job store", () => {
  it("keeps the previous record when a crash seam fires before rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-atomic-"));
    try {
      const path = join(root, "job.json");
      await writeJsonAtomic(path, { generation: 1 });
      await expect(writeJsonAtomic(path, { generation: 2 }, {
        beforeRename() { throw new Error("simulated crash"); },
      })).rejects.toThrow("simulated crash");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ generation: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when any persisted job is bad JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-corrupt-"));
    try {
      await mkdir(join(root, "jobs", "bad"), { recursive: true });
      await writeFile(join(root, "jobs", "bad", "job.json"), "{broken");
      await expect(new JobStore(root).initialize()).rejects.toMatchObject({ code: "job_store_corrupt" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when JSON parses but violates the job schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-invalid-schema-"));
    try {
      await mkdir(join(root, "jobs", "bad"), { recursive: true });
      await writeFile(join(root, "jobs", "bad", "job.json"), JSON.stringify({ schemaVersion: 1, jobId: "bad" }));
      await expect(new JobStore(root).initialize()).rejects.toMatchObject({ code: "job_store_corrupt" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("creates at most one active job for the same target transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-concurrency-"));
    try {
      const store = new JobStore(root);
      await store.initialize();
      const input = validInput(root, "same-job");
      const settled = await Promise.allSettled([store.create(input), store.create(input)]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "job_target_conflict" });
      expect(await store.list()).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("treats recovery_blocked as occupying its target and output", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-blocked-conflict-"));
    try {
      const store = new JobStore(root);
      await store.initialize();
      const blocked = await store.create(validInput(root, "blocked"));
      await store.update(blocked.jobId, (job) => ({
        ...job,
        state: "recovery_blocked",
        phase: "recovery_blocked",
        finishedAt: new Date().toISOString(),
        error: { code: "manual_review", message: "ownership is ambiguous" },
      }));
      const next = validInput(root, "next", blocked.target);
      next.params.outputPath = blocked.params.outputPath as string;
      next.params.candidatePath = join(dirname(next.params.outputPath), `.${basename(next.params.outputPath)}.${next.jobId}.candidate`);
      await expect(store.create(next)).rejects.toMatchObject({
        code: "job_target_conflict",
        details: { existingJobId: blocked.jobId },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed on persisted cleanup paths that escape the job directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-malicious-path-"));
    try {
      const store = new JobStore(root);
      await store.initialize();
      const job = await store.create(validInput(root, "malicious"));
      const path = store.jobPath(job.jobId);
      const persisted = JSON.parse(await readFile(path, "utf8"));
      persisted.params.workDirectory = root;
      persisted.params.candidatePath = join(root, "unrelated-file");
      await writeFile(path, JSON.stringify(persisted));
      await expect(new JobStore(root).initialize()).rejects.toMatchObject({ code: "job_store_corrupt" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
