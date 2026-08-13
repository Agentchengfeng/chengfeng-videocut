import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTranscriptWords } from "@video-workbench/core";
import { buildCutAudioArgs, buildVolcengineTranscript, transcribeKouboVideo, transcribeProjectCut } from "./transcription";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function response(payload: unknown, status = "20000000", extraHeaders: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "x-api-status-code") return status;
        return extraHeaders[key] ?? null;
      },
    },
    json: async () => payload,
  };
}

async function fixture(): Promise<{ job: string; video: string }> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-transcribe-"));
  cleanup.push(root);
  const job = join(root, "job");
  const video = join(job, "uploads", "source.mp4");
  await mkdir(join(job, "uploads"), { recursive: true });
  await writeFile(video, "fixture-video");
  return { job, video };
}

const probe = async () => ({
  duration: 4,
  hasVideo: true,
  hasAudio: true,
  videoBitrate: 0,
  videoProfile: "high",
  pixelFormat: "yuv420p",
  width: 1280,
  height: 720,
});

async function checkpointFilesAt(root: string): Promise<string[]> {
  const directory = join(root, ".chengfeng-videocut", "transcription-checkpoints");
  return (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(directory, name));
}

async function checkpointFiles(job: string): Promise<string[]> {
  return checkpointFilesAt(job);
}

async function readCheckpoint(job: string): Promise<Record<string, unknown>> {
  const files = await checkpointFilesAt(job);
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(files[0] as string, "utf8")) as Record<string, unknown>;
}

function completedQuery() {
  return response({
    result: {
      utterances: [{ words: [{ text: "你", start_time: 0, end_time: 200 }] }],
    },
  });
}

