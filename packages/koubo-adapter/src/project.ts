import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildEditListFromCuts,
  parseEditListDocument,
  type EditListDocument,
  VideocutError,
} from "@video-workbench/core";
import {
  buildNaturalPausePlan,
  DEFAULT_NATURAL_PAUSE_POLICY,
  type NaturalPausePlan,
} from "./naturalPause";
import {
  EDL_PREVIEW_PAYLOAD_ATTRIBUTE,
  EDL_PREVIEW_RUNTIME_CONTRACT,
  renderEdlPreviewPayload,
  renderEdlPreviewRuntime,
} from "./edlPreviewRuntime";
import {
  ensurePreviewProxy,
  type PreviewProxyDependencies,
  type PreviewProxyResult,
} from "./previewProxy";
import { serializeKouboProjectOperation } from "./projectLock";

type JsonObject = Record<string, unknown>;

export interface KouboTranscriptWord {
  id: string;
  text: string;
  start: number;
  end: number;
  isGap: boolean;
  suggestion?: "silence" | "filler" | "repeat" | "stutter" | "incomplete";
}

export interface KouboTranscriptCue {
  id: string;
  start: number;
  end: number;
  words: KouboTranscriptWord[];
}

export interface KouboTranscript {
  schemaVersion: 1;
  cues: KouboTranscriptCue[];
}

export interface PrepareKouboProjectOptions {
  video?: string;
  transcript?: string;
  duration?: number;
  forceIndex?: boolean;
  refreshTranscript?: boolean;
  now?: () => Date;
  /** Test/embedding seam for deterministic preview-proxy preparation. */
  previewProxyDependencies?: PreviewProxyDependencies;
  /** Test/embedding seam used to prove rollback between staged file commits. */
  beforeCommitFile?: (path: string, index: number) => void | Promise<void>;
}

export interface PreparedKouboProject {
  projectId: string;
  directory: string;
  metadata: JsonObject;
  transcript: KouboTranscript;
  cutWordIds: string[];
  indexWritten: boolean;
}

export interface CreateKouboProjectOptions {
  video: string;
  transcript: string;
  aspectRatio: "3:4" | "4:3" | "16:9";
  now?: () => Date;
  /** CLI registration runs here so a registration failure rolls project creation back. */
  finalize?: (prepared: PreparedKouboProject) => void | Promise<void>;
  /** Test seam used to prove rollback after the initial canonical files exist. */
  beforePrepareCommitFile?: PrepareKouboProjectOptions["beforeCommitFile"];
}

