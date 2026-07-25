import { serializeProjectOperation } from "@video-workbench/core/node";

/**
 * Uses the core project lock shared by Cuts, EDL, Studio and Koubo workflow
 * writes. Keeping this adapter name avoids churn for callers while ensuring
 * separate processes cannot race the same revision check.
 */
export async function serializeKouboProjectOperation<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeProjectOperation(directory, operation);
}
