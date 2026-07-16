import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const jobDirArg = readArg("--job-dir");
if (!jobDirArg) {
  throw new Error("Usage: bun run koubo:link -- --job-dir <dir> [--project-dir <dir>]");
}

const jobDir = realpathSync(resolve(jobDirArg));
const projectJsonPath = join(jobDir, "project.json");
if (!existsSync(projectJsonPath)) {
  throw new Error(`Missing project.json: ${projectJsonPath}`);
}

const job = JSON.parse(readFileSync(projectJsonPath, "utf8")) as { jobId?: string };
const projectId = job.jobId ?? basename(jobDir);
const projectDir = realpathSync(
  resolve(readArg("--project-dir") ?? join(jobDir, "html-modules")),
);
if (!existsSync(join(projectDir, "index.html"))) {
  throw new Error(`HyperFrames project has no index.html: ${projectDir}`);
}

const projectsDir = resolve(
  process.env.VIDEO_WORKBENCH_PROJECTS_DIR ??
    fileURLToPath(new URL("../../../apps/studio/data/projects", import.meta.url)),
);
const linkPath = join(projectsDir, projectId);
if (existsSync(linkPath)) {
  const existing = lstatSync(linkPath).isSymbolicLink()
    ? realpathSync(linkPath)
    : linkPath;
  if (existing !== projectDir) {
    throw new Error(`Project id already linked to another directory: ${linkPath}`);
  }
} else {
  symlinkSync(projectDir, linkPath, "dir");
}

console.log(`Linked koubo job ${projectId}`);
console.log(`Source: ${projectDir}`);
console.log(`Open: http://localhost:5200/#project/${encodeURIComponent(projectId)}`);