export interface CreatedKouboProject extends PreparedKouboProject {
  canonicalVideo: string;
  canonicalTranscript: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteText(
  path: string,
  value: string,
  options: { shouldCommit?: () => boolean | Promise<boolean> } = {},
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, value, "utf8");
    if (options.shouldCommit && !await options.shouldCommit()) return false;
    await rename(temporary, path);
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

interface ProjectFileWrite {
  path: string;
  content: string;
}

interface StagedProjectFileWrite extends ProjectFileWrite {
  temporary: string;
  backup: string;
  backupCreated: boolean;
  installed: boolean;
  installedIdentity: PathIdentity;
}

interface PathIdentity {
  dev: number;
  ino: number;
}

interface ProjectCreationJournal {
  jobDir: string;
  files: Map<string, PathIdentity>;
  directories: Map<string, PathIdentity>;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

async function directoryEntryIdentity(path: string): Promise<PathIdentity | null> {
  try {
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(
  left: PathIdentity | null | undefined,
  right: PathIdentity | null | undefined,
): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function recordCreatedFile(
  journal: ProjectCreationJournal | undefined,
  path: string,
  identity: PathIdentity,
): void {
  journal?.files.set(path, identity);
}

async function ensureSafeProjectDirectory(
  jobDir: string,
  directory: string,
  journal?: ProjectCreationJournal,
): Promise<void> {
  projectRelativePath(jobDir, directory);
  const relativeDirectory = relative(jobDir, directory);
  let current = jobDir;
  for (const part of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current);
      const identity = await directoryEntryIdentity(current);
      if (!identity) throw new Error(`Created directory disappeared: ${current}`);
      journal?.directories.set(current, identity);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const info = await lstat(current);
      if (!info.isDirectory()) {
        throw new VideocutError(
          "project_id_conflict",
          `Product cache requires a directory but found another entry: ${current}`,
          { path: current },
        );
      }
    }
  }
}

async function ensureProjectCreationDirectory(
  journal: ProjectCreationJournal,
  directory: string,
): Promise<void> {
  await ensureSafeProjectDirectory(journal.jobDir, directory, journal);
}

async function ensureProjectFileParent(
  path: string,
  journal?: ProjectCreationJournal,
): Promise<void> {
  if (journal) await ensureProjectCreationDirectory(journal, dirname(path));
  else await mkdir(dirname(path), { recursive: true });
}

/**
 * Stages every candidate before touching a target, then rolls all installed
 * files back if a commit throws. New targets publish with create-only hard
 * links; live-file replacements use one atomic rename. Crash-recovery across
 * the whole set requires a future durable journal.
 */
async function commitProjectFiles(
  writes: readonly ProjectFileWrite[],
  beforeCommitFile?: PrepareKouboProjectOptions["beforeCommitFile"],
  creationJournal?: ProjectCreationJournal,
): Promise<void> {
  const deduplicated = new Map<string, string>();
  for (const write of writes) deduplicated.set(write.path, write.content);
  const staged: StagedProjectFileWrite[] = [];
  try {
    for (const [path, content] of deduplicated) {
      const currentIdentity = await directoryEntryIdentity(path);
      const ownedIdentity = creationJournal?.files.get(path) ?? null;
      if (creationJournal && currentIdentity && !sameIdentity(currentIdentity, ownedIdentity)) {
        throw new VideocutError(
          "project_id_conflict",
          `project create refuses to overwrite an entry created after preflight: ${path}`,
          { path },
        );
      }
      if (creationJournal && !currentIdentity && ownedIdentity) {
        throw new VideocutError(
          "project_id_conflict",
          `A project entry changed during creation: ${path}`,
          { path },
        );
      }
      const current = currentIdentity ? await readFile(path, "utf8") : null;
      if (current === content) continue;
      await ensureProjectFileParent(path, creationJournal);
      const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
      const temporary = `${path}.tmp-${nonce}`;
      const backup = `${path}.bak-${nonce}`;
      try {
        await writeFile(temporary, content, "utf8");
        const installedIdentity = await directoryEntryIdentity(temporary);
        if (!installedIdentity) throw new Error(`Staged project file disappeared: ${temporary}`);
        staged.push({
          path,
          content,
          temporary,
          backup,
          backupCreated: false,
          installed: false,
          installedIdentity,
        });
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    await Promise.all(staged.map((write) =>
      rm(write.temporary, { force: true }).catch(() => undefined)));
    throw error;
  }

  let preserveBackups = false;
  try {
    for (const [index, write] of staged.entries()) {
      await beforeCommitFile?.(write.path, index);
      const currentIdentity = await directoryEntryIdentity(write.path);
      const ownedIdentity = creationJournal?.files.get(write.path) ?? null;
      if (creationJournal && currentIdentity && !sameIdentity(currentIdentity, ownedIdentity)) {
        throw new VideocutError(
          "project_id_conflict",
          `project create refuses to overwrite an entry created after preflight: ${write.path}`,
          { path: write.path },
        );
      }
      if (creationJournal && !currentIdentity && ownedIdentity) {
        throw new VideocutError(
          "project_id_conflict",
          `A project entry changed during creation: ${write.path}`,
          { path: write.path },
        );
      }
      if (currentIdentity) {
        await copyFile(write.path, write.backup);
        write.backupCreated = true;
        await rename(write.temporary, write.path);
      } else {
        // Publishing by hard link is create-only: a foreign target that lands
        // after preflight wins, and this transaction fails without overwriting it.
        await link(write.temporary, write.path);
      }
      write.installed = true;
      recordCreatedFile(creationJournal, write.path, write.installedIdentity);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const write of [...staged].reverse()) {
      try {
        if (write.installed) {
          const currentIdentity = await directoryEntryIdentity(write.path);
          if (sameIdentity(currentIdentity, write.installedIdentity)) {
            await rm(write.path, { force: true });
          }
        }
        if (write.backupCreated) {
          const currentIdentity = await directoryEntryIdentity(write.path);
          if (currentIdentity) {
            throw new Error(
              `Refusing to replace a foreign entry while restoring ${write.path}`,
            );
          }
          await rename(write.backup, write.path);
          const restoredIdentity = await directoryEntryIdentity(write.path);
          if (!restoredIdentity) throw new Error(`Could not restore ${write.path}`);
          recordCreatedFile(creationJournal, write.path, restoredIdentity);
        } else if (write.installed) {
          creationJournal?.files.delete(write.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      preserveBackups = true;
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Project update failed and one or more files could not be rolled back",
      );
    }
    throw error;
  } finally {
    await Promise.all(staged.map((write) =>
      rm(write.temporary, { force: true }).catch(() => undefined)));
    if (!preserveBackups) {
      await Promise.all(staged.map((write) =>
        rm(write.backup, { force: true }).catch(() => undefined)));
    }
  }
}

export async function appendKouboEvent(
  jobDir: string,
  type: string,
  payload: JsonObject = {},
  now: Date = new Date(),
): Promise<void> {
  await appendFile(
    join(jobDir, "events.jsonl"),
    `${JSON.stringify({ ts: now.toISOString(), type, payload })}\n`,
    "utf8",
  );
}

async function resolveKouboDirectory(value: string): Promise<string> {
  const directory = await realpath(resolve(value));
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`Koubo job is not a directory: ${directory}`);
  }
  return directory;
}

export async function resolveKouboJobDirectory(value: string): Promise<string> {
  const directory = await resolveKouboDirectory(value);
  if (!existsSync(join(directory, "project.json"))) {
    throw new Error(`Koubo job is missing project.json: ${directory}`);
  }
  return directory;
}

function projectRelativePath(jobDir: string, path: string): string {
  const value = relative(jobDir, path);
  if (!value || value === "") return basename(path);
  if (value.startsWith(`..${sep}`) || value === ".." || isAbsolute(value)) {
    throw new Error(`Project files must stay inside the job directory: ${path}`);
  }
  return value.split(sep).join("/");
}

function normalizeSuggestion(
  value: unknown,
  isGap: boolean,
  duration: number,
): KouboTranscriptWord["suggestion"] {
  const text = String(value ?? "").toLowerCase();
  if (/silence|静音|停顿/.test(text) || (isGap && duration >= 0.5)) return "silence";
  if (/filler|口头禅|语气词/.test(text)) return "filler";
  if (/repeat|重说|重复/.test(text)) return "repeat";
  if (/stutter|卡顿|结巴/.test(text)) return "stutter";
  if (/incomplete|残句/.test(text)) return "incomplete";
  return undefined;
}

function normalizeWord(
  raw: unknown,
  index: number,
  fallbackStart = 0,
  fallbackEnd = 0,
): KouboTranscriptWord {
  const value = isObject(raw) ? raw : {};
  const text = String(value.text ?? "");
  const start = Math.max(0, finite(value.start, fallbackStart));
  const end = Math.max(start, finite(value.end, fallbackEnd));
  const isGap = Boolean(value.isGap) || (!text.trim() && end > start);
  const suggestion = normalizeSuggestion(
    value.suggestion ?? value.reason ?? value.kind,
    isGap,
    end - start,
  );
  return {
    id: String(value.id ?? value.wordId ?? `w-${String(index + 1).padStart(6, "0")}`),
    text,
    start,
    end,
    isGap,
    ...(suggestion ? { suggestion } : {}),
  };
}

function groupWords(words: KouboTranscriptWord[]): KouboTranscriptCue[] {
  const cues: KouboTranscriptCue[] = [];
  let current: KouboTranscriptWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    cues.push({
      id: `cue-${String(cues.length + 1).padStart(4, "0")}`,
      start: current[0].start,
      end: current.at(-1)?.end ?? current[0].end,
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    const longGap = word.isGap && word.end - word.start >= 0.5;
    const sentenceEnd = !word.isGap && /[。！？!?]$/.test(word.text);
    if (longGap || sentenceEnd || current.length >= 24) flush();
  }
  flush();
  return cues;
}

function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9][A-Za-z0-9+.#_-]*|[\u3400-\u9fff]|[^\s]/gu) ?? [];
}

function parseSrtTime(value: string): number {
  const match = value.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function transcriptFromSrt(content: string): KouboTranscript {
  const cues: KouboTranscriptCue[] = [];
  let wordIndex = 0;
  for (const block of content.replaceAll("\r", "").trim().split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [left, right] = lines[timingIndex].split("-->").map((part) => part.trim());
    const start = parseSrtTime(left);
    const end = Math.max(start, parseSrtTime(right));
    const tokens = tokenize(lines.slice(timingIndex + 1).join(" ").trim());
    const step = tokens.length > 0 ? (end - start) / tokens.length : 0;
    const words = tokens.map((token, index) => {
      const normalized = normalizeWord({
        id: `w-${String(++wordIndex).padStart(6, "0")}`,
        text: token,
        start: start + index * step,
        end: index === tokens.length - 1 ? end : start + (index + 1) * step,
      }, wordIndex - 1);
      return normalized;
    });
    if (words.length > 0) {
      cues.push({
        id: `cue-${String(cues.length + 1).padStart(4, "0")}`,
        start,
        end,
        words,
      });
    }
  }
  return { schemaVersion: 1, cues };
}

export function normalizeKouboTranscript(payload: unknown): KouboTranscript {
  if (Array.isArray(payload)) {
    const words = payload.map((word, index) => normalizeWord(word, index));
    return { schemaVersion: 1, cues: groupWords(words) };
  }
  const source = isObject(payload) ? payload : {};
  const rawCues = Array.isArray(source.cues) ? source.cues : [];
  const cues: KouboTranscriptCue[] = [];
  let wordIndex = 0;
  rawCues.forEach((rawCue, cueIndex) => {
    const cue = isObject(rawCue) ? rawCue : {};
    let words: KouboTranscriptWord[];
    if (Array.isArray(cue.words)) {
      words = cue.words.map((word) => normalizeWord(word, wordIndex++, finite(cue.start), finite(cue.end)));
    } else {
      const tokens = tokenize(String(cue.text ?? ""));
      const start = finite(cue.start);
      const end = Math.max(start, finite(cue.end, start));
      const step = tokens.length > 0 ? (end - start) / tokens.length : 0;
      words = tokens.map((token, index) => normalizeWord({
        text: token,
        start: start + index * step,
        end: index === tokens.length - 1 ? end : start + (index + 1) * step,
      }, wordIndex++));
    }
    if (words.length === 0) return;
    cues.push({
      id: String(cue.id ?? `cue-${String(cueIndex + 1).padStart(4, "0")}`),
      start: words[0].start,
      end: words.at(-1)?.end ?? words[0].end,
      words,
    });
  });
  return { schemaVersion: 1, cues };
}

async function findFile(jobDir: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = resolve(jobDir, candidate);
    if (existsSync(path)) return realpath(path);
  }
  return null;
}

async function loadTranscript(path: string): Promise<KouboTranscript> {
  if (extname(path).toLowerCase() === ".srt") {
    return transcriptFromSrt(await readFile(path, "utf8"));
  }
  return normalizeKouboTranscript(await readJson(path));
}

function normalizedIndexes(value: unknown, length: number): number[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(Number).filter(
    (index) => Number.isInteger(index) && index >= 0 && index < length,
  ))].sort((left, right) => left - right);
}

function existingSelectionIndexes(selection: unknown, words: readonly KouboTranscriptWord[]): number[] {
  const record = isObject(selection) ? selection : {};
  const ids = new Set(
    Array.isArray(record.cutWordIds) ? record.cutWordIds.map(String) : [],
  );
  return words.flatMap((word, index) => ids.has(word.id) ? [index] : []);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function previewProxyDescriptor(
  jobDir: string,
  result: PreviewProxyResult,
): Promise<JsonObject> {
  const base: JsonObject = {
    schemaVersion: 1,
    profile: "source-timeline-v1",
    status: result.status,
    reason: result.reason,
    message: result.message,
    sourceSha256: result.sourceSha256,
    cacheKey: result.cacheKey,
    cacheHit: result.cacheHit,
    config: result.config,
  };
  if (
    result.status !== "ready" ||
    !result.proxyPath ||
    !result.proxyProbe ||
    !result.sourceSha256 ||
    !result.cacheKey
  ) {
    return base;
  }
  const info = await stat(result.proxyPath);
  const source = projectRelativePath(jobDir, await realpath(result.proxyPath));
  return {
    ...base,
    source,
    revision: `${result.cacheKey}-${Math.round(info.mtimeMs)}-${info.size}`,
    byteLength: info.size,
    duration: result.proxyProbe.duration,
    startTime: result.proxyProbe.startTime,
    width: result.proxyProbe.width,
    height: result.proxyProbe.height,
    frameRate: result.proxyProbe.frameRate,
    maxKeyframeIntervalSeconds: result.proxyProbe.maxKeyframeIntervalSeconds,
  };
}

export interface KouboPreviewProxySource {
  source: string;
  browserSource: string;
  revision: string;
}

/** Resolve a product-generated proxy without trusting mutable project JSON paths. */
export async function resolveKouboPreviewProxySource(
  inputDirectory: string,
): Promise<KouboPreviewProxySource | null> {
  try {
    const jobDir = await resolveKouboJobDirectory(inputDirectory);
    const metadata = await readJson<JsonObject>(join(jobDir, "workbench.json"));
    const project = await readJson<JsonObject>(join(jobDir, "project.json"));
    const previewProxy = isObject(metadata.previewProxy) ? metadata.previewProxy : null;
    const projectSource = isObject(project.source) ? project.source : null;
    if (
      previewProxy?.status !== "ready" ||
      typeof previewProxy.source !== "string" ||
      typeof previewProxy.revision !== "string" ||
      typeof previewProxy.sourceSha256 !== "string" ||
      typeof previewProxy.cacheKey !== "string" ||
      typeof metadata.sourceSha256 !== "string" ||
      typeof projectSource?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(previewProxy.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(previewProxy.cacheKey) ||
      !previewProxy.source.endsWith(`${previewProxy.cacheKey}.mp4`) ||
      !previewProxy.revision.startsWith(`${previewProxy.cacheKey}-`) ||
      previewProxy.sourceSha256 !== metadata.sourceSha256 ||
      previewProxy.sourceSha256 !== projectSource.sha256 ||
      !Number.isFinite(Number(previewProxy.duration)) ||
      Math.abs(Number(previewProxy.duration) - Number(metadata.duration)) > 0.12 ||
      Math.abs(Number(previewProxy.startTime)) > 0.05
    ) {
      return null;
    }
    const candidate = await realpath(resolve(jobDir, previewProxy.source));
    const info = await stat(candidate);
    if (
      !info.isFile() ||
      info.size <= 0 ||
      Number(previewProxy.byteLength) !== info.size ||
      extname(candidate).toLowerCase() !== ".mp4"
    ) {
      return null;
    }
    const source = projectRelativePath(jobDir, candidate);
    return {
      source,
      browserSource: `${source}?v=${encodeURIComponent(previewProxy.revision)}`,
      revision: previewProxy.revision,
    };
  } catch {
    return null;
  }
}

function applyManualSelectionDelta(input: {
  baselineCutWordIds: readonly string[];
  previousBaselineCutWordIds: readonly string[];
  previousCutWordIds: readonly string[];
  availableWordIds: ReadonlySet<string>;
}): string[] {
  const previousBaseline = new Set(input.previousBaselineCutWordIds);
  const previousSelection = new Set(input.previousCutWordIds);
  const removedByUser = new Set(
    input.previousBaselineCutWordIds.filter((id) => !previousSelection.has(id)),
  );
  const addedByUser = input.previousCutWordIds.filter((id) => !previousBaseline.has(id));
  const result = new Set(
    input.baselineCutWordIds.filter((id) => !removedByUser.has(id)),
  );
  for (const id of addedByUser) {
    if (input.availableWordIds.has(id)) result.add(id);
  }
  return [...result];
}

function materializeCutTranscript(
  transcript: KouboTranscript,
  deleteSegments: readonly { start: number; end: number }[],
): { transcript: KouboTranscript; cutWordIds: string[] } {
  const splitWords: KouboTranscriptWord[] = [];
  const cutWordIds: string[] = [];
  const epsilon = 0.0005;
  for (const word of transcript.cues.flatMap((cue) => cue.words)) {
    const boundaries = [word.start, word.end];
    if (word.isGap) {
      for (const segment of deleteSegments) {
        if (segment.start > word.start + epsilon && segment.start < word.end - epsilon) {
          boundaries.push(segment.start);
        }
        if (segment.end > word.start + epsilon && segment.end < word.end - epsilon) {
          boundaries.push(segment.end);
        }
      }
    }
    boundaries.sort((left, right) => left - right);
    const unique = boundaries.filter(
      (value, index) => index === 0 || value - boundaries[index - 1] > epsilon,
    );
    for (let index = 0; index < unique.length - 1; index += 1) {
      const start = unique[index];
      const end = unique[index + 1];
      if (end <= start + epsilon) continue;
      const midpoint = start + (end - start) / 2;
      const cut = deleteSegments.some(
        (segment) => midpoint >= segment.start - epsilon && midpoint < segment.end + epsilon,
      );
      const split = unique.length > 2;
      const id = split && index > 0
        ? `${word.id}__part_${Math.round(start * 1000)}_${Math.round(end * 1000)}`
        : word.id;
      const { suggestion: _suggestion, ...rest } = word;
      splitWords.push({ ...rest, id, start, end });
      if (cut) cutWordIds.push(id);
    }
  }
  return { transcript: { schemaVersion: 1, cues: groupWords(splitWords) }, cutWordIds };
}

function buildRanges(
  words: readonly KouboTranscriptWord[],
  cutWordIds: readonly string[],
): Array<{ start: number; end: number }> {
  const ids = new Set(cutWordIds);
  const ranges: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;
  for (const word of words) {
    if (!ids.has(word.id)) {
      if (current) ranges.push(current);
      current = null;
      continue;
    }
    if (!current) current = { start: word.start, end: word.end };
    else current.end = Math.max(current.end, word.end);
  }
  if (current) ranges.push(current);
  return ranges;
}

export function frameDimensions(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === "3:4") return { width: 1080, height: 1440 };
  if (aspectRatio === "4:3") return { width: 1440, height: 1080 };
  if (aspectRatio === "9:16") return { width: 1080, height: 1920 };
  return { width: 1920, height: 1080 };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const MANAGED_A_ROLL_START = "<!-- chengfeng-videocut:a-roll:start -->";
const MANAGED_A_ROLL_END = "<!-- chengfeng-videocut:a-roll:end -->";
const MANAGED_EDL_PLAYER_ATTRIBUTE = "data-chengfeng-videocut-edl-player";
const MANAGED_PROJECTION_SCHEMA_ATTRIBUTE = "data-videocut-projection-schema";
const MANAGED_PROJECTION_RUNTIME_ATTRIBUTE = "data-videocut-projection-runtime";

/** Structural contract of the Product-owned A-roll projection in index.html. */
export const KOUBO_PROJECTION_SCHEMA_VERSION = "1";
/** Runtime generator contract. Bump whenever the embedded EDL player changes. */
export const KOUBO_PROJECTION_RUNTIME_VERSION = "5";

function renderManagedARollVideos(
  editList: EditListDocument,
  previewSourceOverride?: string,
): string {
  const previewSource = escapeHtml(
    previewSourceOverride ?? editList.segments[0]?.source ?? "",
  );
  const proxyAttribute = previewSourceOverride ? " data-videocut-preview-proxy" : "";
  const preload = previewSourceOverride ? "auto" : "metadata";
  const preview = `      <video data-hf-id="hf-a-roll-preview" id="a-roll-preview" class="a-roll-segment" src="${previewSource}" data-edl-source="${previewSource}" data-source-duration="${editList.sourceDuration.toFixed(3)}" data-videocut-edl-backing${proxyAttribute} data-studio-timeline-hidden preload="${preload}" muted playsinline></video>`;
  const timelineSegments = editList.segments.map((segment) => {
    const id = escapeHtml(segment.id);
    const source = escapeHtml(previewSourceOverride ?? segment.source);
    const timelineDuration = (segment.sourceEnd - segment.sourceStart) / segment.playbackRate;
    return `      <div data-hf-id="hf-${id}" id="${id}" class="clip a-roll-timeline-segment" data-edl-segment-id="${id}" data-edl-media-src="${source}" data-source-start="${segment.sourceStart.toFixed(3)}" data-source-end="${segment.sourceEnd.toFixed(3)}" data-media-start="${segment.sourceStart.toFixed(3)}" data-source-duration="${editList.sourceDuration.toFixed(3)}" data-playback-rate="${segment.playbackRate.toFixed(3)}" data-start="${segment.timelineStart.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="1" data-timeline-role="a-roll" data-timeline-label="A-roll 口播（音画一体）" data-has-audio="true" hidden aria-hidden="true"></div>`;
  }).join("\n");
  return `${preview}\n${timelineSegments}`;
}

function renderManagedARollRegion(
  editList: EditListDocument,
  previewSourceOverride?: string,
): string {
  return [
    `      ${MANAGED_A_ROLL_START}`,
    renderManagedARollVideos(editList, previewSourceOverride),
    `      ${MANAGED_A_ROLL_END}`,
  ].join("\n");
}

function renderManagedEdlPlayer(
  editList: EditListDocument,
  previewSourceOverride?: string,
): string {
  const previewEditList = previewSourceOverride
    ? {
        ...editList,
        segments: editList.segments.map((segment) => ({
          ...segment,
          source: previewSourceOverride,
        })),
      }
    : editList;
  const payload = renderEdlPreviewPayload(previewEditList);
  return `    <script type="application/json" ${EDL_PREVIEW_PAYLOAD_ATTRIBUTE}="1">${payload}</script>\n    <script ${MANAGED_EDL_PLAYER_ATTRIBUTE}="1" ${MANAGED_PROJECTION_RUNTIME_ATTRIBUTE}="${KOUBO_PROJECTION_RUNTIME_VERSION}">\n${renderEdlPreviewRuntime()}\n    </script>`;
}

function replaceHtmlAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`);
  const attribute = ` ${name}="${escapeHtml(value)}"`;
  return pattern.test(tag)
    ? tag.replace(pattern, attribute)
    : tag.replace(/>$/, `${attribute}>`);
}

function readHtmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`));
  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * A projection is current only when both its EDL snapshot and its generator
 * contract match this build. Missing version markers are legacy by definition.
 */
export function isCurrentKouboProjectIndex(
  content: string,
  expectedEditListRevision: string,
): boolean {
  if (!generatedIndex(content)) return false;
  const root = content.match(
    /<main\b(?=[^>]*\bdata-composition-id=(?:"main"|'main'))[^>]*>/,
  )?.[0];
  if (!root) return false;
  if (readHtmlAttribute(root, "data-edit-list-revision") !== expectedEditListRevision) {
    return false;
  }
  if (
    readHtmlAttribute(root, MANAGED_PROJECTION_SCHEMA_ATTRIBUTE) !==
      KOUBO_PROJECTION_SCHEMA_VERSION ||
    readHtmlAttribute(root, MANAGED_PROJECTION_RUNTIME_ATTRIBUTE) !==
      KOUBO_PROJECTION_RUNTIME_VERSION
  ) {
    return false;
  }
  if (!content.includes(MANAGED_A_ROLL_START) || !content.includes(MANAGED_A_ROLL_END)) {
    return false;
  }
  const managedPlayer = content.match(
    new RegExp(
      `<script\\b(?=[^>]*\\b${MANAGED_EDL_PLAYER_ATTRIBUTE}=(?:"[^"]*"|'[^']*'))[^>]*>`,
    ),
  )?.[0];
  const managedPayload = content.match(
    new RegExp(
      `<script\\b(?=[^>]*\\b${EDL_PREVIEW_PAYLOAD_ATTRIBUTE}=(?:"[^"]*"|'[^']*'))(?=[^>]*\\btype=(?:"application/json"|'application/json'))[^>]*>`,
    ),
  )?.[0];
  return Boolean(
    managedPayload &&
      managedPlayer &&
      readHtmlAttribute(managedPlayer, MANAGED_PROJECTION_RUNTIME_ATTRIBUTE) ===
        KOUBO_PROJECTION_RUNTIME_VERSION,
  );
}

/**
 * Updates only product-owned A-roll nodes and product-owned duration metadata.
 * User overlays, B-roll, animation markup, styles, and scripts remain byte
 * stable. Comment sentinels are a logical container because HyperFrames media
 * must stay a direct child of the composition root.
 */
export function patchKouboProjectIndex(
  content: string,
  editListInput: EditListDocument,
  editListRevision = contentRevision(jsonContent(editListInput)),
  previewSourceOverride?: string,
): string {
  const editList = parseEditListDocument(editListInput);
  if (!generatedIndex(content)) {
    throw new Error("index.html is user-authored and cannot be patched by the edit-list compiler");
  }
  const region = renderManagedARollRegion(editList, previewSourceOverride);
  const managedRegionPattern = new RegExp(
    `^[ \\t]*${MANAGED_A_ROLL_START}[\\s\\S]*?^[ \\t]*${MANAGED_A_ROLL_END}`,
    "m",
  );
  let next = content;
  if (managedRegionPattern.test(next)) {
    next = next.replace(managedRegionPattern, region);
  } else {
    const managedVideoPattern = /^[ \t]*<video\b(?=[^>]*\bdata-edl-segment-id=(?:"[^"]*"|'[^']*'))[^>]*><\/video>[ \t]*$/gm;
    let inserted = false;
    next = next.replace(managedVideoPattern, () => {
      if (inserted) return "";
      inserted = true;
      return region;
    });
    if (!inserted) {
      const legacyVideoPattern = /^[ \t]*<video\b(?=[^>]*\bid=(?:"a-roll-main"|'a-roll-main'))[^>]*><\/video>[ \t]*$/m;
      if (legacyVideoPattern.test(next)) {
        next = next.replace(legacyVideoPattern, region);
      } else {
        throw new Error("Generated index.html has no product-owned A-roll region");
      }
    }
  }

  const rootPattern = /<main\b(?=[^>]*\bdata-composition-id=(?:"main"|'main'))[^>]*>/;
  if (!rootPattern.test(next)) throw new Error("Generated index.html is missing the main composition root");
  next = next.replace(rootPattern, (tag) => replaceHtmlAttribute(
    replaceHtmlAttribute(
      replaceHtmlAttribute(
        replaceHtmlAttribute(
          replaceHtmlAttribute(tag, "data-duration", editList.duration.toFixed(3)),
          "data-edl-mode",
          editList.mode,
        ),
        "data-edit-list-revision",
        editListRevision,
      ),
      "data-videocut-preview",
      "edl-adapter",
    ),
    "data-render-policy",
    "preview-only",
  ));
  next = next.replace(rootPattern, (tag) => replaceHtmlAttribute(
    replaceHtmlAttribute(
      tag,
      MANAGED_PROJECTION_SCHEMA_ATTRIBUTE,
      KOUBO_PROJECTION_SCHEMA_VERSION,
    ),
    MANAGED_PROJECTION_RUNTIME_ATTRIBUTE,
    KOUBO_PROJECTION_RUNTIME_VERSION,
  ));

  // Migrate projections produced before the managed-duration script marker.
  // New projections derive this value from the root and need no script rewrite.
  if (!next.includes("chengfeng-videocut:managed-duration")) {
    next = next.replace(
      /(timeline\.to\(\{\},\s*\{\s*duration:\s*)[0-9.]+(\s*,\s*ease:\s*"none")/,
      `$1${editList.duration.toFixed(3)}$2`,
    );
  }
  const managedPlayer = renderManagedEdlPlayer(editList, previewSourceOverride);
  const managedPayloadPattern = new RegExp(
    `^[ \\t]*<script\\b(?=[^>]*\\b${EDL_PREVIEW_PAYLOAD_ATTRIBUTE}=(?:"[^"]*"|'[^']*'))[^>]*>[\\s\\S]*?<\\/script>[ \\t]*$`,
    "m",
  );
  const managedPayload = managedPlayer.match(managedPayloadPattern)?.[0];
  if (!managedPayload) throw new Error("Generated EDL player is missing its payload");
  if (managedPayloadPattern.test(next)) {
    next = next.replace(managedPayloadPattern, managedPayload);
  } else {
    const playerTag = new RegExp(
      `<script\\b(?=[^>]*\\b${MANAGED_EDL_PLAYER_ATTRIBUTE}=(?:"[^"]*"|'[^']*'))`,
    );
    next = playerTag.test(next)
      ? next.replace(playerTag, `${managedPayload}\n    <script`)
      : next.replace("</body>", `${managedPayload}\n  </body>`);
  }
  const managedRuntime = managedPlayer.replace(managedPayloadPattern, "").trim();
  const managedPlayerPattern = new RegExp(
    `^[ \\t]*<script\\b(?=[^>]*\\b${MANAGED_EDL_PLAYER_ATTRIBUTE}=(?:"[^"]*"|'[^']*'))[^>]*>[\\s\\S]*?<\\/script>[ \\t]*$`,
    "m",
  );
  if (managedPlayerPattern.test(next)) {
    next = next.replace(managedPlayerPattern, managedRuntime);
  } else if (next.includes(EDL_PREVIEW_RUNTIME_CONTRACT)) {
    // bundleToSingleHtml coalesces executable body scripts and drops their
    // attributes. The contract marker proves the Product runtime is already
    // present; only the preserved JSON payload above must be replaced.
  } else if (next.includes("</body>")) {
    next = next.replace("</body>", `    ${managedRuntime}\n  </body>`);
  } else {
    next = `${next}\n    ${managedRuntime}\n`;
  }
  return next;
}

export function renderKouboProjectIndex(input: {
  title: string;
  width: number;
  height: number;
  duration: number;
  videoSource: string;
  editList?: EditListDocument;
  editListRevision?: string;
  previewSource?: string;
}): string {
  const editList = input.editList ? parseEditListDocument(input.editList) : null;
  const resolvedDuration = editList?.duration ?? input.duration;
  const duration = Math.max(0, resolvedDuration).toFixed(3);
  const title = escapeHtml(input.title);
  const videoSource = escapeHtml(input.videoSource);
  const editListRevision = editList
    ? input.editListRevision ?? contentRevision(jsonContent(editList))
    : null;
  const videos = editList
    ? renderManagedARollRegion(editList, input.previewSource)
    : `      <video data-hf-id="hf-a-roll" id="a-roll-main" class="a-roll-segment" src="${videoSource}" data-start="0" data-duration="${duration}" data-track-index="1" data-timeline-role="a-roll" data-timeline-label="A-roll 口播原片（音画一体）" data-has-audio="true" preload="auto" playsinline></video>`;
  return `<!DOCTYPE html>
<!-- generated-by: chengfeng-videocut -->
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=${input.width}, height=${input.height}">
    <title>${title}</title>
    <script src="/api/vendor/gsap.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${input.width}px; height: ${input.height}px; margin: 0; overflow: hidden; background: #111; }
      #root { position: relative; width: ${input.width}px; height: ${input.height}px; overflow: hidden; background: #111; }
      .a-roll-segment { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #111; }
    </style>
  </head>
  <body>
    <main data-hf-id="hf-root" id="root" data-composition-id="main" data-start="0" data-width="${input.width}" data-height="${input.height}" data-duration="${duration}"${editList ? ` data-edl-mode="${editList.mode}" data-edit-list-revision="${escapeHtml(editListRevision)}" data-videocut-preview="edl-adapter" data-render-policy="preview-only" ${MANAGED_PROJECTION_SCHEMA_ATTRIBUTE}="${KOUBO_PROJECTION_SCHEMA_VERSION}" ${MANAGED_PROJECTION_RUNTIME_ATTRIBUTE}="${KOUBO_PROJECTION_RUNTIME_VERSION}"` : ""}>
${videos}
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      const timeline = gsap.timeline({ paused: true });
      // chengfeng-videocut:managed-duration
      const managedDuration = Number(document.getElementById("root").dataset.duration);
      timeline.to({}, { duration: managedDuration, ease: "none" }, 0);
      window.__timelines.main = timeline;
    </script>
${editList ? renderManagedEdlPlayer(editList, input.previewSource) : ""}
  </body>
</html>
`;
}

function contentRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveEditListCandidate(input: {
  projectId: string;
  videoSource: string;
  duration: number;
  transcriptRaw: string;
  cutsRaw: string;
  existingRaw: string | null;
}): { editList: EditListDocument; raw: string; changed: boolean } {
  const cutSelection = JSON.parse(input.cutsRaw) as {
    cutRanges?: Array<{ start: number; end: number }>;
  };
  const next = buildEditListFromCuts({
    projectId: input.projectId,
    source: input.videoSource,
    sourceDuration: input.duration,
    cutsRevision: contentRevision(input.cutsRaw),
    transcriptRevision: contentRevision(input.transcriptRaw),
    cutRanges: Array.isArray(cutSelection.cutRanges) ? cutSelection.cutRanges : [],
  });
  if (input.existingRaw === null) {
    return { editList: next, raw: jsonContent(next), changed: true };
  }
  const existing = parseEditListDocument(JSON.parse(input.existingRaw) as unknown);
  if (existing.projectId !== input.projectId) {
    throw new Error(
      `edit-list.json belongs to project ${existing.projectId}, not ${input.projectId}`,
    );
  }
  const sourceMatches = existing.sourceDuration === next.sourceDuration &&
    existing.segments.every((segment) => segment.source === input.videoSource);
  const basesMatch = existing.baseCutsRevision === next.baseCutsRevision &&
    existing.baseTranscriptRevision === next.baseTranscriptRevision;
  if (existing.mode === "manual") {
    if (!sourceMatches || !basesMatch) {
      throw new Error(
        "edit-list.json contains manual timeline edits and no longer matches the current Cuts/source; rebase explicitly instead of overwriting it",
      );
    }
    return { editList: existing, raw: input.existingRaw, changed: false };
  }
  if (sourceMatches && basesMatch) {
    return { editList: existing, raw: input.existingRaw, changed: false };
  }
  return { editList: next, raw: jsonContent(next), changed: true };
}

export async function materializeKouboEditListIndex(
  inputDirectory: string,
  options: { expectedRevision?: string } = {},
): Promise<{
  projectId: string;
  indexPath: string;
  editList: EditListDocument;
  revision: string;
  materialized: boolean;
}> {
  const jobDir = await resolveKouboJobDirectory(inputDirectory);
  const project = await readJson<JsonObject>(join(jobDir, "project.json"));
  const metadata = await readJson<JsonObject>(join(jobDir, "workbench.json"));
  const editListPath = join(jobDir, "edit-list.json");
  const editListRaw = await readFile(editListPath, "utf8");
  const revision = contentRevision(editListRaw);
  const editList = parseEditListDocument(JSON.parse(editListRaw) as unknown);
  const projectId = String(project.jobId ?? basename(jobDir));
  if (editList.projectId !== projectId) {
    throw new Error(`edit-list.json belongs to project ${editList.projectId}, not ${projectId}`);
  }
  const ratio = String(
    (isObject(project.config) ? project.config.aspectRatio : undefined) ??
      metadata.aspectRatio ??
      "3:4",
  );
  const dimensions = frameDimensions(ratio);
  const videoSource = editList.segments[0]?.source;
  if (!videoSource) throw new Error("edit-list.json has no source segment");
  const indexPath = join(jobDir, "index.html");
  const existingIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : "";
  if (existingIndex && !generatedIndex(existingIndex)) {
    throw new Error("index.html is user-authored and cannot be replaced by the edit-list compiler");
  }
  const projectedIndex = existingIndex
    ? isCurrentKouboProjectIndex(existingIndex, revision)
      ? existingIndex
      : patchKouboProjectIndex(existingIndex, editList, revision)
    : renderKouboProjectIndex({
        title: String(project.title ?? project.jobId ?? basename(jobDir)),
        ...dimensions,
        duration: editList.duration,
        videoSource,
        editList,
        editListRevision: revision,
      });
  const expectedRevision = options.expectedRevision ?? revision;
  const materialized = options.expectedRevision !== undefined && options.expectedRevision !== revision
    ? false
    : projectedIndex === existingIndex
      ? false
      : await atomicWriteText(indexPath, projectedIndex, {
    // The compiler may be slower than the next PATCH. Check immediately before
    // the atomic rename so an older projection cannot replace a newer index.
    shouldCommit: async () => {
      if (contentRevision(await readFile(editListPath, "utf8")) !== expectedRevision) {
        return false;
      }
      try {
        return await readFile(indexPath, "utf8") === existingIndex;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return existingIndex === "";
        throw error;
      }
    },
      });
  return {
    projectId,
    indexPath,
    editList,
    revision,
    materialized,
  };
}

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed (${code ?? "signal"}): ${stderr.trim().slice(-2000)}`));
    });
  });
}

async function probeDuration(path: string): Promise<number> {
  try {
    const output = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `file:${path}`,
    ]);
    return Math.max(0, finite(output.trim()));
  } catch {
    return 0;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function resolveJobFile(jobDir: string, value: string): Promise<string> {
  const path = resolve(jobDir, value);
  if (!existsSync(path)) throw new Error(`File does not exist: ${path}`);
  const resolved = await realpath(path);
  projectRelativePath(jobDir, resolved);
  return resolved;
}

async function resolveTaskLocalCreateFile(
  jobDir: string,
  value: string,
  option: "--video" | "--transcript",
): Promise<string> {
  if (!value.trim()) {
    throw new VideocutError("invalid_argument", `project create requires ${option}`);
  }
  let path: string;
  try {
    path = await realpath(resolve(jobDir, value));
    projectRelativePath(jobDir, path);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) {
      throw new Error("not a non-empty regular file");
    }
  } catch (error) {
    throw new VideocutError(
      "invalid_argument",
      `${option} must name a non-empty task-local file inside ${jobDir}`,
      {
        option,
        value,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return path;
}

async function atomicCopyNewFile(
  source: string,
  target: string,
  creationJournal: ProjectCreationJournal,
): Promise<void> {
  await ensureProjectFileParent(target, creationJournal);
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    const identity = await directoryEntryIdentity(temporary);
    if (!identity) throw new Error(`Staged canonical file disappeared: ${temporary}`);
    // A hard link publishes the complete staged bytes without overwriting a
    // path created by a non-cooperating process between validation and commit.
    await link(temporary, target);
    recordCreatedFile(creationJournal, target, identity);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicCreateText(
  path: string,
  content: string,
  creationJournal: ProjectCreationJournal,
): Promise<void> {
  await ensureProjectFileParent(path, creationJournal);
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    const identity = await directoryEntryIdentity(temporary);
    if (!identity) throw new Error(`Staged project file disappeared: ${temporary}`);
    await link(temporary, path);
    recordCreatedFile(creationJournal, path, identity);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertNewProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("\0")
  ) {
    throw new VideocutError("invalid_project", `Invalid project id: ${projectId}`);
  }
  if (projectId.toLowerCase() === "demo") {
    throw new VideocutError(
      "invalid_project",
      "The reserved demo project id cannot be used for a real task",
      { projectId },
    );
  }
}

async function rollbackCreatedFiles(journal: ProjectCreationJournal): Promise<void> {
  const failures: unknown[] = [];
  for (const [path, identity] of [...journal.files].reverse()) {
    try {
      const currentIdentity = await directoryEntryIdentity(path);
      if (sameIdentity(currentIdentity, identity)) await rm(path, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  for (const [path, identity] of [...journal.directories].reverse()) {
    try {
      const currentIdentity = await directoryEntryIdentity(path);
      if (!sameIdentity(currentIdentity, identity)) continue;
      await rmdir(path);
    } catch (error) {
      // A user/foreign writer may have populated a directory created by this
      // transaction. Leaving that non-empty directory is safer than recursion.
      if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Could not completely roll back project creation");
  }
}

function generatedIndex(content: string): boolean {
  return content.includes("generated-by: chengfeng-videocut") ||
    content.includes("generated-by: koubo-video-workbench");
}

async function prepareKouboProjectSnapshot(
  inputDirectory: string,
  options: PrepareKouboProjectOptions = {},
  creationJournal?: ProjectCreationJournal,
): Promise<PreparedKouboProject> {
  const jobDir = await resolveKouboJobDirectory(inputDirectory);
  const projectPath = join(jobDir, "project.json");
  const project = await readJson<JsonObject>(projectPath);
  const metadataPath = join(jobDir, "workbench.json");
  const previous = existsSync(metadataPath) ? await readJson<JsonObject>(metadataPath) : {};
  const videoCandidates = options.video
    ? [options.video]
    : [
        typeof project.inputVideo === "string" ? project.inputVideo : "",
        "input/source.mp4",
      ].filter(Boolean);
  let videoPath: string | null = null;
  for (const candidate of videoCandidates) {
    try {
      videoPath = await resolveJobFile(jobDir, candidate);
      break;
    } catch {
      // Try the next explicit task-local source. Demo/default media is never used.
    }
  }
  if (!videoPath) {
    throw new Error(`No real task video found. Checked: ${videoCandidates.join(", ") || "none"}`);
  }

  const transcriptPath = options.transcript
    ? await resolveJobFile(jobDir, options.transcript)
    : await findFile(jobDir, [
        "剪口播/1_转录/subtitles_words.json",
        "transcript.json",
        "subtitles_words.json",
        "subtitles.srt",
        "字幕/3_输出/video.srt",
      ]);
  if (!transcriptPath) throw new Error("No transcript source was found for this task");
  const sourceTranscript = await loadTranscript(transcriptPath);
  if (sourceTranscript.cues.length === 0) throw new Error(`Transcript is empty: ${transcriptPath}`);
  const sourceWords = sourceTranscript.cues.flatMap((cue) => cue.words);
  const duration = finite(options.duration) ||
    await probeDuration(videoPath) ||
    Math.max(0, ...sourceWords.map((word) => word.end));
  if (!(duration > 0)) throw new Error("Could not determine video duration");

  const autoSelectionPath = await findFile(jobDir, [
    "剪口播/2_分析/auto_selected.json",
    "auto_selected.json",
  ]);
  const autoSelectionIndexes = autoSelectionPath
    ? normalizedIndexes(await readJson(autoSelectionPath), sourceWords.length)
    : [];
  const autoSelectionFingerprint = createHash("sha256")
    .update(JSON.stringify(autoSelectionIndexes))
    .digest("hex");
  const transcriptOutput = join(jobDir, "transcript.json");
  const cutSelectionPath = join(jobDir, "cut-selection.json");
  const pausePlanPath = join(jobDir, "剪口播/3_审核/natural_pause_plan.json");
  let existingSelection: unknown = existsSync(cutSelectionPath)
    ? await readJson(cutSelectionPath)
    : null;
  if (!existingSelection) {
    const legacyPath = join(jobDir, "剪口播/3_审核/saved_selection.json");
    const legacyIndexes = existsSync(legacyPath) ? await readJson<unknown[]>(legacyPath) : [];
    const sourceIds = sourceWords.map((word) => word.id);
    const legacyIds = Array.isArray(legacyIndexes)
      ? legacyIndexes.map((index) => sourceIds[Number(index)]).filter((id): id is string => Boolean(id))
      : [];
    existingSelection = {
      schemaVersion: 3,
      cutWordIds: legacyIds,
      cutRanges: buildRanges(sourceWords, legacyIds),
    };
  }
  const existingRecord = isObject(existingSelection) ? existingSelection : {};
  const initialization = isObject(existingRecord.initialization)
    ? existingRecord.initialization
    : {};
  const initialized = initialization.mode === "delete-or-keep-v2";
  // A policy upgrade is intentionally applied only by explicit `project prepare`.
  // Opening Studio or installing a Runtime must never silently change an existing
  // project's current EDL. Stable semantic word IDs are replayed below; old split
  // pause fragments are deliberately not promoted into the v4 all-gap baseline.
  const naturalPausePolicyCurrent =
    initialization.naturalPausePolicy === DEFAULT_NATURAL_PAUSE_POLICY.version;
  const initializeSelection = !existsSync(transcriptOutput) ||
    Boolean(options.transcript) ||
    Boolean(options.refreshTranscript) ||
    !initialized ||
    !naturalPausePolicyCurrent;
  const now = (options.now ?? (() => new Date()))();
  let transcript: KouboTranscript;
  let cutWordIds: string[];
  let transcriptRaw: string;
  let cutsRaw: string;
  let pausePlanRaw: string | null = null;
  let pausePlan: NaturalPausePlan | null = existsSync(pausePlanPath)
    ? await readJson<NaturalPausePlan>(pausePlanPath)
    : null;
  if (initializeSelection) {
    // Only import exact source-word ids on the first migration. A split gap id
    // such as `gap__part_...` represents a derived pause-compression slice and
    // must never be mapped back to the whole source gap.
    const selectedIndexes = [...new Set([
      ...autoSelectionIndexes,
      ...(!initialized ? existingSelectionIndexes(existingSelection, sourceWords) : []),
    ])].sort((left, right) => left - right);
    pausePlan = buildNaturalPausePlan(sourceWords, selectedIndexes, {
      timelineStart: 0,
      timelineEnd: duration,
    });
    const materialized = materializeCutTranscript(sourceTranscript, pausePlan.deleteSegments);
    transcript = materialized.transcript;
    const words = transcript.cues.flatMap((cue) => cue.words);
    const baselineCutWordIds = materialized.cutWordIds;
    cutWordIds = initialized
      ? applyManualSelectionDelta({
          baselineCutWordIds,
          previousBaselineCutWordIds: stringArray(initialization.baselineCutWordIds),
          previousCutWordIds: stringArray(existingRecord.cutWordIds),
          availableWordIds: new Set(words.map((word) => word.id)),
        })
      : baselineCutWordIds;
    const nextInitialization = {
      ...initialization,
      mode: "delete-or-keep-v2",
      autoSelectionSource: autoSelectionPath
        ? projectRelativePath(jobDir, autoSelectionPath)
        : null,
      autoSelectionFingerprint,
      naturalPausePolicy: pausePlan.policy.version,
      baselineCutWordIds,
      initializedAt: typeof initialization.initializedAt === "string"
        ? initialization.initializedAt
        : now.toISOString(),
    };
    const nextSelection: JsonObject = {
      ...existingRecord,
      schemaVersion: 3,
      cutWordIds,
      cutRanges: buildRanges(words, cutWordIds),
      initialization: nextInitialization,
      updatedAt: now.toISOString(),
    };
    const previousWithoutTime = { ...existingRecord, updatedAt: undefined };
    const nextWithoutTime = { ...nextSelection, updatedAt: undefined };
    if (JSON.stringify(previousWithoutTime) === JSON.stringify(nextWithoutTime)) {
      nextSelection.updatedAt = existingRecord.updatedAt;
    }
    transcriptRaw = jsonContent(transcript);
    cutsRaw = jsonContent(nextSelection);
    pausePlanRaw = jsonContent(pausePlan);
  } else {
    transcriptRaw = await readFile(transcriptOutput, "utf8");
    cutsRaw = await readFile(cutSelectionPath, "utf8");
    transcript = JSON.parse(transcriptRaw) as KouboTranscript;
    cutWordIds = Array.isArray(existingRecord.cutWordIds)
      ? existingRecord.cutWordIds.map(String)
      : [];
  }

  const visualPlanPath = join(jobDir, "visual-plan.json");
  const config = isObject(project.config) ? project.config : {};
  const ratio = String(config.aspectRatio ?? previous.aspectRatio ?? "3:4");
  const dimensions = frameDimensions(ratio);
  const videoSource = projectRelativePath(jobDir, videoPath);
  const sourceSha256 = await sha256File(videoPath);
  const existingSource = isObject(project.source) ? project.source : {};
  const recordedSourcePath = typeof existingSource.path === "string"
    ? existingSource.path
    : null;
  const recordedSourceSha256 = typeof existingSource.sha256 === "string"
    ? existingSource.sha256
    : null;
  if (recordedSourcePath && recordedSourcePath !== videoSource) {
    throw new Error(
      `Canonical source path changed from ${recordedSourcePath} to ${videoSource}; use an explicit lineage migration`,
    );
  }
  if (recordedSourceSha256 && recordedSourceSha256 !== sourceSha256) {
    throw new Error(
      `Canonical source SHA-256 changed for ${videoSource}; the immutable source was modified`,
    );
  }
  const previewCacheDirectory = join(jobDir, ".chengfeng-videocut", "preview");
  await ensureSafeProjectDirectory(jobDir, previewCacheDirectory, creationJournal);
  const previewProxyResult = await ensurePreviewProxy({
    sourcePath: videoPath,
    cacheDirectory: previewCacheDirectory,
    dependencies: options.previewProxyDependencies,
  });
  if (
    previewProxyResult.sourceSha256 &&
    previewProxyResult.sourceSha256 !== sourceSha256
  ) {
    throw new Error(
      `Canonical source SHA-256 changed while preparing ${videoSource}`,
    );
  }
  if (
    creationJournal &&
    previewProxyResult.status === "ready" &&
    !previewProxyResult.cacheHit &&
    previewProxyResult.proxyPath
  ) {
    const identity = await directoryEntryIdentity(previewProxyResult.proxyPath);
    if (identity) recordCreatedFile(creationJournal, previewProxyResult.proxyPath, identity);
  }
  const previewProxy = await previewProxyDescriptor(jobDir, previewProxyResult);
  const projectId = String(project.jobId ?? basename(jobDir));
  const editListPath = join(jobDir, "edit-list.json");
  const existingEditListRaw = existsSync(editListPath)
    ? await readFile(editListPath, "utf8")
    : null;
  const editListCandidate = resolveEditListCandidate({
    projectId,
    videoSource,
    duration,
    transcriptRaw,
    cutsRaw,
    existingRaw: existingEditListRaw,
  });
  const editList = editListCandidate.editList;
  const editListRevision = contentRevision(editListCandidate.raw);
  const indexPath = join(jobDir, "index.html");
  const existingIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : "";
  if (existingIndex && !generatedIndex(existingIndex) && options.forceIndex) {
    throw new Error(
      "--force-index cannot replace a user-authored HyperFrames composition; migrate it explicitly with a backup",
    );
  }
  const renderedIndex = !existingIndex
    ? renderKouboProjectIndex({
      title: String(project.title ?? project.jobId ?? basename(jobDir)),
      ...dimensions,
      duration,
      videoSource,
      editList,
      editListRevision,
    })
    : generatedIndex(existingIndex)
      ? isCurrentKouboProjectIndex(existingIndex, editListRevision)
        ? existingIndex
        : patchKouboProjectIndex(existingIndex, editList, editListRevision)
      : null;
  // Revision alone is insufficient: a generated index is current only when
  // both its EDL snapshot and its projection generator/runtime versions match.
  const indexWritten = renderedIndex !== null && renderedIndex !== existingIndex;

  const metadata: JsonObject = {
    schemaVersion: 1,
    projectId,
    jobDir,
    videoSource,
    sourceSha256,
    transcriptSource: projectRelativePath(jobDir, transcriptPath),
    autoSelectionSource: autoSelectionPath ? projectRelativePath(jobDir, autoSelectionPath) : null,
    autoSelectionCount: autoSelectionIndexes.length,
    naturalPausePolicy: pausePlan?.policy.version ?? null,
    plannedDeleteSeconds: pausePlan?.summary.totalDeletedSeconds ?? 0,
    previewProxy,
    aspectRatio: ratio,
    ...dimensions,
    duration,
    createdAt: String(previous.createdAt ?? now.toISOString()),
    updatedAt: now.toISOString(),
  };

  const artifacts = isObject(project.artifacts) ? { ...project.artifacts } : {};
  Object.assign(artifacts, {
    workbenchEntry: "index.html",
    workbenchTranscript: "transcript.json",
    workbenchNaturalPausePlan: projectRelativePath(jobDir, pausePlanPath),
    workbenchCutSelection: "cut-selection.json",
    workbenchEditList: "edit-list.json",
  });
  if (previewProxy.status === "ready" && typeof previewProxy.source === "string") {
    artifacts.workbenchPreviewProxy = previewProxy.source;
  } else {
    delete artifacts.workbenchPreviewProxy;
  }
  if (existsSync(visualPlanPath)) artifacts.workbenchVisualPlan = "visual-plan.json";
  else delete artifacts.workbenchVisualPlan;
  if (autoSelectionPath) {
    artifacts.workbenchAutoSelection = projectRelativePath(jobDir, autoSelectionPath);
  }
  delete artifacts.workbenchSuggestions;
  project.artifacts = artifacts;
  project.source = {
    path: videoSource,
    sha256: sourceSha256,
    immutable: true,
  };
  project.workbench = { projectId, url: `http://127.0.0.1:5190/#project/${encodeURIComponent(projectId)}` };
  project.updatedAt = now.toISOString();
  const event = {
    ts: now.toISOString(),
    type: "workbench_project_prepared",
    payload: {
      projectId,
      autoSelectionCount: autoSelectionIndexes.length,
      naturalPausePolicy: pausePlan?.policy.version ?? null,
      plannedDeleteSeconds: pausePlan?.summary.totalDeletedSeconds ?? 0,
    },
  };
  const eventsPath = join(jobDir, "events.jsonl");
  const eventsRaw = existsSync(eventsPath) ? await readFile(eventsPath, "utf8") : "";
  const writes: ProjectFileWrite[] = [];
  if (initializeSelection) {
    writes.push(
      { path: transcriptOutput, content: transcriptRaw },
      { path: cutSelectionPath, content: cutsRaw },
    );
    if (pausePlanRaw !== null) writes.push({ path: pausePlanPath, content: pausePlanRaw });
  }
  if (editListCandidate.changed) {
    writes.push({ path: editListPath, content: editListCandidate.raw });
  }
  if (indexWritten && renderedIndex !== null) {
    writes.push({ path: indexPath, content: renderedIndex });
  }
  writes.push(
    { path: metadataPath, content: jsonContent(metadata) },
    { path: projectPath, content: jsonContent(project) },
    { path: eventsPath, content: `${eventsRaw}${JSON.stringify(event)}\n` },
  );
  await commitProjectFiles(writes, options.beforeCommitFile, creationJournal);

  return { projectId, directory: jobDir, metadata, transcript, cutWordIds, indexWritten };
}

/**
 * Refreshes an existing canonical project under the shared cross-process
 * project lock. Callers must not wrap this public entry in a second lock.
 */
export async function prepareKouboProject(
  inputDirectory: string,
  options: PrepareKouboProjectOptions = {},
): Promise<PreparedKouboProject> {
  // Resolve only the directory before locking. The project.json existence and
  // all mutable snapshots are checked by prepareKouboProjectSnapshot while the
  // shared project lock is held, avoiding a pre-lock TOCTOU read.
  const jobDir = await resolveKouboDirectory(inputDirectory);
  return serializeKouboProjectOperation(jobDir, () =>
    prepareKouboProjectSnapshot(jobDir, options));
}

/**
 * Establishes a new product project from files that already belong to the
 * task directory. The source inputs are copied to canonical task-local paths,
 * a minimal project.json is created, and the ordinary prepare compiler is run
 * inside one project lock. Captured failures remove every file created by this
 * transaction while preserving the caller's original input files.
 */
export async function createKouboProject(
  inputDirectory: string,
  options: CreateKouboProjectOptions,
): Promise<CreatedKouboProject> {
  let jobDir: string;
  try {
    jobDir = await realpath(resolve(inputDirectory));
    if (!(await stat(jobDir)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new VideocutError(
      "invalid_argument",
      `project create requires an existing task directory: ${resolve(inputDirectory)}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const projectId = basename(jobDir);
  assertNewProjectId(projectId);
  if (
    options.aspectRatio !== "3:4" &&
    options.aspectRatio !== "4:3" &&
    options.aspectRatio !== "16:9"
  ) {
    throw new VideocutError(
      "invalid_argument",
      "aspectRatio must be one of 3:4, 4:3, or 16:9",
      { aspectRatio: options.aspectRatio },
    );
  }

  return serializeKouboProjectOperation(jobDir, async () => {
    const videoPath = await resolveTaskLocalCreateFile(jobDir, options.video, "--video");
    const transcriptPath = await resolveTaskLocalCreateFile(
      jobDir,
      options.transcript,
      "--transcript",
    );
    if (videoPath === transcriptPath) {
      throw new VideocutError(
        "invalid_argument",
        "--video and --transcript must refer to different task-local files",
      );
    }

    const videoExtension = extname(videoPath).toLowerCase();
    if (![".mp4", ".mov", ".m4v", ".mkv", ".webm"].includes(videoExtension)) {
      throw new VideocutError(
        "invalid_argument",
        `Unsupported task video extension: ${videoExtension || "none"}`,
      );
    }
    const transcriptExtension = extname(transcriptPath).toLowerCase();
    if (transcriptExtension !== ".json" && transcriptExtension !== ".srt") {
      throw new VideocutError(
        "invalid_argument",
        "--transcript must be a task-local JSON or SRT file",
      );
    }
    try {
      const transcript = await loadTranscript(transcriptPath);
      if (transcript.cues.length === 0) throw new Error("transcript has no cues");
    } catch (error) {
      throw new VideocutError(
        "invalid_transcript",
        `Cannot create a project from ${options.transcript}`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    const canonicalVideo = join(jobDir, "input", `source${videoExtension}`);
    const canonicalTranscript = transcriptExtension === ".srt"
      ? join(jobDir, "剪口播", "1_转录", "subtitles.srt")
      : join(jobDir, "剪口播", "1_转录", "subtitles_words.json");
    const projectPath = join(jobDir, "project.json");
    const managedOutputs = [
      projectPath,
      join(jobDir, "transcript.json"),
      join(jobDir, "cut-selection.json"),
      join(jobDir, "edit-list.json"),
      join(jobDir, "index.html"),
      join(jobDir, "workbench.json"),
      join(jobDir, "events.jsonl"),
      join(jobDir, "剪口播", "3_审核", "natural_pause_plan.json"),
    ];
    for (const path of managedOutputs) {
      if (await directoryEntryIdentity(path)) {
        throw new VideocutError(
          "project_id_conflict",
          `project create refuses to overwrite an existing project artifact: ${path}`,
          { projectId, path },
        );
      }
    }
    for (const [source, target, name] of [
      [videoPath, canonicalVideo, "canonical video"],
      [transcriptPath, canonicalTranscript, "canonical transcript"],
    ] as const) {
      if (source !== target && await directoryEntryIdentity(target)) {
        throw new VideocutError(
          "project_id_conflict",
          `project create refuses to overwrite the existing ${name}: ${target}`,
          { projectId, path: target },
        );
      }
    }

    const now = (options.now ?? (() => new Date()))();
    const creationJournal: ProjectCreationJournal = {
      jobDir,
      files: new Map(),
      directories: new Map(),
    };
    try {
      if (videoPath !== canonicalVideo) {
        await atomicCopyNewFile(videoPath, canonicalVideo, creationJournal);
      }
      if (transcriptPath !== canonicalTranscript) {
        await atomicCopyNewFile(transcriptPath, canonicalTranscript, creationJournal);
      }
      await atomicCreateText(projectPath, jsonContent({
        schemaVersion: 1,
        jobId: projectId,
        title: projectId,
        status: "cut_review_ready",
        inputVideo: projectRelativePath(jobDir, canonicalVideo),
        config: { aspectRatio: options.aspectRatio },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }), creationJournal);
      const prepared = await prepareKouboProjectSnapshot(jobDir, {
        video: projectRelativePath(jobDir, canonicalVideo),
        transcript: projectRelativePath(jobDir, canonicalTranscript),
        now: () => now,
        beforeCommitFile: options.beforePrepareCommitFile,
      }, creationJournal);
      await options.finalize?.(prepared);
      return {
        ...prepared,
        canonicalVideo: projectRelativePath(jobDir, canonicalVideo),
        canonicalTranscript: projectRelativePath(jobDir, canonicalTranscript),
      };
    } catch (error) {
      try {
        await rollbackCreatedFiles(creationJournal);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Project creation failed and could not be completely rolled back",
        );
      }
      throw error;
    }
  });
}

export async function copyTaskVideo(input: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await copyFile(input, output);
  await stat(output);
}
