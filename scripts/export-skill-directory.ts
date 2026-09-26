// Explicit build-time metadata export. Never executes or installs any source package.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const { source } = createRequire(import.meta.url)("./skill-directory-snapshot.cjs");
const args = process.argv.slice(2);
if (args.length > 2 || !args[0] || (args[1] && args[1] !== "--check")) throw new Error("Usage: bun scripts/export-skill-directory.ts <local-catalog.json> [--check]");
const text = source(await readFile(args[0]));
const output = new URL("../packages/contracts/src/skill-directory.generated.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== text) throw new Error("Skill directory snapshot drift");
} else await writeFile(output, text);
console.log("Skill directory: local candidate metadata verified; host state unknown");
