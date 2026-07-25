type ProjectFileChangeListener = (payload?: unknown) => void;

const listeners = new Set<ProjectFileChangeListener>();
let source: EventSource | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const dispatchFileChange = (event: Event) => {
  for (const listener of [...listeners]) listener(event);
};

function ensureSource(): EventSource {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (source) return source;
  source = new EventSource("/api/events");
  source.addEventListener("file-change", dispatchFileChange);
  return source;
}

/**
 * Share one native EventSource across every Studio file-change consumer.
 *
 * A Studio page can mount preview persistence, SDK session, transcript, cuts,
 * and edit-list listeners at the same time. Opening one HTTP/1.1 stream per
 * hook exhausts the browser's per-origin connection pool once media starts.
 */
export function subscribeProjectFileChanges(
  listener: ProjectFileChangeListener,
): () => void {
  listeners.add(listener);
  ensureSource();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || closeTimer !== null) return;
    // Coalesce React StrictMode's mount -> cleanup -> mount probe so it does
    // not briefly create two concurrent SSE connections.
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (listeners.size > 0) return;
      source?.removeEventListener("file-change", dispatchFileChange);
      source?.close();
      source = null;
    }, 0);
  };
}
