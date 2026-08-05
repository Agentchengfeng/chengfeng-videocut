import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchRegisteredProjects } from "./project-watcher";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  attempt: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await attempt()) return;
    await delay(30);
  }
  throw new Error("Timed out waiting for project watcher event");
}

interface PublishedEvent {
  event: string;
  data: unknown;
}

function isProjectFileChange(
  published: PublishedEvent[],
  projectId: string,
  path: string,
): boolean {
  return published.some(({ event, data }) => {
    if (event !== "file-change" || !data || typeof data !== "object") return false;
    const change = data as { projectId?: unknown; path?: unknown };
    return change.projectId === projectId && change.path === path;
  });
}

describe("watchRegisteredProjects", () => {
  it("discovers new symlink and directory registrations and closes every watcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-watch-"));
    cleanupPaths.push(root);
    const projectsDir = join(root, "projects");
    await mkdir(projectsDir, { recursive: true });

    const published: PublishedEvent[] = [];
    const manager = watchRegisteredProjects(projectsDir, {
      publish(event, data) {
        published.push({ event, data });
      },
    });

    try {
      const linkedTarget = join(root, "linked-target");
      const linkedIndex = join(linkedTarget, "index.html");
      await mkdir(linkedTarget, { recursive: true });
      await writeFile(linkedIndex, "<!doctype html>");
      await symlink(linkedTarget, join(projectsDir, "linked"), "dir");
      const linkedIndexRealPath = await realpath(linkedIndex);

      await waitFor(async () => {
        await appendFile(linkedIndex, "\n");
        return isProjectFileChange(published, "linked", linkedIndexRealPath);
      });

      const directProject = join(projectsDir, "direct");
      const directData = join(directProject, "project.json");
      await mkdir(directProject, { recursive: true });
      await writeFile(directData, "{}");
      const directDataRealPath = await realpath(directData);

      await waitFor(async () => {
        await appendFile(directData, "\n");
        return isProjectFileChange(published, "direct", directDataRealPath);
      });

      // Non-editing artifacts must not trigger Studio refresh events.
      await delay(75);
      published.length = 0;
      const ignored = join(linkedTarget, "notes.txt");
      await writeFile(ignored, "ignored");
      await delay(125);
      expect(published).toHaveLength(0);

      manager.close();
      await appendFile(linkedIndex, "\nclosed");
      await appendFile(directData, "\nclosed");
      const afterStop = join(projectsDir, "after-stop");
      await mkdir(afterStop, { recursive: true });
      await writeFile(join(afterStop, "index.js"), "globalThis.afterStop = true;");
      await delay(150);
      expect(published).toHaveLength(0);
    } finally {
      // close() is intentionally idempotent so shutdown paths can be retried.
      manager.close();
    }
  }, 20_000);
});
