import { createHash } from "node:crypto";
import { buildPlaybackTranscript } from "./node";
import { parseTranscriptWords } from "./cuts";
import { parseEditListDocument } from "./editList";

// Documents are reread by the caller under its usual project guard. Cache only
// derived data keyed by exact bytes, never an authorization or filesystem read.
const cache = new Map<string, { value: ReturnType<typeof buildPlaybackTranscript>; bytes: number }>();
const MAX_BYTES = 16 * 1024 * 1024;
let bytes = 0;
export function cachedPlaybackTranscript(directory: string, projectId: string, transcript: string, editList: string | null) {
  // Length-prefixed UTF-8 fields avoid concatenation ambiguity and allocating
  // another full copy of both raw documents solely to form the cache key.
  const hash = createHash("sha256");
  for (const field of [directory, projectId, transcript, editList]) {
    if (field === null) hash.update("null:");
    else hash.update(`${Buffer.byteLength(field)}:`).update(field);
  }
  const key = hash.digest("hex");
  const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return structuredClone(found.value); }
  const value = buildPlaybackTranscript(projectId, parseTranscriptWords(JSON.parse(transcript)), editList === null ? null : parseEditListDocument(JSON.parse(editList)));
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size <= MAX_BYTES) {
    while (cache.size && (cache.size >= 16 || bytes + size > MAX_BYTES)) {
      const oldest = cache.keys().next().value!;
      bytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
    }
    cache.set(key, { value: structuredClone(value), bytes: size }); bytes += size;
  }
  return value;
}
