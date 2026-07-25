import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import { serializeProjectOperation } from "@video-workbench/core/node";

const MANAGED_A_ROLL_START = "<!-- chengfeng-videocut:a-roll:start -->";
const MANAGED_A_ROLL_END = "<!-- chengfeng-videocut:a-roll:end -->";
const MANAGED_DOCUMENTS = new Set(["cut-selection.json", "edit-list.json"]);

interface GenericStudioMutationRoute {
  projectId: string;
  kind: "file" | "file-mutation" | "file-mutation-batch" | "gsap-mutation";
  operation: string;
  targetFile: string | null;
}

interface ManagedARollOwnership {
  sentinelCount: string;
  managedRegion: string;
  managedElementTags: string;
  rootContract: string;
  managedScriptReferences: string;
  ids: string[];
  hfIds: string[];
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content: Buffer | null;
}

export interface GuardedStudioApiOptions {
  adapter: StudioApiAdapter;
  fetch(request: Request): Response | Promise<Response>;
}

function jsonError(reason: string, details: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      error: "managed_a_roll_write_forbidden",
      message:
        "A-roll 由 edit-list.json 管理，请使用 /api/v1/projects/:id/edit-list 修改剪辑结果。标题、B-roll 和其他非 A-roll 元素仍可在 Studio 中编辑。",
      details: { reason, ...details },
    },
    {
      status: 409,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function routeFilePath(segments: string[], from: number): string | null {
  const decoded: string[] = [];
  for (const segment of segments.slice(from)) {
    const value = decodePathSegment(segment);
    if (value === null || value.includes("\0")) return null;
    decoded.push(value);
  }
  return decoded.join("/");
}

/**
 * Returns only generic HyperFrames routes that can mutate project source.
 * Preview, render, selection, upload, and media routes are intentionally not
 * serialized because they do not rewrite index.html in Studio Server 0.7.60.
 */
export function genericStudioMutationRoute(request: Request): GenericStudioMutationRoute | null {
  const method = request.method.toUpperCase();
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  if (segments[0] !== "projects" || segments.length < 3) return null;
  const projectId = decodePathSegment(segments[1] ?? "");
  if (!projectId || projectId.includes("/") || projectId.includes("\\") || projectId.includes("\0")) {
    return null;
  }

  if (segments[2] === "files" && ["PUT", "POST", "PATCH", "DELETE"].includes(method)) {
    return {
      projectId,
      kind: "file",
      operation: method,
      targetFile: routeFilePath(segments, 3),
    };
  }
  if (segments[2] === "file-mutations" && method === "POST") {
    const operation = segments[3] ?? "";
    if (operation === "probe-element") return null;
    if (operation === "patch-element-batches") {
      return { projectId, kind: "file-mutation-batch", operation, targetFile: null };
    }
    return {
      projectId,
      kind: "file-mutation",
      operation,
      targetFile: routeFilePath(segments, 4),
    };
  }
  if (
    method === "POST" &&
    ["gsap-mutations", "gsap-mutations-batch", "gsap-mutation-rollback"].includes(
      segments[2] ?? "",
    )
  ) {
    return {
      projectId,
      kind: "gsap-mutation",
      operation: segments[2] ?? "",
      targetFile: routeFilePath(segments, 3),
    };
  }
  return null;
}

function normalizeProjectFilePath(value: string | null): string | null {
  if (value === null || value.includes("\0")) return null;
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function isIndexFile(value: string | null): boolean {
  return normalizeProjectFilePath(value)?.toLowerCase() === "index.html";
}

function managedDocument(value: string | null): string | null {
  const normalized = normalizeProjectFilePath(value)?.toLowerCase() ?? null;
  return normalized && MANAGED_DOCUMENTS.has(normalized) ? normalized : null;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function attributesFromTag(tag: string): Map<string, string> {
  const start = tag.indexOf(" ");
  const source = start >= 0 ? tag.slice(start, tag.lastIndexOf(">")) : "";
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!name) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function canonicalTag(tag: string, inner = ""): string {
  const openingTag = tag.match(/^<[^>]+>/)?.[0] ?? tag;
  const name = openingTag.match(/^<\s*([^\s/>]+)/)?.[1]?.toLowerCase() ?? "unknown";
  const attributes = [...attributesFromTag(openingTag).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const normalizedInner = inner.replace(/\s+/g, " ").trim();
  return `${name}[${attributes}]${normalizedInner ? `{${normalizedInner}}` : ""}`;
}

function canonicalManagedRegion(region: string): string {
  const body = region
    .replace(MANAGED_A_ROLL_START, "")
    .replace(MANAGED_A_ROLL_END, "");
  const elements: string[] = [];
  const elementPattern = /<video\b[^>]*(?:\/>|>([\s\S]*?)<\/video\s*>)/gi;
  let residual = body;
  for (const match of body.matchAll(elementPattern)) {
    elements.push(canonicalTag(match[0] ?? "", match[1] ?? ""));
  }
  residual = residual.replace(elementPattern, "").replace(/\s+/g, "").trim();
  return JSON.stringify({ elements, residual });
}

function attributeValue(tag: string, name: string): string {
  return attributesFromTag(tag).get(name) ?? "";
}

function managedReferenceScripts(content: string, ids: string[], hfIds: string[]): string {
  const references = [
    "data-edl-segment-id",
    ".a-roll-segment",
    ...ids,
    ...hfIds,
  ];
  const scripts: string[] = [];
  for (const match of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const source = match[1] ?? "";
    if (references.some((reference) => reference && source.includes(reference))) {
      scripts.push(source.replace(/\s+/g, " ").trim());
    }
  }
  return JSON.stringify(scripts);
}

/** Semantic fingerprint of the Product-owned A-roll projection. */
export function managedARollOwnership(content: string): ManagedARollOwnership | null {
  const startCount = countOccurrences(content, MANAGED_A_ROLL_START);
  const endCount = countOccurrences(content, MANAGED_A_ROLL_END);
  const start = content.indexOf(MANAGED_A_ROLL_START);
  const end = content.indexOf(MANAGED_A_ROLL_END, Math.max(0, start));
  const taggedElements = [...content.matchAll(/<[^>]*\bdata-edl-segment-id\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi)];
  if (start < 0 && taggedElements.length === 0) return null;

  const region = start >= 0 && end > start
    ? content.slice(start, end + MANAGED_A_ROLL_END.length)
    : "";
  const ids = taggedElements
    .map((match) => attributeValue(match[0] ?? "", "data-edl-segment-id"))
    .filter(Boolean);
  const hfIds = taggedElements
    .map((match) => attributeValue(match[0] ?? "", "data-hf-id"))
    .filter(Boolean);
  const root = content.match(/<main\b(?=[^>]*\bdata-composition-id\s*=\s*(?:"main"|'main'))[^>]*>/i)?.[0] ?? "";
  const rootAttributes = [
    "data-composition-id",
    "data-duration",
    "data-edl-mode",
    "data-edit-list-revision",
    "data-videocut-projection-schema",
    "data-videocut-projection-runtime",
  ]
    .map((name) => `${name}=${JSON.stringify(attributeValue(root, name))}`)
    .join(" ");

  return {
    sentinelCount: `${startCount}:${endCount}:${start >= 0 && end > start ? "ordered" : "invalid"}`,
    managedRegion: region ? canonicalManagedRegion(region) : "missing",
    managedElementTags: JSON.stringify(taggedElements.map((match) => canonicalTag(match[0] ?? ""))),
    rootContract: rootAttributes,
    managedScriptReferences: managedReferenceScripts(content, ids, hfIds),
    ids,
    hfIds,
  };
}

function sameManagedOwnership(
  before: ManagedARollOwnership | null,
  after: ManagedARollOwnership | null,
): boolean {
  if (before === null || after === null) return before === after;
  return before.sentinelCount === after.sentinelCount &&
    before.managedRegion === after.managedRegion &&
    before.managedElementTags === after.managedElementTags &&
    before.rootContract === after.rootContract &&
    before.managedScriptReferences === after.managedScriptReferences;
}

function selectorCanMatchManagedARoll(selector: string, ownership: ManagedARollOwnership): boolean {
  const normalized = selector.trim();
  if (!normalized) return false;
  if (
    normalized.includes("data-edl-segment-id") ||
    normalized.includes(".a-roll-segment") ||
    /data-timeline-role[^\]]*a-roll/i.test(normalized) ||
    /(^|[\s>+~,(])video(?=$|[.#[:\s>+~,)])/i.test(normalized) ||
    /(^|[\s>+~,(])\*(?=$|[.#[:\s>+~,)])/i.test(normalized)
  ) return true;
  return [...ownership.ids, ...ownership.hfIds].some((id) => normalized.includes(id));
}

function mutationBodyTargetsManagedARoll(value: unknown, ownership: ManagedARollOwnership): boolean {
  const visit = (entry: unknown, key = ""): boolean => {
    if (typeof entry === "string") {
      if (["id", "hfid", "selector", "targetselector", "originalid"].includes(key.toLowerCase())) {
        return ownership.ids.includes(entry) ||
          ownership.hfIds.includes(entry) ||
          selectorCanMatchManagedARoll(entry, ownership);
      }
      return false;
    }
    if (Array.isArray(entry)) return entry.some((item) => visit(item, key));
    if (!entry || typeof entry !== "object") return false;
    return Object.entries(entry).some(([childKey, child]) => visit(child, childKey));
  };
  return visit(value);
}

function projectPath(projectDir: string, filePath: string): string | null {
  const normalized = normalizeProjectFilePath(filePath);
  if (normalized === null) return null;
  const absolute = resolve(projectDir, normalized);
  const relation = relative(resolve(projectDir), absolute);
  if (relation === "" || relation.startsWith("..") || relation.startsWith("/")) return null;
  return absolute;
}

async function snapshotsForPaths(projectDir: string, paths: string[]): Promise<FileSnapshot[]> {
  const unique = new Set(paths.map(normalizeProjectFilePath).filter((path): path is string => path !== null));
  const snapshots: FileSnapshot[] = [];
  for (const path of unique) {
    const absolute = projectPath(projectDir, path);
    if (absolute === null) continue;
    const existed = existsSync(absolute);
    snapshots.push({
      path: absolute,
      existed,
      content: existed ? await readFile(absolute) : null,
    });
  }
  return snapshots;
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  const errors: unknown[] = [];
  for (const snapshot of snapshots) {
    try {
      if (snapshot.existed) {
        await mkdir(dirname(snapshot.path), { recursive: true });
        await writeFile(snapshot.path, snapshot.content ?? Buffer.alloc(0));
      } else {
        await rm(snapshot.path, { recursive: true, force: true });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Studio mutation violated managed A-roll ownership and rollback failed");
  }
}

function batchSourceFiles(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("batches" in body)) return [];
  const batches = (body as { batches?: unknown }).batches;
  if (!Array.isArray(batches)) return [];
  return batches.flatMap((batch) => {
    if (!batch || typeof batch !== "object" || !("sourceFile" in batch)) return [];
    return typeof batch.sourceFile === "string" ? [batch.sourceFile] : [];
  });
}

async function requestBody(request: Request): Promise<{ text: string; json: unknown }> {
  const text = await request.clone().text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text || "null") as unknown;
  } catch {
    // The upstream Studio API owns malformed-body error semantics.
  }
  return { text, json };
}

/**
 * Product boundary around HyperFrames' generic source writers.
 *
 * The upstream API remains responsible for normal file CAS and mutation
 * semantics. This wrapper adds the shared cross-process project lock and a
 * server-side ownership invariant for the EDL projection without patching the
 * upstream package.
 */
export async function fetchGuardedStudioApi(
  request: Request,
  options: GuardedStudioApiOptions,
): Promise<Response> {
  const route = genericStudioMutationRoute(request);
  if (route === null) return await options.fetch(request);
  const project = await options.adapter.resolveProject(route.projectId);
  if (!project) return await options.fetch(request);

  return await serializeProjectOperation(project.dir, async () => {
    const normalizedTarget = normalizeProjectFilePath(route.targetFile);
    if (
      route.kind === "file" &&
      normalizedTarget === "." &&
      ["DELETE", "PATCH"].includes(route.operation)
    ) {
      return jsonError("managed_project_root_cannot_be_deleted_or_renamed", { path: "." });
    }
    const protectedDocument = managedDocument(normalizedTarget);
    if (protectedDocument) {
      return jsonError("managed_document", {
        path: protectedDocument,
        api: protectedDocument === "edit-list.json"
          ? `/api/v1/projects/${encodeURIComponent(route.projectId)}/edit-list`
          : `/api/v1/projects/${encodeURIComponent(route.projectId)}/cuts`,
      });
    }

    const indexPath = resolve(project.dir, "index.html");
    const beforeIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : null;
    const beforeOwnership = beforeIndex === null ? null : managedARollOwnership(beforeIndex);
    const hasEditList = existsSync(resolve(project.dir, "edit-list.json"));
    const body = await requestBody(request);

    let affectedFiles: string[] = normalizedTarget ? [normalizedTarget] : [];
    if (route.kind === "file-mutation-batch") affectedFiles = batchSourceFiles(body.json);

    if (route.kind === "file" && route.operation === "PATCH") {
      const nextPath = body.json && typeof body.json === "object" && "newPath" in body.json
        ? (body.json as { newPath?: unknown }).newPath
        : null;
      const normalizedNext = typeof nextPath === "string" ? normalizeProjectFilePath(nextPath) : null;
      if (normalizedNext) affectedFiles.push(normalizedNext);
      const protectedNextDocument = managedDocument(normalizedNext);
      if (protectedNextDocument) {
        return jsonError("managed_document", { path: protectedNextDocument });
      }
      if (isIndexFile(normalizedTarget) || isIndexFile(normalizedNext)) {
        return jsonError("managed_projection_cannot_be_renamed", { path: normalizedTarget });
      }
      if (
        beforeOwnership &&
        normalizedTarget &&
        beforeOwnership.managedRegion.includes(normalizedTarget)
      ) {
        return jsonError("managed_a_roll_source_cannot_be_renamed", { path: normalizedTarget });
      }
    }

    const renameRewritesIndex = route.kind === "file" &&
      route.operation === "PATCH" &&
      normalizedTarget !== null &&
      beforeIndex?.includes(normalizedTarget) === true;
    const affectsIndex = affectedFiles.some(isIndexFile) || renameRewritesIndex;
    if (renameRewritesIndex) affectedFiles.push("index.html");
    if (hasEditList && beforeOwnership === null && affectsIndex) {
      return jsonError("managed_projection_is_not_materialized", { path: "index.html" });
    }
    if (
      beforeOwnership &&
      route.kind === "file" &&
      affectsIndex &&
      ["POST", "DELETE", "PATCH"].includes(route.operation)
    ) {
      return jsonError("managed_projection_cannot_be_created_deleted_or_renamed", {
        path: "index.html",
      });
    }
    if (beforeOwnership && route.kind === "file" && route.operation === "PUT" && affectsIndex) {
      const proposedOwnership = managedARollOwnership(body.text);
      if (!sameManagedOwnership(beforeOwnership, proposedOwnership)) {
        return jsonError("managed_projection_changed", { path: "index.html" });
      }
    }
    if (
      beforeOwnership &&
      affectsIndex &&
      mutationBodyTargetsManagedARoll(body.json, beforeOwnership)
    ) {
      return jsonError("managed_element_targeted", { path: "index.html" });
    }

    const rollbackPaths = beforeOwnership
      ? [...new Set([...(affectsIndex ? affectedFiles : []), "index.html"])]
      : [];
    const snapshots = await snapshotsForPaths(project.dir, rollbackPaths);
    let response: Response;
    try {
      response = await options.fetch(request);
    } catch (error) {
      if (beforeOwnership) {
        const afterIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : null;
        const afterOwnership = afterIndex === null ? null : managedARollOwnership(afterIndex);
        if (!sameManagedOwnership(beforeOwnership, afterOwnership)) {
          await restoreSnapshots(snapshots);
        }
      }
      throw error;
    }
    if (beforeOwnership === null) return response;

    const afterIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : null;
    const afterOwnership = afterIndex === null ? null : managedARollOwnership(afterIndex);
    if (sameManagedOwnership(beforeOwnership, afterOwnership)) return response;

    await restoreSnapshots(snapshots);
    return jsonError("managed_projection_changed", { path: "index.html" });
  });
}
