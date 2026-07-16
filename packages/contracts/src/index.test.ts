import { describe, expect, test } from "bun:test";
import {
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

