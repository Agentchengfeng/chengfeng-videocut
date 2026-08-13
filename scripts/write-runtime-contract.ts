import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createStudioCapabilityManifest,
  serializeRuntimeContractJson,
} from "../packages/contracts/src/index";
import { PRODUCT_VERSION } from "../apps/cli/src/output";

const rootDir = resolve(import.meta.dir, "..");
const studioCapabilitiesPath = join(
  rootDir,
  "apps/studio/public/chengfeng-videocut-capabilities.json",
);

await writeFile(
  studioCapabilitiesPath,
  serializeRuntimeContractJson(createStudioCapabilityManifest(PRODUCT_VERSION)),
);

console.log(`Wrote ${studioCapabilitiesPath}`);
