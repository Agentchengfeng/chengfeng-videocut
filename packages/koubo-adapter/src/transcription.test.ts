import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptWords } from "@video-workbench/core";
import { buildCutAudioArgs, buildVolcengineTranscript, transcribeKouboVideo } from "./transcription";

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
