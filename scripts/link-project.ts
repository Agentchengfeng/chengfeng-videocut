import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceArg = readArg("--source");
if (!sourceArg) {
  throw new Error("Usage: bun run project:link -- --source <dir> [--id <project-id>]");
}

const source = realpathSync(resolve(sourceArg));
const id = readArg("--id") ?? basename(source);
if (!existsSync(join(source, "index.html")) && !existsSync(join(source, `${id}.html`))) {
  throw new Error(`Project must contain index.html or ${id}.html: ${source}`);
}

const projectsDir = resolve(
  process.env.VIDEO_WORKBENCH_PROJECTS_DIR ??
    fileURLToPath(new URL("../apps/studio/data/projects", import.meta.url)),
);
mkdirSync(projectsDir, { recursive: true });
const linkPath = join(projectsDir, id);

if (existsSync(linkPath)) {
  const existing = lstatSync(linkPath).isSymbolicLink()
    ? realpathSync(linkPath)
    : linkPath;
  if (existing !== source) {
    throw new Error(`Project id already exists: ${linkPath}`);
  }
} else {
  symlinkSync(source, linkPath, "dir");
}

console.log(`Linked project ${id}`);
console.log(`Source: ${source}`);
console.log(`Open: http://localhost:5200/?view=koubo#project/${encodeURIComponent(id)}`);
