import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const required = [
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "CITATION.cff",
  "MODIFICATIONS.md",
  "install.sh",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.md",
  "LICENSES/HyperFrames-Apache-2.0.txt",
  "apps/studio/package.json",
  "packages/contracts/src/index.ts",
];

for (const path of required) {
  if (!existsSync(join(root, path))) {
    throw new Error(`Missing release file: ${path}`);
  }
}

const ignoredDirNames = new Set([
  ".git",
  ".workbench",
  "node_modules",
  "dist",
  "release",
  "logs",
  ".thumbnails",
]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".json", ".md", ".css", ".html"]);
const forbiddenPathPatterns = [
  new RegExp(`/${"Volumes"}/(?!\\.\\.\\.)`),
  new RegExp(`/${"Users"}/(?!\\.\\.\\.)`),
];
const forbiddenSecretPatterns = [
  new RegExp(["s", "k", "-[A-Za-z0-9_-]{20,}"].join("")),
  new RegExp(["p", "h", "c", "_[A-Za-z0-9]{20,}"].join("")),
];
const violations: string[] = [];

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function scan(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirNames.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    const rel = relative(root, absolute);
    if (rel.startsWith("apps/studio/data/projects/")) continue;
    if (entry.isDirectory()) {
      scan(absolute);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(extension(entry.name))) continue;
    const content = readFileSync(absolute, "utf8");
    for (const pattern of forbiddenPathPatterns) {
      if (pattern.test(content)) violations.push(`${rel}: contains a machine-specific path`);
    }
    for (const pattern of forbiddenSecretPatterns) {
      if (pattern.test(content)) violations.push(`${rel}: contains a credential-like token`);
    }
  }
}

scan(root);
if (violations.length > 0) {
  throw new Error(`Release contains machine-specific paths:\n${violations.join("\n")}`);
}

const projectsDir = join(root, "apps/studio/data/projects");
for (const entry of readdirSync(projectsDir)) {
  if (entry === ".gitkeep") continue;
  const path = join(projectsDir, entry);
  if (!statSync(path, { throwIfNoEntry: false })) continue;
  console.warn(`Local project will be excluded from release: ${entry}`);
}

console.log("Release check passed");
