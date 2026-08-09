import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ingestKouboProject,
} from "./ingest";
import type { TranscribeKouboVideoOptions, TranscribeKouboVideoResult } from "./transcription";

const cleanup: string[] = [];

const MANAGED_RETRY_FILES = [
  "project.json",
  "transcript.json",
  "cut-selection.json",
  "edit-list.json",
  "index.html",
  "workbench.json",
  "events.jsonl",
  "input/source.mp4",
  "剪口播/1_转录/subtitles_words.json",
] as const;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(name: string): Promise<{ job: string; video: string; bytes: string }> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-ingest-"));
  cleanup.push(root);
  const job = join(root, name);
  const video = join(job, "uploads", "talk.mp4");
  const bytes = `real-media-${name}`;
  await mkdir(dirname(video), { recursive: true });
  await writeFile(video, bytes);
  return { job, video, bytes };
}

function transcript(bytes: string, source = "uploads/talk.mp4"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "volcengine",
    language: "zh-CN",
    media: {
      source,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      duration: 2,
    },
    cues: [{
      id: "volcengine-source",
      words: [{ id: "word-real", text: "真实", start: 0, end: 2 }],
    }],
  };
}

function fakeTranscriber(bytes: string, calls: TranscribeKouboVideoOptions[]) {
  return async (
    jobDir: string,
    options: TranscribeKouboVideoOptions,
  ): Promise<TranscribeKouboVideoResult> => {
    calls.push(options);
    expect(options.output).toMatch(/^\.chengfeng-videocut\/ingest\/[a-f0-9]{64}\/source-transcript\.json$/);
    expect(options.output).not.toBe("transcript.json");
    const output = join(jobDir, options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(transcript(bytes))}\n`, { flag: "wx" });
    return {
      provider: "volcengine",
      source: join(jobDir, options.video),
      output,
      cueCount: 1,
      wordCount: 1,
      duration: 2,
    };
  };
}

const createOptions = {
  probe: async () => ({ width: 1920, height: 1080 }),
  now: () => new Date("2026-08-10T00:00:00.000Z"),
};

describe("Product-owned project ingest", () => {
  it("transcribes to a hidden role and creates the managed project in one call", async () => {
    const f = await fixture("first-run");
    const calls: TranscribeKouboVideoOptions[] = [];
    const result = await ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription: fakeTranscriber(f.bytes, calls),
      create: createOptions,
    });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      projectId: "first-run",
      canonicalVideo: "input/source.mp4",
      canonicalTranscript: "剪口播/1_转录/subtitles_words.json",
      transcription: {
        role: "source-transcript",
        provider: "volcengine",
        reused: false,
        reusedProject: false,
      },
    });
    expect(JSON.parse(await readFile(join(f.job, "transcript.json"), "utf8")))
      .toMatchObject({ cues: [{ words: [{ id: "word-real" }] }] });
    expect(await readFile(join(f.job, calls[0]!.output), "utf8"))
      .toContain("word-real");
  });

  it("keeps and reuses the completed ASR stage after project creation rolls back", async () => {
    const f = await fixture("retry-stage");
    const calls: TranscribeKouboVideoOptions[] = [];
    const runTranscription = fakeTranscriber(f.bytes, calls);

    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: {
        ...createOptions,
        beforePrepareCommitFile: (_path, index) => {
          if (index === 1) throw new Error("injected create failure");
        },
      },
    })).rejects.toThrow("injected create failure");
    expect(calls).toHaveLength(1);
    await expect(readFile(join(f.job, "project.json"), "utf8")).rejects.toThrow();
    const stage = calls[0]!.output;
    expect(await readFile(join(f.job, stage), "utf8"))
      .toContain("word-real");

    const retried = await ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: createOptions,
    });
    expect(calls).toHaveLength(1);
    expect(retried.transcription.reused).toBe(true);
    expect(retried.projectId).toBe("retry-stage");
  });

  it("reuses the stage after registration finalization fails and create rolls back", async () => {
    const f = await fixture("retry-registration");
    const calls: TranscribeKouboVideoOptions[] = [];
    const runTranscription = fakeTranscriber(f.bytes, calls);

    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: {
        ...createOptions,
        finalize: () => { throw new Error("registration conflict"); },
      },
    })).rejects.toThrow("registration conflict");
    expect(calls).toHaveLength(1);
    await expect(readFile(join(f.job, "project.json"), "utf8")).rejects.toThrow();

    const retried = await ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: createOptions,
    });
    expect(calls).toHaveLength(1);
    expect(retried.transcription.reused).toBe(true);
    expect(retried.projectId).toBe("retry-registration");
  });

  it("serializes concurrent ASR staging and lets project creation fail closed", async () => {
    const f = await fixture("concurrent-ingest");
    const calls: TranscribeKouboVideoOptions[] = [];
    const writeStage = fakeTranscriber(f.bytes, calls);
    const runTranscription: typeof writeStage = async (jobDir, options) => {
      await Bun.sleep(25);
      return writeStage(jobDir, options);
    };
    const request = () => ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: createOptions,
    });

    const outcomes = await Promise.allSettled([request(), request()]);
    expect(calls).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "project_id_conflict" });
    expect(JSON.parse(await readFile(join(f.job, "project.json"), "utf8")))
      .toMatchObject({ jobId: "concurrent-ingest", inputVideo: "input/source.mp4" });
    expect(JSON.parse(await readFile(join(f.job, "transcript.json"), "utf8")))
      .toMatchObject({ cues: [{ words: [{ id: "word-real" }] }] });
  });

  it("returns the registered winner to an identical concurrent Product caller", async () => {
    const f = await fixture("concurrent-verified-ingest");
    const calls: TranscribeKouboVideoOptions[] = [];
    const writeStage = fakeTranscriber(f.bytes, calls);
    let registered = false;
    const request = () => ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription: async (jobDir, options) => {
        await Bun.sleep(25);
        return writeStage(jobDir, options);
      },
      verifyExisting: async (existing) => {
        expect(registered).toBe(true);
        expect(existing.projectId).toBe("concurrent-verified-ingest");
      },
      create: {
        ...createOptions,
        finalize: () => { registered = true; },
      },
    });

    const results = await Promise.all([request(), request()]);
    expect(calls).toHaveLength(1);
    expect(results.map((result) => result.projectId)).toEqual([
      "concurrent-verified-ingest",
      "concurrent-verified-ingest",
    ]);
    expect(results.filter((result) => result.transcription.reusedProject)).toHaveLength(1);
  });

  it("returns a strictly verified existing project after a successful response was lost", async () => {
    const f = await fixture("response-loss-retry");
    const calls: TranscribeKouboVideoOptions[] = [];
    const runTranscription = fakeTranscriber(f.bytes, calls);
    const first = await ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: createOptions,
    });
    const before = await Promise.all(MANAGED_RETRY_FILES.map(async (name) => [
      name,
      await readFile(join(f.job, name)),
    ] as const));
    let verified = 0;

    const retried = await ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      verifyExisting: async (existing) => {
        verified += 1;
        expect(existing.projectId).toBe(first.projectId);
        expect(existing.directory).toBe(await realpath(f.job));
      },
      create: createOptions,
    });

    expect(calls).toHaveLength(1);
    expect(verified).toBe(1);
    expect(retried.transcription).toMatchObject({ reused: true, reusedProject: true });
    for (const [name, bytes] of before) {
      expect(await readFile(join(f.job, name))).toEqual(bytes);
    }
  });

  it("rejects response-loss reuse when source or registration identity is not exact", async () => {
    const f = await fixture("response-loss-foreign");
    const calls: TranscribeKouboVideoOptions[] = [];
    const runTranscription = fakeTranscriber(f.bytes, calls);
    await ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      create: createOptions,
    });
    const projectBefore = await readFile(join(f.job, "project.json"));

    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      verifyExisting: () => {
        throw new Error("registered id points elsewhere");
      },
      create: createOptions,
    })).rejects.toThrow("registered id points elsewhere");
    expect(calls).toHaveLength(1);
    expect(await readFile(join(f.job, "project.json"))).toEqual(projectBefore);

    await writeFile(f.video, "different-source-bytes");
    let registrationChecked = false;
    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription,
      verifyExisting: () => { registrationChecked = true; },
      create: createOptions,
    })).rejects.toMatchObject({
      code: "project_id_conflict",
      details: { reason: "ingest_existing_project_mismatch" },
    });
    expect(registrationChecked).toBe(false);
    expect(await readFile(join(f.job, "project.json"))).toEqual(projectBefore);
  });

  it("fails closed when the retained stage belongs to different media", async () => {
    const f = await fixture("mismatched-stage");
    const calls: TranscribeKouboVideoOptions[] = [];
    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription: fakeTranscriber(f.bytes, calls),
      create: { ...createOptions, finalize: () => { throw new Error("keep stage"); } },
    })).rejects.toThrow("keep stage");
    const stage = join(f.job, calls[0]!.output);
    await writeFile(stage, JSON.stringify(transcript("different-media")));
    let retranscribed = false;

    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      aspectRatio: "16:9",
      runTranscription: async () => {
        retranscribed = true;
        throw new Error("must not transcribe over an existing stage");
      },
      create: createOptions,
    })).rejects.toMatchObject({
      code: "invalid_transcript",
      details: { reason: "ingest_stage_mismatch" },
    });
    expect(retranscribed).toBe(false);
    await expect(readFile(join(f.job, "project.json"), "utf8")).rejects.toThrow();
  });

  it("does not transcribe or overwrite a foreign partial project artifact", async () => {
    const f = await fixture("partial-state");
    const foreign = join(f.job, "transcript.json");
    await writeFile(foreign, "foreign-owner\n");
    let transcribed = false;

    await expect(ingestKouboProject(f.job, {
      video: "uploads/talk.mp4",
      runTranscription: async () => {
        transcribed = true;
        throw new Error("must not start ASR for a partial project");
      },
      create: createOptions,
    })).rejects.toMatchObject({ code: "project_id_conflict" });
    expect(transcribed).toBe(false);
    expect(await readFile(foreign, "utf8")).toBe("foreign-owner\n");
    await expect(readFile(join(f.job, ".chengfeng-videocut/ingest"), "utf8")).rejects.toThrow();
  });

  it("rejects an absolute video path before ASR", async () => {
    const f = await fixture("absolute-video");
    let transcribed = false;
    await expect(ingestKouboProject(f.job, {
      video: f.video,
      runTranscription: async () => {
        transcribed = true;
        throw new Error("must not run");
      },
    })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(transcribed).toBe(false);
  });
});