describe("Volcengine Runtime transcription", () => {
  it("maps a completed Volcengine response to stable words and task-local output", async () => {
    const { job } = await fixture();
    const requests: Array<{ url: string; body: unknown }> = [];
    const result = await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url, init) => {
          requests.push({ url, body: JSON.parse(String(init.body)) });
          if (url.endsWith("/submit")) return response({ result: {} });
          return response({
            result: {
              utterances: [{
                words: [
                  { text: "你", start_time: 1000, end_time: 1200 },
                  { text: "好", start_time: 2000, end_time: 2200 },
                  { text: " ", start_time: -1, end_time: -1 },
                ],
              }],
            },
          });
        },
        sleep: async () => {},
        uuid: () => "request-id",
      },
    });

    expect(result).toMatchObject({
      provider: "volcengine",
      cueCount: 1,
      wordCount: 6,
      duration: 4,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toEndWith("/submit");
    expect(requests[0]?.body).toMatchObject({
      audio: { format: "mp3", data: expect.any(String), language: "zh-CN" },
      request: { model_name: "bigmodel" },
    });
    const transcript = JSON.parse(await readFile(join(job, "cloud", "transcript.json"), "utf8"));
    expect(parseTranscriptWords(transcript)).toHaveLength(6);
    expect(transcript.cues[0].words).toMatchObject([
      { text: "", start: 0, end: 1, isGap: true },
      { text: "你", start: 1, end: 1.2 },
      { text: "", start: 1.2, end: 2, isGap: true },
      { text: "好", start: 2, end: 2.2 },
      { text: "", start: 2.2, end: 3.2, isGap: true },
      { text: "", start: 3.2, end: 4, isGap: true },
    ]);
    expect(transcript.cues[0].words.every((word: { id: string }) => /^\w+-[a-f0-9]{20}$/.test(word.id)))
      .toBe(true);
    const files = await checkpointFiles(job);
    const checkpointStat = await lstat(files[0] as string);
    const checkpoint = JSON.parse(await readFile(files[0] as string, "utf8"));
    expect(checkpointStat.isFile()).toBe(true);
    expect(checkpointStat.nlink).toBe(1);
    if (process.platform !== "win32") expect(checkpointStat.mode & 0o077).toBe(0);
    expect(checkpoint).toMatchObject({
      kind: "volcengine-transcription-execution",
      requestId: "request-id",
      phase: "completed",
      identity: {
        provider: "volcengine",
        output: "cloud/transcript.json",
        language: "zh-CN",
        modelName: "bigmodel",
      },
    });
    const checkpointRaw = JSON.stringify(checkpoint);
    expect(checkpointRaw).not.toContain("test-key");
    expect(checkpointRaw).not.toContain("fixture-audio");
    expect(checkpointRaw).not.toContain("你好");
  });

  it("resumes from a checkpoint written before submit without minting a new request id", async () => {
    const { job } = await fixture();
    let uuidCalls = 0;
    let submitCalls = 0;
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) submitCalls += 1;
          throw new Error("provider must not be reached before the simulated crash");
        },
        uuid: () => {
          uuidCalls += 1;
          return "request-before-submit";
        },
        checkpointEvent: (event) => {
          if (event.event === "after-initial-checkpoint") {
            throw new Error("simulated process exit before submit");
          }
        },
      },
    })).rejects.toThrow("simulated process exit before submit");
    expect(uuidCalls).toBe(1);
    expect(submitCalls).toBe(0);
    expect(await readCheckpoint(job)).toMatchObject({
      requestId: "request-before-submit",
      phase: "submitting",
    });

    let queryCalls = 0;
    const result = await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async () => { throw new Error("retry must not extract audio"); },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) throw new Error("retry must not submit again");
          queryCalls += 1;
          expect((init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe("request-before-submit");
          return completedQuery();
        },
        uuid: () => { throw new Error("retry must not mint a request id"); },
      },
    });
    expect(result.wordCount).toBeGreaterThan(0);
    expect(queryCalls).toBe(1);
    expect(await readCheckpoint(job)).toMatchObject({ phase: "completed" });
  });

  it("marks a submit timeout as submitting_uncertain and retries by query only", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      requestTimeoutMs: 1,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (_url, init) => {
          const signal = init.signal as AbortSignal;
          return await new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        uuid: () => "request-timeout",
      },
    })).rejects.toMatchObject({
      code: "cloud_transcription_failed",
      details: { kind: "request_timeout", stage: "submit", checkpointPhase: "submitting_uncertain" },
    });
    expect(await readCheckpoint(job)).toMatchObject({
      requestId: "request-timeout",
      phase: "submitting_uncertain",
      error: { kind: "request_timeout", stage: "submit" },
    });

    let queryCalls = 0;
    await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async () => { throw new Error("timeout recovery must not extract audio"); },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) throw new Error("timeout recovery must not submit");
          queryCalls += 1;
          expect((init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe("request-timeout");
          return completedQuery();
        },
        uuid: () => { throw new Error("timeout recovery must not mint a request id"); },
      },
    });
    expect(queryCalls).toBe(1);
  });

  it("does not use logid if the process exits before the logid checkpoint is written", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) return response(null, "20000000", { "x-tt-logid": "log-before" });
          throw new Error("query must not run before simulated crash");
        },
        uuid: () => "request-log-before",
        checkpointEvent: (event) => {
          if (event.event === "after-submit-accepted-before-logid-checkpoint") {
            throw new Error("simulated process exit before logid checkpoint");
          }
        },
      },
    })).rejects.toThrow("simulated process exit before logid checkpoint");
    expect(await readCheckpoint(job)).toMatchObject({
      requestId: "request-log-before",
      phase: "submitting",
    });

    await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) throw new Error("retry must not submit");
          expect((init.headers as Record<string, string>)["X-Tt-Logid"]).toBeUndefined();
          return completedQuery();
        },
        uuid: () => { throw new Error("retry must not mint a request id"); },
      },
    });
  });

  it("persists logid atomically and sends it on resumed query", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) return response(null, "20000000", { "x-tt-logid": "log-after" });
          throw new Error("query must not run before simulated crash");
        },
        uuid: () => "request-log-after",
        checkpointEvent: (event) => {
          if (event.event === "after-logid-checkpoint") {
            throw new Error("simulated process exit after logid checkpoint");
          }
        },
      },
    })).rejects.toThrow("simulated process exit after logid checkpoint");
    expect(await readCheckpoint(job)).toMatchObject({
      requestId: "request-log-after",
      phase: "polling",
      logid: "log-after",
    });

    await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) throw new Error("retry must not submit");
          expect((init.headers as Record<string, string>)["X-Tt-Logid"]).toBe("log-after");
          return completedQuery();
        },
        uuid: () => { throw new Error("retry must not mint a request id"); },
      },
    });
  });

  it("resumes a pending query checkpoint without duplicate submit", async () => {
    const { job } = await fixture();
    let submitCalls = 0;
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) {
            submitCalls += 1;
            return response(null, "20000000", { "x-tt-logid": "log-pending" });
          }
          return response({}, "20000001");
        },
        uuid: () => "request-pending",
        checkpointEvent: (event) => {
          if (event.event === "after-query-pending-checkpoint") {
            throw new Error("simulated process exit after pending query");
          }
        },
      },
    })).rejects.toThrow("simulated process exit after pending query");
    expect(submitCalls).toBe(1);
    expect(await readCheckpoint(job)).toMatchObject({
      phase: "polling",
      queryAttempts: 1,
      logid: "log-pending",
    });

    await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) throw new Error("retry must not submit");
          return completedQuery();
        },
        uuid: () => { throw new Error("retry must not mint a request id"); },
      },
    });
  });

  it("resumes cut retranscription without duplicate submit", async () => {
    const { job, video } = await fixture();
    const output = join(job, "cut", "transcript.json");
    const ranges = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
    let submitCalls = 0;
    await expect(transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractCutAudio: async (_source, _ranges, audio) => { await writeFile(audio, "fixture-cut-audio"); },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) {
            submitCalls += 1;
            expect((init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe("cut-request-pending");
            return response(null, "20000000", { "x-tt-logid": "cut-log-pending" });
          }
          expect((init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe("cut-request-pending");
          return response({}, "20000001");
        },
        uuid: () => "cut-request-pending",
        checkpointEvent: (event) => {
          if (event.event === "after-query-pending-checkpoint") {
            throw new Error("simulated cut restart after pending query");
          }
        },
      },
    })).rejects.toThrow("simulated cut restart after pending query");
    expect(submitCalls).toBe(1);
    expect(await readCheckpoint(dirname(output))).toMatchObject({
      requestId: "cut-request-pending",
      phase: "polling",
      queryAttempts: 1,
      logid: "cut-log-pending",
      identity: {
        source: "cut-source",
        output: "transcript.json",
        cutDuration: 2,
      },
    });

    let retryExtractCalls = 0;
    let retryQueryCalls = 0;
    await transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractCutAudio: async () => {
          retryExtractCalls += 1;
          throw new Error("retry must not extract cut audio");
        },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) throw new Error("cut retry must not submit");
          retryQueryCalls += 1;
          expect((init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe("cut-request-pending");
          expect((init.headers as Record<string, string>)["X-Tt-Logid"]).toBe("cut-log-pending");
          return completedQuery();
        },
        uuid: () => { throw new Error("cut retry must not mint a request id"); },
      },
    });
    expect(submitCalls).toBe(1);
    expect(retryExtractCalls).toBe(0);
    expect(retryQueryCalls).toBe(1);
    expect(await readCheckpoint(dirname(output))).toMatchObject({ phase: "completed" });
  });

  it("recovers a valid cut checkpoint by query when ffmpeg audio extraction is unavailable", async () => {
    const { job, video } = await fixture();
    const output = join(job, "cut-audio-unavailable", "transcript.json");
    const ranges = [{ start: 0, end: 1 }];
    await expect(transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractCutAudio: async (_source, _ranges, audio) => { await writeFile(audio, "fixture-cut-audio"); },
        fetch: async () => { throw new Error("provider must not run before simulated checkpoint crash"); },
        uuid: () => "cut-request-before-submit",
        checkpointEvent: (event) => {
          if (event.event === "after-initial-checkpoint") {
            throw new Error("simulated cut restart before submit");
          }
        },
      },
    })).rejects.toThrow("simulated cut restart before submit");
    expect(await readCheckpoint(dirname(output))).toMatchObject({
      requestId: "cut-request-before-submit",
      phase: "submitting",
    });

    let retryExtractCalls = 0;
    let queryCalls = 0;
    const result = await transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractCutAudio: async () => {
          retryExtractCalls += 1;
          throw new Error("ffmpeg unavailable");
        },
        fetch: async (url, init) => {
          if (url.endsWith("/submit")) throw new Error("checkpoint recovery must not submit");
          queryCalls += 1;
          expect((init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe("cut-request-before-submit");
          return completedQuery();
        },
        uuid: () => { throw new Error("checkpoint recovery must not mint a request id"); },
      },
    });
    expect(result.wordCount).toBeGreaterThan(0);
    expect(retryExtractCalls).toBe(0);
    expect(queryCalls).toBe(1);
    expect(await readCheckpoint(dirname(output))).toMatchObject({ phase: "completed" });
  });

  it("blocks cut recovery after cumulative poll budget is exhausted across restarts", async () => {
    const { job, video } = await fixture();
    const output = join(job, "cut-budget", "transcript.json");
    const ranges = [{ start: 0, end: 1 }];
    let queryCalls = 0;
    await expect(transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      dependencies: {
        probe,
        extractCutAudio: async (_source, _ranges, audio) => { await writeFile(audio, "fixture-cut-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) return response(null, "20000000", { "x-tt-logid": "cut-log-budget" });
          queryCalls += 1;
          return response({}, "20000001");
        },
        uuid: () => "cut-request-budget",
        checkpointEvent: (event) => {
          if (event.event === "after-query-pending-checkpoint") {
            throw new Error("simulated restart after first poll attempt");
          }
        },
      },
    })).rejects.toThrow("simulated restart after first poll attempt");
    expect(await readCheckpoint(dirname(output))).toMatchObject({
      phase: "polling",
      queryAttempts: 1,
    });

    await expect(transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      dependencies: {
        probe,
        extractCutAudio: async () => { throw new Error("budget retry must not extract cut audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) throw new Error("budget retry must not submit");
          queryCalls += 1;
          return response({}, "20000001");
        },
        uuid: () => { throw new Error("budget retry must not mint a request id"); },
      },
    })).rejects.toMatchObject({
      code: "cloud_transcription_failed",
      details: {
        kind: "poll_budget_exhausted",
        checkpointPhase: "recovery_blocked",
        queryAttempts: 2,
        maxPollAttempts: 2,
      },
    });
    expect(await readCheckpoint(dirname(output))).toMatchObject({
      phase: "recovery_blocked",
      queryAttempts: 2,
      error: { kind: "poll_budget_exhausted" },
    });

    const blockedAt = queryCalls;
    await expect(transcribeProjectCut({
      source: video,
      ranges,
      output,
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      dependencies: {
        probe,
        extractCutAudio: async () => { throw new Error("blocked retry must not extract cut audio"); },
        fetch: async () => {
          queryCalls += 1;
          return completedQuery();
        },
        uuid: () => { throw new Error("blocked retry must not mint a request id"); },
      },
    })).rejects.toMatchObject({
      code: "cloud_transcription_failed",
      details: { checkpointPhase: "recovery_blocked" },
    });
    expect(queryCalls).toBe(blockedAt);
  });

  it("queries again after provider completion if the process exits before output publish", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => url.endsWith("/submit")
          ? response(null)
          : completedQuery(),
        uuid: () => "request-before-output",
        checkpointEvent: (event) => {
          if (event.event === "after-provider-completed-before-output") {
            throw new Error("simulated process exit before output");
          }
        },
      },
    })).rejects.toThrow("simulated process exit before output");
    await expect(readFile(join(job, "cloud", "transcript.json"), "utf8")).rejects.toThrow();
    expect(await readCheckpoint(job)).toMatchObject({ phase: "polling" });

    await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) throw new Error("retry must not submit");
          return completedQuery();
        },
        uuid: () => { throw new Error("retry must not mint a request id"); },
      },
    });
    expect(await readCheckpoint(job)).toMatchObject({ phase: "completed" });
  });

  it("fails closed on a damaged checkpoint without overwriting it", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async () => { throw new Error("provider must not run"); },
        uuid: () => "request-corrupt",
        checkpointEvent: (event) => {
          if (event.event === "after-initial-checkpoint") throw new Error("stop after checkpoint");
        },
      },
    })).rejects.toThrow("stop after checkpoint");
    const [checkpoint] = await checkpointFiles(job);
    await writeFile(checkpoint as string, "not-json\n");
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async () => { throw new Error("provider must not run after corruption"); },
      },
    })).rejects.toMatchObject({ code: "cloud_transcription_checkpoint_corrupt" });
    expect(await readFile(checkpoint as string, "utf8")).toBe("not-json\n");
  });

  it("rejects reuse when media or ASR configuration changed under the same output", async () => {
    const cases: Array<{
      name: string;
      mutate?: (video: string) => Promise<void>;
      options?: Partial<Parameters<typeof transcribeKouboVideo>[1]>;
      field: string;
    }> = [
      { name: "media", mutate: (video) => writeFile(video, "changed-video"), field: "mediaSha256" },
      { name: "language", options: { language: "en-US" }, field: "language" },
      { name: "model", options: { modelName: "other-model" }, field: "modelName" },
      { name: "resource", options: { resourceId: "other-resource" }, field: "resourceId" },
    ];
    for (const item of cases) {
      const { job, video } = await fixture();
      await expect(transcribeKouboVideo(job, {
        video: "uploads/source.mp4",
        output: "cloud/transcript.json",
        apiKey: "test-key",
        dependencies: {
          probe,
          extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
          fetch: async () => { throw new Error("provider must not run"); },
          uuid: () => `request-${item.name}`,
          checkpointEvent: (event) => {
            if (event.event === "after-initial-checkpoint") throw new Error(`checkpoint ${item.name}`);
          },
        },
      })).rejects.toThrow(`checkpoint ${item.name}`);
      await item.mutate?.(video);
      await expect(transcribeKouboVideo(job, {
        video: "uploads/source.mp4",
        output: "cloud/transcript.json",
        apiKey: "test-key",
        ...item.options,
        dependencies: {
          probe,
          extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
          fetch: async () => { throw new Error("provider must not run after identity mismatch"); },
          uuid: () => { throw new Error("identity mismatch must not mint a new request id"); },
        },
      })).rejects.toMatchObject({
        code: "cloud_transcription_checkpoint_mismatch",
        details: { field: item.field },
      });
    }
  });

  it("serializes concurrent retries so only one submit and one request id are created", async () => {
    const { job } = await fixture();
    let submitCalls = 0;
    let queryCalls = 0;
    let uuidCalls = 0;
    const run = () => transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 4,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => {
          if (url.endsWith("/submit")) {
            submitCalls += 1;
            return response(null, "20000000", { "x-tt-logid": "log-concurrent" });
          }
          queryCalls += 1;
          return completedQuery();
        },
        uuid: () => {
          uuidCalls += 1;
          return "request-concurrent";
        },
      },
    });

    const settled = await Promise.allSettled([run(), run()]);
    expect(submitCalls).toBe(1);
    expect(uuidCalls).toBe(1);
    expect(queryCalls).toBeGreaterThanOrEqual(1);
    expect(settled.some((item) => item.status === "fulfilled")).toBe(true);
    expect(settled.every((item) =>
      item.status === "fulfilled" ||
      (item.reason as { code?: string }).code === "invalid_argument")).toBe(true);
    expect(await readCheckpoint(job)).toMatchObject({
      requestId: "request-concurrent",
      phase: "completed",
      logid: "log-concurrent",
    });
  });

  it("generates identical transcript identity from identical provider words", () => {
    const input = {
      result: { result: { utterances: [{ words: [{ text: "词", start_time: 100, end_time: 400 }] }] } },
      language: "zh-CN",
      duration: 1,
    };
    expect(buildVolcengineTranscript(input)).toEqual(buildVolcengineTranscript(input));
  });

  it("fails closed without a cloud credential or output file", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "",
    })).rejects.toMatchObject({ code: "missing_cloud_transcription_adapter" });
    await expect(readFile(join(job, "cloud", "transcript.json"), "utf8")).rejects.toThrow();
  });

  it("does not publish output for a terminal provider failure", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (url) => url.endsWith("/submit")
          ? response({ result: {} })
          : response({ result: {} }, "40000001"),
        sleep: async () => {},
      },
    })).rejects.toMatchObject({ code: "cloud_transcription_failed" });
    await expect(readFile(join(job, "cloud", "transcript.json"), "utf8")).rejects.toThrow();
  });

  it("returns a stable provider failure without output when the network rejects", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async () => { throw new Error("network unavailable"); },
      },
    })).rejects.toMatchObject({
      code: "cloud_transcription_failed",
      details: { stage: "submit", causeType: "Error" },
    });
    expect(await readCheckpoint(job)).toMatchObject({
      phase: "recovery_blocked",
      error: { kind: "network_error", stage: "submit" },
    });
    await expect(readFile(join(job, "cloud", "transcript.json"), "utf8")).rejects.toThrow();
  });

  it("persists external cancellation separately from request timeout and network errors", async () => {
    const { job } = await fixture();
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    controller.abort(reason);
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      signal: controller.signal,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => { await writeFile(output, "fixture-audio"); },
        fetch: async (_url, init) => {
          throw (init.signal as AbortSignal).reason;
        },
        uuid: () => "request-cancelled",
      },
    })).rejects.toMatchObject({
      code: "cloud_transcription_cancelled",
      details: { kind: "external_cancel", stage: "submit", checkpointPhase: "cancelled" },
    });
    expect(await readCheckpoint(job)).toMatchObject({
      phase: "cancelled",
      error: { kind: "external_cancel", stage: "submit" },
    });
  });

  it("rejects output outside the task directory before cloud work begins", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "../outside.json",
      apiKey: "test-key",
    })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("提取音频回退到 wav 档时，ASR 请求声明的 format 跟着变", async () => {
    // 2026-08-04 Windows 用户真机：他的 ffmpeg 构建连 file:C:/… 正斜杠也推断不出
    // 输出格式。修法是显式 -f + 档位回退；但回退成 wav 后如果请求里还硬编码
    // "mp3"，就是骗服务端 —— 格式必须从提取一路传到请求体。
    const { job } = await fixture();
    const requests: Array<{ url: string; body: unknown }> = [];
    await transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "cloud/transcript.json",
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      dependencies: {
        probe,
        extractAudio: async (_input, output) => {
          await writeFile(output, "fixture-audio");
          return "wav";
        },
        fetch: async (url, init) => {
          requests.push({ url, body: JSON.parse(String(init.body)) });
          if (url.endsWith("/submit")) return response({ result: {} });
          return response({
            result: { utterances: [{ words: [{ text: "你", start_time: 0, end_time: 200 }] }] },
          });
        },
        sleep: async () => {},
        uuid: () => "request-id",
      },
    });
    expect(requests[0]?.body).toMatchObject({ audio: { format: "wav" } });
  });
});

