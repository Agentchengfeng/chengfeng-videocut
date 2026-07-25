export type ProjectFileChangeListener = (payload?: unknown) => void;

interface ProjectFileChangeHotChannel {
  on(event: "hf:file-change", listener: ProjectFileChangeListener): void;
  off?(event: "hf:file-change", listener: ProjectFileChangeListener): void;
}

interface ProjectEventSource {
  addEventListener(type: "file-change", listener: (event: Event) => void): void;
  removeEventListener(type: "file-change", listener: (event: Event) => void): void;
  close(): void;
}

interface ProjectFileChangeHubOptions {
  hot?: ProjectFileChangeHotChannel | null;
  createEventSource?: (url: string) => ProjectEventSource;
}

export interface ProjectFileChangeHub {
  subscribe(listener: ProjectFileChangeListener): () => void;
}

/**
 * Own the project file-change transport for Product Studio consumers.
 *
 * Vite development uses its native HMR event. Packaged/served Studio uses a
 * single shared SSE connection, avoiding one long-lived HTTP stream per hook.
 */
export function createProjectFileChangeHub(
  options: ProjectFileChangeHubOptions = {},
): ProjectFileChangeHub {
  const hot = options.hot ?? null;
  const createEventSource = options.createEventSource
    ?? ((url: string) => new EventSource(url));
  const listeners = new Set<ProjectFileChangeListener>();
  let source: ProjectEventSource | null = null;
  let hotConnected = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (payload?: unknown) => {
    for (const listener of [...listeners]) listener(payload);
  };
  const dispatchServerEvent = (event: Event) => dispatch(event);

  const connect = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (hot) {
      if (!hotConnected) {
        hot.on("hf:file-change", dispatch);
        hotConnected = true;
      }
      return;
    }
    if (source) return;
    source = createEventSource("/api/events");
    source.addEventListener("file-change", dispatchServerEvent);
  };

  const disconnect = () => {
    if (hotConnected) {
      hot?.off?.("hf:file-change", dispatch);
      hotConnected = false;
    }
    if (source) {
      source.removeEventListener("file-change", dispatchServerEvent);
      source.close();
      source = null;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      connect();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size > 0 || closeTimer !== null) return;
        // Coalesce React StrictMode's mount -> cleanup -> mount probe so it
        // does not briefly create two concurrent event transports.
        closeTimer = setTimeout(() => {
          closeTimer = null;
          if (listeners.size === 0) disconnect();
        }, 0);
      };
    },
  };
}

const projectFileChangeHub = createProjectFileChangeHub({ hot: import.meta.hot });

export const subscribeProjectFileChanges = projectFileChangeHub.subscribe;
