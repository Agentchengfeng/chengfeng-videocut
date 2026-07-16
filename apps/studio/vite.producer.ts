export function createRetryingModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;

  return async () => {
    if (!promise) {
      promise = load().catch((error) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}
