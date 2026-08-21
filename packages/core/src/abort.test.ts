import { describe, expect, it } from "bun:test";
import { withOwnedAbortTimeout } from "./abort";

describe("withOwnedAbortTimeout", () => {
  it("aborts with its own stable timeout reason", async () => {
    let timeoutReason: unknown;
    await expect(withOwnedAbortTimeout(1, async (signal, timeoutSignal) => {
      return await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          timeoutReason = timeoutSignal.reason;
          reject(signal.reason);
        }, { once: true });
      });
    })).rejects.toBeInstanceOf(DOMException);
    expect(timeoutReason).toBeInstanceOf(DOMException);
    expect((timeoutReason as DOMException).name).toBe("TimeoutError");
  });

  it("clears the deadline after a fast operation", async () => {
    let ownedSignal: AbortSignal | undefined;
    await expect(withOwnedAbortTimeout(20, async (_signal, timeoutSignal) => {
      ownedSignal = timeoutSignal;
      return "done";
    })).resolves.toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ownedSignal?.aborted).toBe(false);
  });

  it("preserves an external cancellation reason", async () => {
    const external = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    external.abort(reason);
    await expect(withOwnedAbortTimeout(100, async (signal) => {
      throw signal.reason;
    }, external.signal)).rejects.toBe(reason);
  });
});
