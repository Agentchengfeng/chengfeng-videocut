import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PRODUCT_VERSION } from "../src/output";

const defaultCliDir = resolve(import.meta.dir, "..");

export interface StudioBundleAsset {
  path: string;
  content: string;
}

const STUDIO_EXTENSION_VIEW_MARKER = "data-studio-extension-view";
const MANAGED_TIMELINE_EDITING_MARKER = "useTimelineEditingAdapter";
const LEGACY_STUDIO_MARKERS = ["cf-task-panel", "剪辑工作区"] as const;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function checkStudioBundleContract(assets: readonly StudioBundleAsset[]): void {
  const javascriptAssets = assets.filter(({ path }) => path.endsWith(".js"));
  check(javascriptAssets.length > 0, "Studio package has no JavaScript bundle assets");

  check(
    javascriptAssets.some(({ content }) => content.includes(STUDIO_EXTENSION_VIEW_MARKER)),
    `Studio bundle is missing the HyperFrames extension view marker ${STUDIO_EXTENSION_VIEW_MARKER}`,
  );
  check(
    javascriptAssets.some(({ content }) => content.includes(MANAGED_TIMELINE_EDITING_MARKER)),
    `Studio bundle is missing the managed timeline adapter marker ${MANAGED_TIMELINE_EDITING_MARKER}`,
  );

  for (const marker of LEGACY_STUDIO_MARKERS) {
    const legacyAsset = assets.find(({ content }) => content.includes(marker));
    check(
      !legacyAsset,
      `Studio bundle still contains legacy workbench marker ${marker} in ${legacyAsset?.path}`,
    );
  }
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

export async function checkPackage(cliDir = defaultCliDir): Promise<number> {
  const distDir = join(cliDir, "dist");
  const packageJson = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8"));

  check(packageJson.name === "chengfeng-videocut", "package name must be chengfeng-videocut");
  check(
    packageJson.version === PRODUCT_VERSION,
    `package version ${String(packageJson.version)} does not match ${PRODUCT_VERSION}`,
  );
  check(
    packageJson.bin?.["chengfeng-videocut"] === "./dist/cli.js",
    "package bin must point to dist/cli.js",
  );
  check(
    Array.isArray(packageJson.files) && packageJson.files.includes("dist"),
    "dist is not packed",
  );
  check(
    Object.keys(packageJson.dependencies ?? {}).length === 0,
    "GitHub package must not require registry dependencies",
  );

  for (const relativePath of [
    "cli.js",
    "studio/index.html",
    "studio/studio-boot-guard.js",
    "studio/chengfeng-videocut-capabilities.json",
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
  check(index.includes("<title>chengfeng-videocut</title>"), "Studio package title is not branded");
  check(
    index.includes("id=\"studio-boot-guard\"") &&
      index.includes("src=\"/studio-boot-guard.js\""),
    "Studio package is missing the visible boot recovery shell",
  );
  const bootGuard = await readFile(join(distDir, "studio/studio-boot-guard.js"), "utf8");
  check(
    bootGuard.includes("vite:preloadError") && bootGuard.includes("mount-timeout"),
    "Studio package boot guard is missing recovery behavior",
  );
  const capabilities = JSON.parse(
    await readFile(join(distDir, "studio/chengfeng-videocut-capabilities.json"), "utf8"),
  );
  check(capabilities.schemaVersion === 1, "Studio capability schemaVersion must be 1");
  check(capabilities.product === "chengfeng-videocut", "Studio capability product is invalid");
  check(
    capabilities.studioVersion === PRODUCT_VERSION,
    `Studio capability version must be ${PRODUCT_VERSION}`,
  );
  check(
    ["storyboard", "preview", "koubo"].every((view) =>
      capabilities.features?.topLevelViews?.includes(view)),
    "Studio capability is missing a required top-level view",
  );
  check(
    capabilities.features?.legacyWorkbenchPanel === false,
    "Studio capability must explicitly disable the legacy workbench panel",
  );
  check(
    capabilities.features?.managedTimelineEditing === true,
    "Studio capability must explicitly enable managed timeline editing",
  );
  check(
    ["move", "trim", "split", "delete", "restore", "delete-range", "restore-snapshot"].every((operation) =>
      capabilities.features?.managedTimelineOperations?.includes(operation)),
    "Studio capability is missing a managed timeline operation",
  );

  const files = await walk(distDir);
  check(
    !files.some((path) => path.endsWith(".map") || path.endsWith(".tsbuildinfo")),
    "dist contains development artifacts",
  );

  const studioAssetsDir = join(distDir, "studio", "assets");
  const studioBundlePaths = files.filter(
    (path) => path.startsWith(studioAssetsDir) && /\.(?:css|js)$/.test(path),
  );
  checkStudioBundleContract(
    await Promise.all(
      studioBundlePaths.map(async (path) => ({ path, content: await readFile(path, "utf8") })),
    ),
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
  return files.length;
}

if (import.meta.main) {
  await checkPackage();
}
