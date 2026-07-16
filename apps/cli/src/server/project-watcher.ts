import { readdirSync, realpathSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { extname, join } from "node:path";
import type { StudioEventHub } from "./events";

const WATCHED_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".mjs"]);
const REGISTRY_RESCAN_DELAY_MS = 25;
const REGISTRY_RESCAN_INTERVAL_MS = 500;

type EventPublisher = Pick<StudioEventHub, "publish">;

interface ProjectWatch {
  directory: string;
  watcher: FSWatcher;
}

export interface RegisteredProjectWatcher {
  close(): void;
}

function closeWatcher(watcher: FSWatcher | undefined): void {
  try {
    watcher?.close();
  } catch {
    // Closing an already-closed native watcher is harmless for shutdown.
  }
}

/**
 * Watch the project registry and reconcile project-directory watchers whenever
 * a registration is added, removed, or points at a different real directory.
 */
export function watchRegisteredProjects(
  projectsDir: string,
  events: EventPublisher,
): RegisteredProjectWatcher {
  const projectWatches = new Map<string, ProjectWatch>();
  let registryWatcher: FSWatcher | undefined;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  let rescanInterval: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const removeProjectWatch = (projectId: string): void => {
    const current = projectWatches.get(projectId);
    if (!current) return;
    projectWatches.delete(projectId);
    closeWatcher(current.watcher);
  };

  const addProjectWatch = (projectId: string, projectDir: string): void => {
    try {
      const watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
        if (closed || !filename) return;
        const changedPath = join(projectDir, filename.toString());
        if (!WATCHED_EXTENSIONS.has(extname(changedPath).toLowerCase())) return;
        events.publish("file-change", { path: changedPath, projectId });
      });
      watcher.on("error", () => {
        const current = projectWatches.get(projectId);
        if (current?.watcher === watcher) removeProjectWatch(projectId);
      });
      watcher.unref();
      projectWatches.set(projectId, { directory: projectDir, watcher });
    } catch {
      // Some platforms do not support recursive watching. The Studio remains
      // usable; product-owned API writes still emit their own notifications.
    }
  };

  const reconcile = (): void => {
    if (closed) return;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return;
    }

    const registered = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const projectId = entry.name;
      registered.add(projectId);

      let projectDir: string;
      try {
        projectDir = realpathSync(join(projectsDir, projectId));
      } catch {
        continue;
      }

      const current = projectWatches.get(projectId);
      if (current?.directory === projectDir) continue;
      removeProjectWatch(projectId);
      addProjectWatch(projectId, projectDir);
    }

    for (const projectId of projectWatches.keys()) {
      if (!registered.has(projectId)) removeProjectWatch(projectId);
    }
  };

  const scheduleReconcile = (): void => {
    if (closed || rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined;
      reconcile();
    }, REGISTRY_RESCAN_DELAY_MS);
    rescanTimer.unref?.();
  };

  try {
    // Install the registry watcher before the first scan so a registration
    // created during startup cannot fall between those two operations.
    registryWatcher = watch(projectsDir, () => scheduleReconcile());
    registryWatcher.on("error", () => undefined);
    registryWatcher.unref();
  } catch {
    // Startup registrations are still watched even if the registry itself
    // cannot be watched on this platform.
  }
  reconcile();
  // Native directory notifications can be coalesced or dropped while a
  // registration directory is being created. A small unref'ed reconciliation
  // interval keeps post-start registrations deterministic without keeping the
  // process alive or polling project contents.
  rescanInterval = setInterval(reconcile, REGISTRY_RESCAN_INTERVAL_MS);
  rescanInterval.unref?.();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (rescanTimer) {
        clearTimeout(rescanTimer);
        rescanTimer = undefined;
      }
      if (rescanInterval) {
        clearInterval(rescanInterval);
        rescanInterval = undefined;
      }
      closeWatcher(registryWatcher);
      registryWatcher = undefined;
      for (const projectId of [...projectWatches.keys()]) removeProjectWatch(projectId);
    },
  };
}