describe("剪后音频参数", () => {
  const ranges = [{ start: 0, end: 1 }];

  it("显式写 -f，不让 ffmpeg 从文件名推断输出格式", () => {
    const args = buildCutAudioArgs("/a/source.mp4", ranges, "/a/audio.mp3");
    const formatFlag = args.indexOf("-f");
    expect(formatFlag).toBeGreaterThan(-1);
    expect(args[formatFlag + 1]).toBe("mp3");
  });

  it("wav 档带 16k 单声道重采样，与 ASR 声明的 rate/bits/channel 一致", () => {
    const wav = { format: "wav", codec: "pcm_s16le", extraArgs: ["-ar", "16000", "-ac", "1"] };
    const args = buildCutAudioArgs("/a/source.mp4", ranges, "/a/audio.mp3", wav);
    expect(args.join(" ")).toContain("-acodec pcm_s16le -ar 16000 -ac 1 -f wav");
  });
});


describe("标点", () => {
  /** The two views the provider returns of one utterance. */
  function response(text: string, words: string[]) {
    return {
      utterances: [{
        text,
        words: words.map((word, index) => ({
          text: word,
          start_time: index * 200,
          end_time: (index + 1) * 200,
        })),
      }],
    };
  }

  function spokenWords(result: unknown) {
    return buildVolcengineTranscript({ result, language: "zh-CN", duration: 10 })
      .cues.flatMap((cue) => cue.words)
      .filter((word) => word.isGap !== true);
  }

  it("把标点贴到它跟着的那个词上，而不是并进 text", () => {
    // 词典按整词匹配、transcript correct 逐词比对 —— 「站」变成「站。」两边都会失配。
    expect(spokenWords(response("你好，世界。", ["你", "好", "世", "界"]))
      .map((word) => [word.text, word.punctuation ?? null]))
      .toEqual([["你", null], ["好", "，"], ["世", null], ["界", "。"]]);
  });

  it("忽略整句里的空格 —— 中英混排时它会插空格", () => {
    const words = spokenWords(response("国内外 AI 团队。", ["国", "内", "外", "AI", "团", "队"]));
    expect(words.at(-1)?.punctuation).toBe("。");
    expect(words.map((word) => word.text).join("")).toBe("国内外AI团队");
  });

  it("两边对不上时整句放弃，不把标点滑到碰巧对齐的词上", () => {
    // ITN 会把「二零二六」重写成「2026」，只重写整句那一边。
    // 少一个句号只是断行差一点；标错位置会把句尾放进句子中间。
    expect(spokenWords(response("2026 年。", ["二", "零", "二", "六", "年"]))
      .every((word) => word.punctuation === undefined)).toBe(true);
  });

  it("provider 不给整句时，退回原来的行为", () => {
    const words = spokenWords({
      utterances: [{ words: [{ text: "你", start_time: 0, end_time: 200 }] }],
    });
    expect(words).toHaveLength(1);
    expect(words[0]?.punctuation).toBeUndefined();
  });
});
