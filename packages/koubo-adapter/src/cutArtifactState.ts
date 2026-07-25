import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const KOUBO_SOURCE_CUT_RELATIVE = "剪口播/3_审核/source_cut.mp4";
export const KOUBO_CUT_DONE_RELATIVE = "剪口播/3_审核/cut_done.json";

const REVISION = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;

export type KouboCutArtifactState = "missing" | "legacy" | "stale" | "current";

export interface KouboCutArtifactStatus {
  state: KouboCutArtifactState;
  editListRevision: string | null;
  path: string | null;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function assertInsideProject(projectDirectory: string, path: string): void {
  const value = relative(projectDirectory, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`Cut artifact escapes the project directory: ${path}`);
  }
}

async function existingProjectFile(
  projectDirectory: string,
  projectRelativePath: string,
): Promise<string | null> {
  const candidate = resolve(projectDirectory, projectRelativePath);
  assertInsideProject(projectDirectory, candidate);
  try {
    const resolved = await realpath(candidate);
    assertInsideProject(projectDirectory, resolved);
    const info = await lstat(resolved);
    return info.isFile() && info.size > 0 ? resolved : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readCutDone(projectDirectory: string): Promise<JsonObject | null> {
  const path = await existingProjectFile(projectDirectory, KOUBO_CUT_DONE_RELATIVE);
  if (!path) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isObject(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function readCanonicalSourceSha256(projectDirectory: string): Promise<string | null> {
  const projectPath = await existingProjectFile(projectDirectory, "project.json");
  if (!projectPath) return null;
  try {
    const project = JSON.parse(await readFile(projectPath, "utf8")) as unknown;
    const source = isObject(project) && isObject(project.source) ? project.source : null;
    return source && typeof source.sha256 === "string" && REVISION.test(source.sha256)
      ? source.sha256
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * `cut_done.json` schema v1 has no synthetic `verification.passed` field. These
 * are the facts persisted after the built-in media probe succeeds, so current
 * is granted only when every required fact is present and internally bound to
 * the same EDL revision. Missing facts are not inferred from the MP4 filename.
 */
function verificationPassed(
  document: JsonObject,
  editListRevision: string,
  canonicalSourceSha256: string | null,
): boolean {
  const expectedDuration = document.expectedDuration;
  const actualDuration = document.newDuration;
  const durationDelta = document.durationDeltaSeconds;
  const durationTolerance = document.durationToleranceSeconds;
  return canonicalSourceSha256 !== null &&
    document.schemaVersion === 1 &&
    document.success === true &&
    document.source === "chengfeng-videocut" &&
    document.artifactRevision === editListRevision &&
    document.confirmedEditListRevision === editListRevision &&
    document.sourceSha256 === canonicalSourceSha256 &&
    typeof document.outputSha256 === "string" &&
    REVISION.test(document.outputSha256) &&
    document.outputRelative === KOUBO_SOURCE_CUT_RELATIVE &&
    document.hasAudio === true &&
    positiveFinite(actualDuration) &&
    positiveFinite(expectedDuration) &&
    nonNegativeFinite(durationDelta) &&
    positiveFinite(durationTolerance) &&
    durationDelta <= durationTolerance &&
    Math.abs(actualDuration - expectedDuration) <= durationTolerance + 1e-9 &&
    positiveFinite(document.width) &&
    positiveFinite(document.height);
}

/**
 * Derives the public physical-cut state without writing or probing media.
 *
 * - no canonical media => missing
 * - media without a valid cut_done EDL revision => legacy
 * - a revision mismatch or an unverified schema-v1 pair => stale
 * - matching revision plus persisted verification facts => current
 */
export async function readKouboCutArtifactStatus(
  jobDir: string,
  currentEditListRevision: string | null,
): Promise<KouboCutArtifactStatus> {
  const projectDirectory = await realpath(resolve(jobDir));
  const mediaPath = await existingProjectFile(
    projectDirectory,
    KOUBO_SOURCE_CUT_RELATIVE,
  );
  if (!mediaPath) {
    return { state: "missing", editListRevision: null, path: null };
  }

  const [cutDone, canonicalSourceSha256] = await Promise.all([
    readCutDone(projectDirectory),
    readCanonicalSourceSha256(projectDirectory),
  ]);
  const artifactEditListRevision = typeof cutDone?.editListRevision === "string" &&
      REVISION.test(cutDone.editListRevision)
    ? cutDone.editListRevision
    : null;
  if (!artifactEditListRevision) {
    return {
      state: "legacy",
      editListRevision: null,
      path: KOUBO_SOURCE_CUT_RELATIVE,
    };
  }

  const current = currentEditListRevision !== null && REVISION.test(currentEditListRevision)
    ? currentEditListRevision
    : null;
  const isCurrent = artifactEditListRevision === current &&
    cutDone !== null &&
    verificationPassed(cutDone, artifactEditListRevision, canonicalSourceSha256);
  return {
    state: isCurrent ? "current" : "stale",
    editListRevision: artifactEditListRevision,
    path: KOUBO_SOURCE_CUT_RELATIVE,
  };
}
