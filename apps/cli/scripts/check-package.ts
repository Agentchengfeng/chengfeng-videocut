import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const cliDir = resolve(import.meta.dir, "..");
const distDir = join(cliDir, "dist");
const packageJson = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8"));

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

check(packageJson.name === "chengfeng-videocut", "package name must be chengfeng-videocut");
check(
  packageJson.bin?.["chengfeng-videocut"] === "./dist/cli.js",
  "package bin must point to dist/cli.js",
);
check(Array.isArray(packageJson.files) && packageJson.files.includes("dist"), "dist is not packed");
check(
  Object.keys(packageJson.dependencies ?? {}).length === 0,
  "GitHub package must not require registry dependencies",
);

for (const relativePath of [
  "cli.js",
  "studio/index.html",
  "studio/assets",
  "legal/LICENSE",
  "legal/NOTICE.md",
  "legal/CITATION.cff",
  "legal/MODIFICATIONS.md",
  "legal/THIRD_PARTY_NOTICES.md",
  "legal/THIRD_PARTY_LICENSES.md",
  "legal/HyperFrames-Apache-2.0.txt",
]) {
  await access(join(distDir, relativePath));
}

const cli = await readFile(join(distDir, "cli.js"), "utf8");
check(cli.startsWith("#!/usr/bin/env bun\n"), "dist/cli.js must have a Bun shebang");
check(
  !/from\s+["']@hyperframes\//.test(cli),
  "dist/cli.js still imports a registry dependency",
);
check(
  !cli.includes("require.resolve(\"@hyperframes/") &&
    !cli.includes("require.resolve(\"gsap/"),
  "dist/cli.js still resolves a runtime dependency from node_modules",
);
const index = await readFile(join(distDir, "studio/index.html"), "utf8");
check(index.includes("<title>chengfeng-VideoCut</title>"), "Studio package title is not branded");

const files = await walk(distDir);
check(
  !files.some((path) => path.endsWith(".map") || path.endsWith(".tsbuildinfo")),
  "dist contains development artifacts",
);
for (const path of files.filter((value) => /\.(?:html|js|json|md|txt)$/.test(value))) {
  const content = await readFile(path, "utf8");
  const volumesPrefix = `/${"Volumes"}/`;
  const usersPrefix = `/${"Users"}/`;
  check(
    !content.includes(volumesPrefix) && !content.includes(usersPrefix),
    `dist contains an absolute machine path in ${path}`,
  );
}

console.log(`Package check passed (${files.length} files)`);
