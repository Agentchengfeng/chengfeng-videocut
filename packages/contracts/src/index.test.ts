import { describe, expect, test } from "bun:test";
import {
  RUNTIME_CLI_COMMANDS,
  RUNTIME_DURABLE_JOB_KINDS,
  RUNTIME_SERVICE_OPERATIONS,
  createRuntimePluginContractSnapshot,
  createStudioCapabilityManifest,
  runtimeCliCommand,
  WORKBENCH_SCHEMA_VERSION,
  assertWorkbenchProjectManifest,
} from "./index";

describe("assertWorkbenchProjectManifest", () => {
  test("accepts the minimal engine-neutral manifest", () => {
    const manifest = {
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      id: "demo",
      title: "Demo",
      duration: 16,
      engine: { kind: "hyperframes", projectId: "demo", entry: "index.html" },
    };

    expect(() => assertWorkbenchProjectManifest(manifest)).not.toThrow();
  });

  test("rejects an unsupported schema", () => {
    expect(() =>
      assertWorkbenchProjectManifest({
        schemaVersion: 2,
        id: "demo",
        title: "Demo",
        duration: 16,
        engine: { kind: "hyperframes", projectId: "demo", entry: "index.html" },
      }),
    ).toThrow("Unsupported workbench schema");
  });
});

describe("Runtime capability and command contract", () => {
  test("projects the Studio capability manifest from the Runtime contract", () => {
    expect(createStudioCapabilityManifest("0.5.8")).toEqual({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      studioVersion: "0.5.8",
      features: {
        topLevelViews: ["storyboard", "preview", "koubo"],
        legacyWorkbenchPanel: false,
        managedTimelineEditing: true,
        projectIngestVersion: 1,
        transcriptPlaybackPagingVersion: 1,
        durableJobsApiVersion: 1,
        durableJobKinds: ["export"],
        operationAdmissionVersion: 1,
        operationAuditVersion: 1,
        operationIdempotencyVersion: 1,
        managedTimelineOperations: [
          "move",
          "trim",
          "split",
          "delete",
          "restore",
          "delete-range",
          "restore-snapshot",
        ],
      },
    });
  });

  test("binds Plugin-gated CLI commands to their capability contract", () => {
    expect(RUNTIME_CLI_COMMANDS["project.ingest"].features).toContainEqual({
      kind: "capability",
      capability: "projectIngestVersion",
    });
    for (const id of ["project.ingest", "cuts.set", "export", "job.start"] as const) {
      expect(RUNTIME_CLI_COMMANDS[id].features).toContainEqual({
        kind: "capability",
        capability: "operationAdmissionVersion",
      });
      expect(RUNTIME_CLI_COMMANDS[id].features).toContainEqual({
        kind: "capability",
        capability: "operationAuditVersion",
      });
      expect(RUNTIME_CLI_COMMANDS[id].features).toContainEqual({
        kind: "capability",
        capability: "operationIdempotencyVersion",
      });
    }
    expect(RUNTIME_CLI_COMMANDS["transcript.playback"].features).toContainEqual({
      kind: "capability",
      capability: "transcriptPlaybackPagingVersion",
    });
    expect(RUNTIME_CLI_COMMANDS.export.features).toContainEqual({
      kind: "durable-job",
      jobKind: "export",
    });
    expect(RUNTIME_CLI_COMMANDS["job.start"].features).toContainEqual({
      kind: "capability",
      capability: "durableJobsApiVersion",
    });
    for (const operation of RUNTIME_SERVICE_OPERATIONS) {
      expect(RUNTIME_CLI_COMMANDS[`service.${operation}`].features).toContainEqual({
        kind: "service",
        operation,
      });
    }
    expect(RUNTIME_DURABLE_JOB_KINDS).toEqual(["export"]);
  });

  test("rejects parser commands that are not registered in the contract", () => {
    expect(runtimeCliCommand("service.ensure")).toBe("service.ensure");
    expect(() => runtimeCliCommand("service.upgrade")).toThrow(
      "Unknown Runtime CLI command contract entry",
    );
  });

  test("exports the cross-repository Plugin contract snapshot", () => {
    const snapshot = createRuntimePluginContractSnapshot("0.5.8");
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      runtimeVersion: "0.5.8",
      minimumRuntimeVersion: "0.5.8",
      capabilities: {
        projectIngestVersion: 1,
        transcriptPlaybackPagingVersion: 1,
        operationAdmissionVersion: 1,
        operationAuditVersion: 1,
        operationIdempotencyVersion: 1,
        durableJobsApiVersion: 1,
        durableJobKinds: ["export"],
        serviceApiVersion: 1,
      },
      studioCapabilities: {
        topLevelViews: ["storyboard", "preview", "koubo"],
        legacyWorkbenchPanel: false,
        managedTimelineEditing: true,
      },
    });
    expect(snapshot.cli.commands["project.ingest"].features).toContainEqual({
      kind: "capability",
      capability: "projectIngestVersion",
    });
  });
});
