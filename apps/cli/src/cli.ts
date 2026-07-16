#!/usr/bin/env bun

import { runCli } from "./run";

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
