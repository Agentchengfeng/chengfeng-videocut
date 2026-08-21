export async function withOwnedAbortTimeout<T>(
  milliseconds: number,
  operation: (signal: AbortSignal, timeoutSignal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError("timeout must be a positive finite number");
  }

  // Keep this Product-owned on every platform. Bun 1.3.5 on Windows can leave
  // AbortSignal.timeout() pending forever (oven-sh/bun#33334).
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException("The operation timed out", "TimeoutError"));
  }, milliseconds);

  const timeoutSignal = timeoutController.signal;
  if (!externalSignal) {
    try {
      return await operation(timeoutSignal, timeoutSignal);
    } finally {
      clearTimeout(timer);
    }
  }

  const combinedController = new AbortController();
  const forwardTimeout = () => {
    if (!combinedController.signal.aborted) combinedController.abort(timeoutSignal.reason);
  };
  const forwardExternal = () => {
    if (!combinedController.signal.aborted) combinedController.abort(externalSignal.reason);
  };
  if (externalSignal.aborted) forwardExternal();
  else {
    timeoutSignal.addEventListener("abort", forwardTimeout, { once: true });
    externalSignal.addEventListener("abort", forwardExternal, { once: true });
  }

  try {
    return await operation(combinedController.signal, timeoutSignal);
  } finally {
    clearTimeout(timer);
    timeoutSignal.removeEventListener("abort", forwardTimeout);
    externalSignal.removeEventListener("abort", forwardExternal);
  }
}
