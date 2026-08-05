import electronPath from "electron";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDesktopSmoke } from "./smoke-lib.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
await runDesktopSmoke({
  executable: electronPath,
  args: [appRoot],
});
