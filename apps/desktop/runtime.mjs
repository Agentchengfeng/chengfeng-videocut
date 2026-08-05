import { delimiter, join, resolve } from "node:path";

export const DESKTOP_PRODUCT = "chengfeng-videocut";
export const DEFAULT_DESKTOP_HOST = "127.0.0.1";
export const DEFAULT_DESKTOP_PORT = 5190;

export function parseDesktopPort(value) {
  if (value === undefined || value === "") return DEFAULT_DESKTOP_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid desktop Runtime port: ${value}`);
  }
  return port;
}

export function resolveDesktopLayout(options) {
  const resourcesRoot = options.isPackaged
    ? resolve(options.resourcesPath)
    : resolve(options.appRoot, "dist-resources");
  const runtimeDir = join(resourcesRoot, "runtime");
  const toolsDir = join(resourcesRoot, "tools");
  const executableSuffix = options.platform === "win32" ? ".exe" : "";
  return {
    resourcesRoot,
    runtimeDir,
    toolsDir,
    cliPath: join(runtimeDir, "cli.js"),
    bunPath: options.bunOverride
      ? resolve(options.bunOverride)
      : join(runtimeDir, "bin", `bun${executableSuffix}`),
    ffmpegPath: join(toolsDir, `ffmpeg${executableSuffix}`),
    ffprobePath: join(toolsDir, `ffprobe${executableSuffix}`),
    manifestPath: join(resourcesRoot, "resources-manifest.json"),
  };
}

export function prependToolsPath(currentPath, toolsDir) {
  return currentPath ? `${toolsDir}${delimiter}${currentPath}` : toolsDir;
}

export function classifyRuntimeHealth(health, expectedVersion) {
  if (health === null) return { action: "spawn" };
  if (
    typeof health !== "object" ||
    health.ok !== true ||
    health.product !== DESKTOP_PRODUCT ||
    typeof health.productVersion !== "string"
  ) {
    throw new Error(
      "Port is already in use, but it does not belong to a compatible chengfeng-videocut Runtime.",
    );
  }
  if (health.productVersion !== expectedVersion) {
    throw new Error(
      `Runtime version conflict: desktop ${expectedVersion}, running Runtime ${health.productVersion}.`,
    );
  }
  if (Array.isArray(health.mediaToolsMissing) && health.mediaToolsMissing.length > 0) {
    throw new Error(
      `The running Runtime cannot see required media tools: ${health.mediaToolsMissing.join(", ")}.`,
    );
  }
  return {
    action: "reuse",
    pid: Number.isInteger(health.pid) ? health.pid : undefined,
    runtimeMode: typeof health.runtimeMode === "string" ? health.runtimeMode : undefined,
  };
}

export function parseDesktopProjectId(argv, configuredValue) {
  let value = configuredValue?.trim() || undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--project=")) {
      value = token.slice("--project=".length);
      continue;
    }
    if (token === "--project") {
      value = argv[index + 1];
      index += 1;
    }
  }
  if (value === undefined) return undefined;
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid desktop project id: ${value}`);
  }
  return value;
}

export function studioUrl(baseUrl, projectId) {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.searchParams.set("view", "koubo");
  return `${url.toString()}${
    projectId === undefined ? "" : `#project/${encodeURIComponent(projectId)}`
  }`;
}
