import { describe, expect, it } from "bun:test";
import { RUNTIME_CLI_COMMANDS, type RuntimeCliCommand } from "@video-workbench/contracts";
import { parseArgs } from "./args";
import { HELP_TEXT } from "./output";

type PublicRuntimeCliCommand = {
  [K in RuntimeCliCommand]: typeof RUNTIME_CLI_COMMANDS[K]["public"] extends true ? K : never
}[RuntimeCliCommand];

const revision = "a".repeat(64);

const publicCommandSamples = {
  help: ["--help"],
  version: ["--version"],
  start: ["start"],
  "service.install": ["service", "install"],
  "service.start": ["service", "start"],
  "service.stop": ["service", "stop"],
  "service.restart": ["service", "restart"],
  "service.status": ["service", "status"],
  "service.logs": ["service", "logs"],
  "service.ensure": ["service", "ensure"],
  doctor: ["doctor"],
  "config.get": ["config", "get"],
  "config.set": ["config", "set", "transcription.apiKey", "secret"],
  inspect: ["inspect", "demo"],
  open: ["open", "demo"],
  transcribe: ["transcribe", "task", "--video", "source.mp4", "--output", "words.json"],
  "project.ingest": ["project", "ingest", "task", "--video", "source.mp4"],
  "project.create": ["project", "create", "task", "--video", "source.mp4", "--transcript", "words.json"],
  "project.prepare": ["project", "prepare", "task"],
  "artifact.put": [
    "artifact", "put", "demo",
    "--type", "timeline",
    "--file", "timeline.json",
    "--expected-project-revision", revision,
    "--expected-artifact-revision", "none",
  ],
  "cuts.get": ["cuts", "get", "demo"],
  "transcript.playback": ["transcript", "playback", "demo"],
  "transcript.retranscribe": ["transcript", "retranscribe", "demo", "--output", "words.json"],
  "transcript.align": ["transcript", "align", "demo", "--script", "script.txt"],
  "transcript.dictionary": ["transcript", "dictionary", "demo", "--dictionary", "dict.json"],
  "transcript.regroup": ["transcript", "regroup", "demo"],
  "transcript.correct": ["transcript", "correct", "demo", "--file", "corrections.json"],
  "cuts.set": ["cuts", "set", "demo", "--file", "cuts.json", "--expected-revision", "none"],
  "cuts.apply": [
    "cuts", "apply", "demo",
    "--expected-revision", revision,
    "--expected-edit-list-revision", revision,
    "--confirmed",
  ],
  "editList.get": ["edit-list", "get", "demo"],
  "editList.patch": ["edit-list", "patch", "demo", "--file", "operation.json", "--expected-revision", "none"],
  "subtitle.get": ["subtitle", "get", "demo"],
  "subtitle.build": ["subtitle", "build", "demo"],
  "subtitle.set": ["subtitle", "set", "demo", "--file", "subtitles.json"],
  "visual.get": ["visual", "get", "demo"],
  "visual.add": ["visual", "add", "demo", "--module", "layers/title.html", "--cues", "cue-1"],
  "visual.remove": ["visual", "remove", "demo", "--id", "layer-1"],
  "visual.frame": ["visual", "frame", "demo", "--cues", "cue-1"],
  "workflow.get": ["workflow", "get", "demo"],
  "workflow.transition": [
    "workflow", "transition", "demo",
    "--action", "start-final",
    "--expected-revision", revision,
    "--confirmed",
  ],
  "render.run": ["render", "run", "demo", "--expected-revision", revision, "--confirmed"],
  export: ["export", "demo"],
  "job.start": ["job", "start", "export", "demo"],
  "job.get": ["job", "get", "job-1"],
  "job.list": ["job", "list"],
  "job.cancel": ["job", "cancel", "job-1"],
} as const satisfies Record<PublicRuntimeCliCommand, readonly string[]>;

