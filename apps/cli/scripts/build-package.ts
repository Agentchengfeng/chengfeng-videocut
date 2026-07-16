import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const cliDir = resolve(import.meta.dir, "..");
const rootDir = resolve(cliDir, "../..");
const studioDist = resolve(cliDir, "../studio/dist");
const distDir = join(cliDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(cliDir, "src/cli.ts")],
  outdir: distDir,
  naming: "cli.js",
  target: "bun",
  format: "esm",
  minify: false,
  sourcemap: "none",
  plugins: [
    {
      name: "portable-esbuild-shim",
      setup(build) {
        build.onResolve({ filter: /^esbuild$/ }, () => ({
          path: join(cliDir, "src/esbuild-shim.ts"),
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const cliPath = join(distDir, "cli.js");
const bundled = (await readFile(cliPath, "utf8")).replace(/^#![^\n]*\n?/, "");
await writeFile(cliPath, `#!/usr/bin/env bun\n${bundled}`);
await chmod(cliPath, 0o755);

const studioTarget = join(distDir, "studio");
await mkdir(studioTarget, { recursive: true });
for (const entry of ["assets", "icons", "favicon.svg", "index.html"]) {
  await cp(join(studioDist, entry), join(studioTarget, entry), {
    recursive: true,
    force: true,
  });
}
const studioIndexPath = join(studioTarget, "index.html");
const studioIndex = await readFile(studioIndexPath, "utf8");
await writeFile(
  studioIndexPath,
  studioIndex.replace(/<title>[^<]*<\/title>/i, "<title>chengfeng-VideoCut</title>"),
);

const legalDir = join(distDir, "legal");
await mkdir(legalDir, { recursive: true });
await cp(join(rootDir, "LICENSE"), join(legalDir, "LICENSE"));
await cp(join(rootDir, "NOTICE.md"), join(legalDir, "NOTICE.md"));
await cp(join(rootDir, "CITATION.cff"), join(legalDir, "CITATION.cff"));
await cp(join(rootDir, "MODIFICATIONS.md"), join(legalDir, "MODIFICATIONS.md"));
await cp(join(rootDir, "THIRD_PARTY_NOTICES.md"), join(legalDir, "THIRD_PARTY_NOTICES.md"));
await cp(join(rootDir, "THIRD_PARTY_LICENSES.md"), join(legalDir, "THIRD_PARTY_LICENSES.md"));
await cp(
  join(rootDir, "LICENSES/HyperFrames-Apache-2.0.txt"),
  join(legalDir, "HyperFrames-Apache-2.0.txt"),
);

console.log(`Built ${cliPath}`);
