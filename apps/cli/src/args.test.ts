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
      "--open is only valid for start",
    );
  });

  it("requires optimistic concurrency for cuts writes", () => {
    expect(() => parseArgs(["cuts", "set", "demo", "--file", "cuts.json"])).toThrow(
      "requires --expected-revision",
    );
    expect(
      parseArgs(["cuts", "set", "demo", "--file", "cuts.json", "--dry-run"]),
    ).toMatchObject({ command: "cuts.set", dryRun: true });
  });

  it("parses task-local project preparation flags", () => {
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
    expect(parseArgs([
      "cuts", "apply", "demo", "--expected-revision", revision, "--confirmed",
    ])).toMatchObject({ command: "cuts.apply", confirmed: true, expectedRevision: revision });
    expect(() => parseArgs([
      "cuts", "apply", "demo", "--expected-revision", revision,
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
