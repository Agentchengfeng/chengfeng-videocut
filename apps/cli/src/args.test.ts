import { describe, expect, it } from "bun:test";
import { parseArgs } from "./args";

describe("start argument parser", () => {
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
    expect(() => parseArgs([
      "project", "create", "/tmp/job",
      "--video", "input/source.mp4",
      "--transcript", "words.json",
    ])).toThrow("--aspect-ratio must be");
    expect(() => parseArgs([
      "project", "create", "/tmp/job",
      "--video", "input/source.mp4",
      "--transcript", "words.json",
      "--aspect-ratio", "9:16",
    ])).toThrow("must be 3:4, 4:3, or 16:9");

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
