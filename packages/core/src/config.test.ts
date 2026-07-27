import { describe, expect, it } from "bun:test";
import {
  CONFIG_FIELDS,
  configField,
  maskSecret,
  parseProductConfig,
  resolveSetting,
  withSetting,
} from "./config";

describe("parseProductConfig", () => {
  it("keeps only the fields this version understands", () => {
    expect(parseProductConfig({
      transcription: { provider: "volcengine", apiKey: "k", somethingElse: 1 },
      unrelated: true,
    })).toEqual({ transcription: { provider: "volcengine", apiKey: "k" } });
  });

  it("treats a broken file as empty rather than throwing", () => {
    // A settings file with a stray comma must not fail the edit somebody is in
    // the middle of. The command that needs a key still says so by name.
    expect(parseProductConfig(null)).toEqual({});
    expect(parseProductConfig("nonsense")).toEqual({});
    expect(parseProductConfig({ transcription: "nonsense" })).toEqual({});
  });

  it("ignores a blank value, which is not the same as a set one", () => {
    expect(parseProductConfig({ transcription: { apiKey: "   " } })).toEqual({ transcription: {} });
  });
});

describe("resolveSetting", () => {
  const config = { transcription: { apiKey: "from-file" } };

  it("prefers the environment, so one command can be overridden without editing", () => {
    expect(resolveSetting("transcription.apiKey", config, { VOLCENGINE_API_KEY: "from-env" }))
      .toEqual({ value: "from-env", source: "env" });
  });

  it("falls back to the file", () => {
    expect(resolveSetting("transcription.apiKey", config, {}))
      .toEqual({ value: "from-file", source: "config" });
  });

  it("falls back to the built-in default when there is one", () => {
    expect(resolveSetting("transcription.resourceId", config, {}, "volc.seedasr.auc"))
      .toEqual({ value: "volc.seedasr.auc", source: "default" });
  });

  it("reports nothing rather than an empty string when unset", () => {
    expect(resolveSetting("transcription.apiKey", {}, {}))
      .toEqual({ value: undefined, source: "none" });
  });

  it("does not treat a blank environment variable as set", () => {
    expect(resolveSetting("transcription.apiKey", config, { VOLCENGINE_API_KEY: "  " }))
      .toEqual({ value: "from-file", source: "config" });
  });
});

describe("withSetting", () => {
  it("changes one field and leaves the rest alone", () => {
    const before = { transcription: { apiKey: "k", modelName: "bigmodel" } };
    expect(withSetting(before, "transcription.resourceId", "r")).toEqual({
      transcription: {
        provider: "volcengine",
        apiKey: "k",
        modelName: "bigmodel",
        resourceId: "r",
      },
    });
  });
});

describe("maskSecret", () => {
  it("shows enough to tell two keys apart and not enough to use either", () => {
    expect(maskSecret("a2376d64-cd6c-43a8-aa93-f674cc9c59ec")).toBe("a237••••••59ec");
  });

  it("reveals nothing at all from a short value", () => {
    expect(maskSecret("short")).toBe("•••••");
  });
});

describe("CONFIG_FIELDS", () => {
  it("names an environment variable for every setting", () => {
    // The environment override is the escape hatch for CI and a second account;
    // a setting with no variable would be file-only with no way around it.
    for (const field of CONFIG_FIELDS) {
      expect(field.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(configField(field.path)).toBe(field);
    }
  });

  it("marks the credential as secret and required", () => {
    const key = configField("transcription.apiKey");
    expect(key?.secret).toBe(true);
    expect(key?.required).toBe(true);
  });
});
