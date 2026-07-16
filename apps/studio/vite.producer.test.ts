import { describe, expect, it, vi } from "vitest";
import { createRetryingModuleLoader } from "./vite.producer";

describe("createRetryingModuleLoader", () => {
  it("retries after an initial load failure instead of caching the rejection", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const getModule = createRetryingModuleLoader(load);

    await expect(getModule()).rejects.toThrow("boom");
    await expect(getModule()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reuses the same promise after a successful load", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    const getModule = createRetryingModuleLoader(load);

    await expect(getModule()).resolves.toBe("ok");
    await expect(getModule()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
