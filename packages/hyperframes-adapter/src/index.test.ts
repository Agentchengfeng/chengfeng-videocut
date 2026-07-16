import { describe, expect, test } from "bun:test";
import { WORKBENCH_SCHEMA_VERSION } from "@video-workbench/contracts";
import { createHyperframesAdapter } from "./index";

describe("createHyperframesAdapter", () => {
  test("builds the Studio hash route without workflow knowledge", () => {
    const adapter = createHyperframesAdapter({ studioOrigin: "http://localhost:5200" });
    const url = adapter.buildPreviewUrl({
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      id: "demo",
      title: "Demo",
      duration: 16,
      engine: { kind: "hyperframes", projectId: "demo", entry: "index.html" },
    });

    expect(url).toBe("http://localhost:5200/#project/demo?v=1&t=0&tab=design&tv=1");
  });
});