function publicCommandIds(): PublicRuntimeCliCommand[] {
  return (Object.keys(RUNTIME_CLI_COMMANDS) as RuntimeCliCommand[])
    .filter((id): id is PublicRuntimeCliCommand => RUNTIME_CLI_COMMANDS[id].public);
}

function helpCommandIds(): RuntimeCliCommand[] {
  const ids = new Set<RuntimeCliCommand>();
  for (const line of HELP_TEXT.split("\n")) {
    const id = commandIdFromUsageLine(line);
    if (id) ids.add(id);
  }
  return [...ids];
}

function commandIdFromUsageLine(line: string): RuntimeCliCommand | null {
  const trimmed = line.trim();
  const prefix = "chengfeng-videocut ";
  if (!trimmed.startsWith(prefix)) return null;
  const tokens = trimmed.slice(prefix.length).split(/\s+/);
  const first = tokens[0];
  if (/^\d+\.\d+\.\d+/.test(first)) return null;
  if (first === "--help") return "help";
  if (first === "--version") return "version";
  const twoPartPrefixes: Record<string, string> = {
    artifact: "artifact",
    config: "config",
    cuts: "cuts",
    "edit-list": "editList",
    job: "job",
    project: "project",
    render: "render",
    service: "service",
    subtitle: "subtitle",
    transcript: "transcript",
    visual: "visual",
    workflow: "workflow",
  };
  const command = twoPartPrefixes[first] && tokens[1]
    ? `${twoPartPrefixes[first]}.${tokens[1]}`
    : first;
  if (!Object.hasOwn(RUNTIME_CLI_COMMANDS, command)) {
    throw new Error(`HELP_TEXT usage line is not in RUNTIME_CLI_COMMANDS: ${trimmed}`);
  }
  return command as RuntimeCliCommand;
}

