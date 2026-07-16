const projectQueues = new Map<string, Promise<void>>();

/**
 * Serializes all mutating operations for one canonical project directory in
 * this process. Every Koubo module that writes project.json or task artifacts
 * must use this shared queue so their revision checks cannot race each other.
 */
export async function serializeKouboProjectOperation<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectQueues.get(directory) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  projectQueues.set(directory, tail);
  void tail.then(() => {
    if (projectQueues.get(directory) === tail) projectQueues.delete(directory);
  });
  return result;
}
