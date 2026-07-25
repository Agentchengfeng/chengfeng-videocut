import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptWords } from "@video-workbench/core";
import { buildVolcengineTranscript, transcribeKouboVideo } from "./transcription";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function response(payload: unknown, status = "20000000") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === "x-api-status-code" ? status : null },
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
    await expect(readFile(join(job, "cloud", "transcript.json"), "utf8")).rejects.toThrow();
  });

  it("rejects output outside the task directory before cloud work begins", async () => {
    const { job } = await fixture();
    await expect(transcribeKouboVideo(job, {
      video: "uploads/source.mp4",
      output: "../outside.json",
      apiKey: "test-key",
    })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