describe("start argument parser", () => {
  it("keeps public command contract, help text, and parser coverage aligned", () => {
    const contractIds = publicCommandIds().sort();
    expect(helpCommandIds().sort()).toEqual(contractIds);
    for (const id of contractIds) {
      expect(parseArgs(publicCommandSamples[id]).command).toBe(id);
    }
  });

  it("parses durable job start/get/list/cancel commands", () => {
    expect(parseArgs(["job", "start", "export", "/tmp/project", "--out", "/tmp/out.mp4"])).toMatchObject({
      command: "job.start", jobKind: "export", project: "/tmp/project", outFile: "/tmp/out.mp4",
    });
    expect(parseArgs(["job", "get", "abc"])).toMatchObject({ command: "job.get", jobId: "abc" });
    expect(parseArgs(["job", "list", "--project", "demo", "--state", "queued", "--limit", "25"])).toMatchObject({
      command: "job.list", projectFilter: "demo", jobState: "queued", jobLimit: 25,
    });
    expect(parseArgs(["job", "cancel", "abc"])).toMatchObject({ command: "job.cancel", jobId: "abc" });
  });
  it("parses defaults and supports an ephemeral port", () => {
    expect(parseArgs(["start"])).toMatchObject({
      command: "start",
      json: false,
      openBrowser: false,
    });
    expect(
      parseArgs([
        "start",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--projects-dir",
        "/tmp/projects",
        "--data-dir",
        "/tmp/data",
        "--open",
        "--json",
      ]),
    ).toMatchObject({
      command: "start",
      host: "0.0.0.0",
      port: 0,
      projectsDir: "/tmp/projects",
      dataDir: "/tmp/data",
      openBrowser: true,
      json: true,
    });
  });

  it("rejects invalid ports and start-only browser flags", () => {
    expect(() => parseArgs(["start", "--port", "65536"])).toThrow(
      "--port must be an integer",
    );
    expect(() => parseArgs(["doctor", "--open"])).toThrow(
      "--open is only valid for start or service ensure",
    );
  });

  it("keeps local development authorization explicit and doctor-only", () => {
    expect(parseArgs(["doctor", "--local-development", "--json"])).toMatchObject({
      command: "doctor",
      localDevelopment: true,
      json: true,
    });
    expect(parseArgs(["doctor", "--json"])).toMatchObject({
      command: "doctor",
      localDevelopment: false,
    });
    expect(() => parseArgs(["start", "--local-development"]))
      .toThrow("--local-development is not valid for this command");
  });

  it("parses the complete managed service lifecycle", () => {
    for (const action of ["install", "start", "stop", "restart", "status", "ensure"]) {
      expect(parseArgs(["service", action, "--json"])).toMatchObject({
        command: `service.${action}`,
        json: true,
      });
    }
    expect(parseArgs(["service", "logs", "--lines", "75"])).toMatchObject({
      command: "service.logs",
      logLines: 75,
    });
    expect(parseArgs(["service", "ensure", "--open"])).toMatchObject({
      command: "service.ensure",
      openBrowser: true,
    });
    expect(() => parseArgs(["service", "logs", "--lines", "1001"]))
      .toThrow("--lines must be an integer from 1 to 1000");
    expect(() => parseArgs(["service", "start", "--open"]))
      .toThrow("--open is only valid for start or service ensure");
    expect(() => parseArgs(["service", "unknown"]))
      .toThrow("service <install|start|stop|restart|status|logs|ensure>");
  });

  it("requires optimistic concurrency for cuts writes", () => {
    expect(parseArgs([
      "cuts", "get", "demo", "--api-base", "http://127.0.0.1:5190", "--json",
    ])).toMatchObject({
      command: "cuts.get",
      project: "demo",
      apiBase: "http://127.0.0.1:5190",
      json: true,
    });
    expect(() => parseArgs(["cuts", "set", "demo", "--file", "cuts.json"])).toThrow(
      "requires --expected-revision",
    );
    expect(
      parseArgs(["cuts", "set", "demo", "--file", "cuts.json", "--dry-run"]),
    ).toMatchObject({ command: "cuts.set", dryRun: true });
  });

  it("parses the edit-list read and segment-level write commands", () => {
    const revision = "a".repeat(64);
    expect(parseArgs(["edit-list", "get", "demo", "--json"])).toMatchObject({
      command: "editList.get",
      project: "demo",
      json: true,
    });
    expect(parseArgs([
      "edit-list", "patch", "demo",
      "--file", "op.json",
      "--expected-revision", revision,
      "--json",
    ])).toMatchObject({
      command: "editList.patch",
      project: "demo",
      file: "op.json",
      expectedRevision: revision,
      json: true,
    });

    // A segment-level write must always name the revision it was built against;
    // there is no dry-run escape hatch here, because a dry run that skipped the
    // edit-list guards is exactly what used to report success and then 409.
    expect(() => parseArgs(["edit-list", "patch", "demo", "--file", "op.json"])).toThrow(
      "requires --expected-revision",
    );
    expect(() => parseArgs([
      "edit-list", "patch", "demo", "--file", "op.json", "--dry-run",
    ])).toThrow("requires --expected-revision");
    expect(() => parseArgs([
      "edit-list", "patch", "demo", "--expected-revision", revision,
    ])).toThrow("requires --file");
    expect(() => parseArgs([
      "edit-list", "patch", "demo", "--file", "op.json", "--expected-revision", "nope",
    ])).toThrow("must be 'none' or a SHA-256 revision");
    expect(() => parseArgs(["edit-list", "frobnicate", "demo"])).toThrow("Unknown command");
  });

  it("parses task-local project preparation flags", () => {
    expect(parseArgs([
      "project", "create", "/tmp/job",
      "--video", "uploads/talk.mp4",
      "--transcript", "cloud/words.json",
      "--aspect-ratio", "4:3",
      "--projects-dir", "/tmp/projects",
      "--json",
    ])).toMatchObject({
      command: "project.create",
      project: "/tmp/job",
      video: "uploads/talk.mp4",
      transcript: "cloud/words.json",
      aspectRatio: "4:3",
      projectsDir: "/tmp/projects",
      json: true,
    });
    // 画幅比由视频定义：省略即推导，任意合法 W:H 都收，只拒格式垃圾。
    expect(parseArgs([
      "project", "create", "/tmp/job",
      "--video", "input/source.mp4",
      "--transcript", "words.json",
    ])).toMatchObject({ command: "project.create", aspectRatio: undefined });
    expect(parseArgs([
      "project", "create", "/tmp/job",
      "--video", "input/source.mp4",
      "--transcript", "words.json",
      "--aspect-ratio", "9:16",
    ])).toMatchObject({ aspectRatio: "9:16" });
    expect(() => parseArgs([
      "project", "create", "/tmp/job",
      "--video", "input/source.mp4",
      "--transcript", "words.json",
      "--aspect-ratio", "wide",
    ])).toThrow("must be W:H");

    expect(parseArgs([
      "project", "prepare", "/tmp/job",
      "--video", "input/source.mp4",
      "--transcript", "input/words.json",
      "--duration", "12.5",
      "--force-index",
      "--refresh-transcript",
    ])).toMatchObject({
      command: "project.prepare",
      project: "/tmp/job",
      video: "input/source.mp4",
      transcript: "input/words.json",
      duration: 12.5,
      forceIndex: true,
      refreshTranscript: true,
    });
    expect(() => parseArgs(["project", "prepare", "/tmp/job", "--duration", "0"]))
      .toThrow("--duration must be a positive number");
  });

  it("parses task-local cloud transcription without creating a project", () => {
    expect(parseArgs([
      "transcribe", "/tmp/job",
      "--video", "uploads/talk.mp4",
      "--output", "cloud/transcript.json",
      "--language", "zh-CN",
      "--json",
    ])).toMatchObject({
      command: "transcribe",
      project: "/tmp/job",
      video: "uploads/talk.mp4",
      output: "cloud/transcript.json",
      language: "zh-CN",
      json: true,
    });
    expect(() => parseArgs(["transcribe", "/tmp/job", "--video", "uploads/talk.mp4"]))
      .toThrow("transcribe requires --output");
    expect(() => parseArgs([
      "transcribe", "/tmp/job", "--video", "uploads/talk.mp4",
      "--output", "cloud/transcript.json", "--aspect-ratio", "4:3",
    ])).toThrow("--aspect-ratio is not valid for this command");
  });

  it("parses Product-owned project ingest without raw transcript paths", () => {
    expect(parseArgs([
      "project", "ingest", "/tmp/job",
      "--video", "uploads/talk.mp4",
      "--language", "zh-CN",
      "--aspect-ratio", "16:9",
      "--projects-dir", "/tmp/projects",
      "--json",
    ])).toMatchObject({
      command: "project.ingest",
      project: "/tmp/job",
      video: "uploads/talk.mp4",
      language: "zh-CN",
      aspectRatio: "16:9",
      projectsDir: "/tmp/projects",
      output: undefined,
      transcript: undefined,
      json: true,
    });
    expect(() => parseArgs([
      "project", "ingest", "/tmp/job", "--video", "uploads/talk.mp4",
      "--output", "transcript.json",
    ])).toThrow("--output is not valid for this command");
    expect(() => parseArgs([
      "project", "ingest", "/tmp/job", "--video", "uploads/talk.mp4",
      "--transcript", "words.json",
    ])).toThrow("--transcript is not valid for this command");
  });

  it("parses a bounded transcript playback page and rejects unrelated cursor options", () => {
    expect(parseArgs([
      "transcript", "playback", "demo",
      "--limit", "64",
      "--cursor", "eyJzY2hlbWFWZXJzaW9uIjoxfQ",
      "--json",
    ])).toMatchObject({
      command: "transcript.playback",
      project: "demo",
      jobLimit: 64,
      playbackCursor: "eyJzY2hlbWFWZXJzaW9uIjoxfQ",
      json: true,
    });
    expect(() => parseArgs([
      "transcript", "playback", "demo", "--limit", "101",
    ])).toThrow("--limit must be an integer from 1 to 100");
    expect(() => parseArgs([
      "transcript", "dictionary", "demo", "--cursor", "not-allowed",
    ])).toThrow("--cursor is not valid for this command");
  });

  it("requires both project and artifact revisions for controlled artifacts", () => {
    const revision = "a".repeat(64);
    expect(parseArgs([
      "artifact", "put", "demo",
      "--type", "timeline",
      "--file", "timeline.json",
      "--expected-project-revision", revision,
      "--expected-artifact-revision", "none",
    ])).toMatchObject({
      command: "artifact.put",
      artifactType: "timeline",
      expectedProjectRevision: revision,
      expectedArtifactRevision: "none",
    });
    expect(() => parseArgs([
      "artifact", "put", "demo", "--type", "timeline", "--file", "timeline.json",
    ])).toThrow("--expected-project-revision is required");
  });

  it("requires explicit confirmation and CAS for physical cuts and transitions", () => {
    const revision = "b".repeat(64);
    const editListRevision = "e".repeat(64);
    expect(parseArgs([
      "cuts", "apply", "demo",
      "--expected-revision", revision,
      "--expected-edit-list-revision", editListRevision,
      "--confirmed",
    ])).toMatchObject({
      command: "cuts.apply",
      confirmed: true,
      expectedRevision: revision,
      expectedEditListRevision: editListRevision,
    });
    expect(() => parseArgs([
      "cuts", "apply", "demo",
      "--expected-revision", revision,
      "--expected-edit-list-revision", "none",
      "--confirmed",
    ])).toThrow("requires a prepared edit-list.json revision");
    expect(() => parseArgs([
      "cuts", "apply", "demo", "--expected-revision", revision, "--confirmed",
    ])).toThrow("requires --expected-edit-list-revision");
    expect(() => parseArgs([
      "cuts", "apply", "demo",
      "--expected-revision", revision,
      "--expected-edit-list-revision", editListRevision,
    ])).toThrow("cuts apply requires --confirmed");
    expect(parseArgs([
      "workflow", "transition", "demo",
      "--action", "confirm-storyboard",
      "--expected-revision", revision,
      "--confirmed",
    ])).toMatchObject({
      command: "workflow.transition",
      action: "confirm-storyboard",
      confirmed: true,
    });
  });

  it("parses confirmation-gated local rendering with an optional absolute renderer", () => {
    const revision = "c".repeat(64);
    expect(parseArgs([
      "render", "run", "demo",
      "--expected-revision", revision,
      "--confirmed",
      "--renderer", "/opt/chengfeng/export_final_video.cjs",
      "--projects-dir", "/tmp/projects",
      "--output-dir", "/tmp/output",
      "--json",
    ])).toMatchObject({
      command: "render.run",
      project: "demo",
      expectedRevision: revision,
      confirmed: true,
      renderer: "/opt/chengfeng/export_final_video.cjs",
      projectsDir: "/tmp/projects",
      outputDir: "/tmp/output",
      json: true,
    });
    expect(() => parseArgs([
      "render", "run", "demo", "--expected-revision", revision,
    ])).toThrow("render run requires --confirmed");
    expect(() => parseArgs([
      "render", "run", "demo", "--expected-revision", "none", "--confirmed",
    ])).toThrow("render run requires --expected-revision");
    expect(() => parseArgs([
      "render", "run", "demo", "--expected-revision", revision, "--confirmed",
      "--renderer", "relative/exporter.cjs",
    ])).toThrow("--renderer must be an absolute file path");
  });
});
