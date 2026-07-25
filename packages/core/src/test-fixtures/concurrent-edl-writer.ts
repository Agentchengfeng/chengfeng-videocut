import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { patchEditList, readEditList, resolveProject } from "../node";

const [projectDirectory, barrierDirectory, contender, expectedRevision, sourceStartText] =
  process.argv.slice(2);

if (
  !projectDirectory ||
  !barrierDirectory ||
  !contender ||
  !expectedRevision ||
  !sourceStartText
) {
  throw new Error("concurrent-edl-writer requires project, barrier, name, revision and sourceStart");
}

const sourceStart = Number(sourceStartText);
if (!Number.isFinite(sourceStart)) throw new Error("sourceStart must be finite");

async function waitForGo(): Promise<void> {
  const goPath = join(barrierDirectory as string, "go");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(goPath);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  throw new Error("Timed out waiting for the cross-process test barrier");
}

const project = await resolveProject(projectDirectory);
const before = await readEditList(project);
if (before?.revision !== expectedRevision) {
  throw new Error(
    `Expected to read ${expectedRevision} before the barrier, received ${before?.revision ?? "none"}`,
  );
}
await writeFile(join(barrierDirectory, `${contender}.ready`), before.revision);
await waitForGo();

try {
  const result = await patchEditList(
    project,
    {
      type: "trim",
      clipId: "a-roll-0001",
      sourceStart,
      sourceEnd: 3,
    },
    { expectedRevision },
  );
  process.stdout.write(`${JSON.stringify({
    contender,
    status: "fulfilled",
    revision: result.revision,
    sourceStart,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    contender,
    status: "rejected",
    code: error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null,
    message: error instanceof Error ? error.message : String(error),
    sourceStart,
  })}\n`);
}
