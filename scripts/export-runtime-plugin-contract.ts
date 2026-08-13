import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  createRuntimePluginContractSnapshot,
  serializeRuntimeContractJson,
} from "../packages/contracts/src/index";
import { PRODUCT_VERSION } from "../apps/cli/src/output";

const output = process.argv[2];
if (!output) {
  throw new Error("Usage: bun scripts/export-runtime-plugin-contract.ts <output.json>");
}

const outputPath = resolve(output);
const payload = serializeRuntimeContractJson(createRuntimePluginContractSnapshot(PRODUCT_VERSION));
const sha256 = createHash("sha256").update(payload).digest("hex");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, payload);
await writeFile(`${outputPath}.sha256`, `${sha256}  ${basename(outputPath)}\n`);

console.log(JSON.stringify({ output: outputPath, sha256 }));
