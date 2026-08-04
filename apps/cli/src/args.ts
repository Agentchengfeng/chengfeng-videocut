import { isAbsolute } from "node:path";
import { VideocutError } from "@video-workbench/core";

export type CliCommand =
  | "help"
  | "version"
  | "start"
  | "service.install"
  | "service.start"
  | "service.stop"
  | "service.restart"
  | "service.status"
  | "service.logs"
  | "service.ensure"
  | "service.supervise"
  | "doctor"
  | "config.get"
  | "config.set"
  | "inspect"
  | "open"
  | "transcribe"
  | "project.create"
  | "project.prepare"
  | "artifact.put"
  | "cuts.get"
  | "transcript.playback"
  | "transcript.retranscribe"
  | "transcript.align"
  | "transcript.dictionary"
  | "transcript.regroup"
  | "transcript.correct"
  | "cuts.set"
  | "cuts.apply"
  | "editList.get"
  | "editList.patch"
  | "subtitle.get"
  | "subtitle.build"
  | "subtitle.set"
  | "visual.get"
  | "visual.add"
  | "visual.remove"
  | "visual.frame"
  | "workflow.get"
  | "workflow.transition"
  | "render.run"
  | "export";

export interface ParsedArgs {
  command: CliCommand;
  project?: string;
  file?: string;
  json: boolean;
  dryRun: boolean;
  origin?: string;
  expectedRevision?: string;
  expectedEditListRevision?: string;
  projectsDir?: string;
  outputDir?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  openBrowser: boolean;
  apiBase?: string;
  video?: string;
  transcript?: string;
  output?: string;
  language?: string;
  aspectRatio?: "3:4" | "4:3" | "16:9";
  duration?: number;
  confirmed: boolean;
  forceIndex: boolean;
  refreshTranscript: boolean;
  artifactType?: string;
  expectedProjectRevision?: string;
  expectedArtifactRevision?: string;
  action?: string;
  renderer?: string;
  logLines?: number;
  replace: boolean;
  maxColumns?: number;
  breakPauseSeconds?: number;
  modulePath?: string;
  /** Subtitle screens a visual layer covers. The layer binds their words. */
  cueIds?: string[];
  layerId?: string;
  frameCount?: number;
  outDir?: string;
  /** Where the finished film goes. `export --out`, a file rather than a folder. */
  outFile?: string;
  zoom?: { x: number; y: number; width: number; height: number };
  /** Output size as a multiple of the source. Defaults to 2. */
  scale?: number;
  /** Output frame rate. Defaults to the source's. */
  fps?: number;
  /** Keep the intermediate video and the overlay PNGs for inspection. */
  keepWork: boolean;
  /**
   * `cuts set`: submit the checkbox truth instead of a semantic overlay.
   *
   * The overlay mode always merges the natural-pause baseline back in, which
   * is the right guard for a Skill proposing deletions — and exactly what
   * makes releasing a pause impossible. Full-selection is the Studio's own
   * write semantics: what is submitted is all there is.
   */
  fullSelection: boolean;
}

const VALUE_OPTIONS = new Set([
  "--file",
  "--origin",
  "--expected-revision",
  "--expected-edit-list-revision",
  "--projects-dir",
  "--output-dir",
  "--data-dir",
  "--host",
  "--port",
  "--api-base",
  "--video",
  "--transcript",
  "--output",
  "--language",
  "--aspect-ratio",
  "--duration",
  "--type",
  "--expected-project-revision",
  "--expected-artifact-revision",
  "--action",
  "--renderer",
  "--lines",
  "--script",
  "--dictionary",
  "--max-columns",
  "--break-pause",
  "--module",
  "--cues",
  "--id",
  "--count",
  "--out",
  "--zoom",
  "--scale",
  "--fps",
]);

const BOOLEAN_OPTIONS = new Set([
  "--confirmed",
  "--force-index",
  "--refresh-transcript",
  "--replace",
  "--keep-work",
  "--full-selection",
]);

function usageError(message: string): never {
  throw new VideocutError("invalid_argument", message);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let dryRun = false;
  let help = false;
  let version = false;
  let openBrowser = false;
  const booleanValues = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalsIndex = token.indexOf("=");
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
    if (name === "--json") {
      if (inlineValue !== undefined) usageError("--json does not accept a value");
      json = true;
      continue;
    }
    if (name === "--dry-run") {
      if (inlineValue !== undefined) usageError("--dry-run does not accept a value");
      dryRun = true;
      continue;
    }
    if (name === "--help") {
      if (inlineValue !== undefined) usageError("--help does not accept a value");
      help = true;
      continue;
    }
    if (name === "--version") {
      if (inlineValue !== undefined) usageError("--version does not accept a value");
      version = true;
      continue;
    }
    if (name === "--open") {
      if (inlineValue !== undefined) usageError("--open does not accept a value");
      openBrowser = true;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined) usageError(`${name} does not accept a value`);
      if (booleanValues.has(name)) usageError(`${name} may only be provided once`);
      booleanValues.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) usageError(`Unknown option: ${name}`);
    const value = inlineValue ?? argv[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith("--"))) {
      usageError(`${name} requires a value`);
    }
    if (values.has(name)) usageError(`${name} may only be provided once`);
    values.set(name, value);
    if (inlineValue === undefined) index += 1;
  }

  const durationValue = values.get("--duration");
  let duration: number | undefined;
  if (durationValue !== undefined) {
    duration = Number(durationValue);
    if (!Number.isFinite(duration) || duration <= 0) {
      usageError("--duration must be a positive number of seconds");
    }
  }

  const portValue = values.get("--port");
  let port: number | undefined;
  if (portValue !== undefined) {
    if (!/^\d+$/.test(portValue)) usageError("--port must be an integer from 0 to 65535");
    port = Number(portValue);
    if (!Number.isSafeInteger(port) || port > 65_535) {
      usageError("--port must be an integer from 0 to 65535");
    }
  }

  const linesValue = values.get("--lines");
  let logLines: number | undefined;
  if (linesValue !== undefined) {
    if (!/^\d+$/.test(linesValue)) usageError("--lines must be an integer from 1 to 1000");
    logLines = Number(linesValue);
    if (!Number.isSafeInteger(logLines) || logLines < 1 || logLines > 1_000) {
      usageError("--lines must be an integer from 1 to 1000");
    }
  }

  const columnsValue = values.get("--max-columns");
  let maxColumns: number | undefined;
  if (columnsValue !== undefined) {
    maxColumns = Number(columnsValue);
    if (!Number.isFinite(maxColumns) || maxColumns < 2 || maxColumns > 80) {
      usageError("--max-columns must be a number from 2 to 80");
    }
  }

  const breakPauseValue = values.get("--break-pause");
  let breakPauseSeconds: number | undefined;
  if (breakPauseValue !== undefined) {
    breakPauseSeconds = Number(breakPauseValue);
    if (!Number.isFinite(breakPauseSeconds) || breakPauseSeconds < 0 || breakPauseSeconds > 5) {
      usageError("--break-pause must be a number of seconds from 0 to 5");
    }
  }

  const common = {
    json,
    dryRun,
    origin: values.get("--origin"),
    expectedRevision: values.get("--expected-revision"),
    expectedEditListRevision: values.get("--expected-edit-list-revision"),
    projectsDir: values.get("--projects-dir"),
    outputDir: values.get("--output-dir"),
    dataDir: values.get("--data-dir"),
    host: values.get("--host"),
    port,
    openBrowser,
    apiBase: values.get("--api-base"),
    video: values.get("--video"),
    transcript: values.get("--transcript"),
    output: values.get("--output"),
    language: values.get("--language"),
    aspectRatio: values.get("--aspect-ratio") as ParsedArgs["aspectRatio"],
    duration,
    confirmed: booleanValues.has("--confirmed"),
    forceIndex: booleanValues.has("--force-index"),
    refreshTranscript: booleanValues.has("--refresh-transcript"),
    artifactType: values.get("--type"),
    expectedProjectRevision: values.get("--expected-project-revision"),
    expectedArtifactRevision: values.get("--expected-artifact-revision"),
    action: values.get("--action"),
    renderer: values.get("--renderer"),
    logLines,
    replace: booleanValues.has("--replace"),
    keepWork: booleanValues.has("--keep-work"),
    fullSelection: booleanValues.has("--full-selection"),
  };
  if (version) return { command: "version", ...common };
  if (help || positionals.length === 0) return { command: "help", ...common };

  const assertOptions = (
    allowed: readonly string[],
    allowedBoolean: readonly string[] = [],
    allowDryRun = false,
  ): void => {
    for (const name of values.keys()) {
      if (!allowed.includes(name)) usageError(`${name} is not valid for this command`);
    }
    for (const name of booleanValues) {
      if (!allowedBoolean.includes(name)) usageError(`${name} is not valid for this command`);
    }
    if (dryRun && !allowDryRun) usageError("--dry-run is not valid for this command");
    if (openBrowser && !(
      positionals[0] === "start" ||
      (positionals[0] === "service" && positionals[1] === "ensure")
    )) {
      usageError("--open is only valid for start or service ensure");
    }
  };

  if (positionals[0] === "start") {
    if (positionals.length !== 1) {
      usageError("Usage: chengfeng-videocut start [--host <host>] [--port <port>]");
    }
    assertOptions(["--host", "--port", "--projects-dir", "--data-dir"]);
    return { command: "start", ...common };
  }

  if (positionals[0] === "service") {
    const action = positionals[1];
    if (positionals.length !== 2 || ![
      "install", "start", "stop", "restart", "status", "logs", "ensure", "supervise",
    ].includes(action ?? "")) {
      usageError(
        "Usage: chengfeng-videocut service <install|start|stop|restart|status|logs|ensure>",
      );
    }
    if (action === "logs") assertOptions(["--lines"]);
    else assertOptions([]);
    return { command: `service.${action}` as CliCommand, ...common };
  }

  if (positionals[0] === "doctor") {
    if (positionals.length !== 1) usageError("Usage: chengfeng-videocut doctor [--json]");
    assertOptions(["--projects-dir"]);
    return { command: "doctor", ...common };
  }
  if (positionals[0] === "inspect") {
    if (positionals.length !== 2) {
      usageError("Usage: chengfeng-videocut inspect <project> [--json]");
    }
    assertOptions(["--projects-dir", "--output-dir"]);
    return { command: "inspect", project: positionals[1], ...common };
  }
  if (positionals[0] === "open") {
    if (positionals.length !== 2) {
      usageError("Usage: chengfeng-videocut open <project> [--origin <url>] [--json]");
    }
    assertOptions(["--origin", "--projects-dir", "--output-dir"]);
    return { command: "open", project: positionals[1], ...common };
  }
  if (positionals[0] === "transcribe") {
    if (positionals.length !== 2) {
      usageError(
        "Usage: chengfeng-videocut transcribe <job-dir> --video <task-local-path> --output <task-local-path>",
      );
    }
    const video = values.get("--video");
    const output = values.get("--output");
    if (!video) usageError("transcribe requires --video <task-local-path>");
    if (!output) usageError("transcribe requires --output <task-local-path>");
    assertOptions(["--video", "--output", "--language"]);
    return { command: "transcribe", project: positionals[1], ...common };
  }
  if (positionals[0] === "project" && positionals[1] === "create") {
    if (positionals.length !== 3) {
      usageError(
        "Usage: chengfeng-videocut project create <job-dir> --video <task-local-path> --transcript <task-local-path> --aspect-ratio <3:4|4:3|16:9>",
      );
    }
    const video = values.get("--video");
    const transcript = values.get("--transcript");
    const aspectRatio = values.get("--aspect-ratio");
    if (!video) usageError("project create requires --video <task-local-path>");
    if (!transcript) usageError("project create requires --transcript <task-local-path>");
    if (aspectRatio !== "3:4" && aspectRatio !== "4:3" && aspectRatio !== "16:9") {
      usageError("project create --aspect-ratio must be 3:4, 4:3, or 16:9");
    }
    assertOptions(["--video", "--transcript", "--aspect-ratio", "--projects-dir"]);
    return {
      command: "project.create",
      project: positionals[2],
      ...common,
    };
  }
  if (positionals[0] === "project" && positionals[1] === "prepare") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut project prepare <job-dir>");
    }
    assertOptions(
      ["--video", "--transcript", "--duration", "--origin", "--projects-dir"],
      ["--force-index", "--refresh-transcript"],
    );
    return { command: "project.prepare", project: positionals[2], ...common };
  }
  if (positionals[0] === "artifact" && positionals[1] === "put") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut artifact put <project> --type <type> --file <file>");
    }
    const artifactType = values.get("--type");
    if (!artifactType || ![
      "subtitles", "visual-plan", "animation-manifest", "timeline",
    ].includes(artifactType)) {
      usageError("artifact put --type must be subtitles, visual-plan, animation-manifest, or timeline");
    }
    const file = values.get("--file");
    if (!file) usageError("artifact put requires --file <file>");
    const expectedProjectRevision = values.get("--expected-project-revision");
    const expectedArtifactRevision = values.get("--expected-artifact-revision");
    for (const [name, value] of [
      ["--expected-project-revision", expectedProjectRevision],
      ["--expected-artifact-revision", expectedArtifactRevision],
    ] as const) {
      if (!value || !/^(?:none|[a-f0-9]{64})$/.test(value)) {
        usageError(`${name} is required and must be 'none' or a SHA-256 revision`);
      }
    }
    assertOptions([
      "--type", "--file", "--expected-project-revision", "--expected-artifact-revision",
      "--projects-dir", "--output-dir",
    ]);
    return { command: "artifact.put", project: positionals[2], file, ...common };
  }
  if (positionals[0] === "workflow" && positionals[1] === "get") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut workflow get <project>");
    }
    assertOptions(["--projects-dir", "--output-dir", "--api-base"]);
    return { command: "workflow.get", project: positionals[2], ...common };
  }
  if (positionals[0] === "workflow" && positionals[1] === "transition") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut workflow transition <project> --action <action>");
    }
    const action = values.get("--action");
    if (!action || ![
      "start-final", "confirm-storyboard", "confirm-animation", "confirm-timeline",
    ].includes(action)) {
      usageError("workflow transition --action is invalid");
    }
    const expectedRevision = values.get("--expected-revision");
    if (!expectedRevision || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      usageError("workflow transition requires --expected-revision <sha256>");
    }
    if (!booleanValues.has("--confirmed")) {
      usageError("workflow transition requires --confirmed after explicit user confirmation");
    }
    assertOptions(
      ["--action", "--expected-revision", "--file", "--projects-dir", "--output-dir", "--api-base"],
      ["--confirmed"],
    );
    return {
      command: "workflow.transition",
      project: positionals[2],
      file: values.get("--file"),
      ...common,
    };
  }
  if (positionals[0] === "render" && positionals[1] === "run") {
    if (positionals.length !== 3) {
      usageError(
        "Usage: chengfeng-videocut render run <project> --expected-revision <sha256> --confirmed",
      );
    }
    const expectedRevision = values.get("--expected-revision");
    if (!expectedRevision || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      usageError("render run requires --expected-revision <sha256>");
    }
    if (!booleanValues.has("--confirmed")) {
      usageError("render run requires --confirmed after explicit user confirmation");
    }
    const renderer = values.get("--renderer");
    if (renderer && !isAbsolute(renderer)) {
      usageError("render run --renderer must be an absolute file path");
    }
    assertOptions(
      ["--expected-revision", "--renderer", "--projects-dir", "--output-dir"],
      ["--confirmed"],
    );
    return { command: "render.run", project: positionals[2], ...common };
  }
  if (positionals[0] === "cuts" && positionals[1] === "apply") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut cuts apply <project> --expected-revision <sha256> --expected-edit-list-revision <sha256> --confirmed");
    }
    const expectedRevision = values.get("--expected-revision");
    if (!expectedRevision || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      usageError("cuts apply requires --expected-revision <sha256>");
    }
    const expectedEditListRevision = values.get("--expected-edit-list-revision");
    if (!expectedEditListRevision) {
      throw new VideocutError(
        "revision_required",
        "cuts apply requires --expected-edit-list-revision <sha256> from explicit user confirmation",
        { reason: "missing_confirmed_edit_list_revision" },
      );
    }
    if (expectedEditListRevision === "none") {
      throw new VideocutError(
        "revision_required",
        "cuts apply requires a prepared edit-list.json revision",
        { reason: "edit_list_required" },
      );
    }
    if (!/^[a-f0-9]{64}$/.test(expectedEditListRevision)) {
      usageError("--expected-edit-list-revision must be a SHA-256 revision");
    }
    if (!booleanValues.has("--confirmed")) {
      usageError("cuts apply requires --confirmed after explicit user confirmation");
    }
    assertOptions(
      [
        "--expected-revision",
        "--expected-edit-list-revision",
        "--projects-dir",
        "--output-dir",
        "--api-base",
      ],
      ["--confirmed"],
    );
    return { command: "cuts.apply", project: positionals[2], ...common };
  }
  if (positionals[0] === "transcript" && positionals[1] === "correct") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut transcript correct <project> --file <corrections.json>");
    }
    assertOptions(["--file", "--projects-dir", "--output-dir"], [], true);
    const correctionsFile = values.get("--file");
    if (!correctionsFile) {
      usageError("transcript correct requires --file <corrections.json>");
    }
    return {
      command: "transcript.correct",
      project: positionals[2],
      file: correctionsFile,
      ...common,
    };
  }
  if (positionals[0] === "config" && positionals[1] === "get") {
    if (positionals.length !== 2) usageError("Usage: chengfeng-videocut config get [--json]");
    assertOptions([]);
    return { ...common, command: "config.get" };
  }
  if (positionals[0] === "config" && positionals[1] === "set") {
    if (positionals.length !== 4) {
      usageError("Usage: chengfeng-videocut config set <transcription.apiKey|transcription.resourceId|transcription.modelName> <value>");
    }
    assertOptions([]);
    return { ...common, command: "config.set", file: positionals[2], output: positionals[3] };
  }
  if (positionals[0] === "transcript" && positionals[1] === "regroup") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut transcript regroup <project> [--dry-run]");
    }
    assertOptions(["--projects-dir", "--output-dir"], [], true);
    return { ...common, command: "transcript.regroup", project: positionals[2] };
  }
  if (positionals[0] === "transcript" && positionals[1] === "dictionary") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut transcript dictionary <project> --dictionary <file>");
    }
    assertOptions(["--dictionary", "--projects-dir", "--output-dir"], [], true);
    const dictionary = values.get("--dictionary");
    if (!dictionary) usageError("transcript dictionary requires --dictionary <file>");
    return {
      ...common,
      command: "transcript.dictionary",
      project: positionals[2],
      file: dictionary,
    };
  }
  if (positionals[0] === "transcript" && positionals[1] === "align") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut transcript align <project> --script <file>");
    }
    assertOptions(["--script", "--projects-dir", "--output-dir"], [], true);
    const script = values.get("--script");
    if (!script) usageError("transcript align requires --script <file>");
    return { ...common, command: "transcript.align", project: positionals[2], file: script };
  }
  if (positionals[0] === "transcript" && positionals[1] === "retranscribe") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut transcript retranscribe <project> --output <file>");
    }
    assertOptions(["--output", "--language", "--projects-dir", "--output-dir"], [], true);
    const output = values.get("--output");
    if (!output) usageError("transcript retranscribe requires --output <file>");
    return {
      ...common,
      command: "transcript.retranscribe",
      project: positionals[2],
      output,
      language: values.get("--language"),
    };
  }
  if (positionals[0] === "subtitle" && positionals[1] === "get") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut subtitle get <project>");
    }
    assertOptions(["--projects-dir", "--output-dir"]);
    return { ...common, command: "subtitle.get", project: positionals[2] };
  }
  if (positionals[0] === "subtitle" && positionals[1] === "build") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut subtitle build <project> [--replace]");
    }
    assertOptions(
      ["--max-columns", "--break-pause", "--projects-dir", "--output-dir"],
      ["--replace"],
      true,
    );
    return {
      ...common,
      command: "subtitle.build",
      project: positionals[2],
      maxColumns,
      breakPauseSeconds,
    };
  }
  if (positionals[0] === "subtitle" && positionals[1] === "set") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut subtitle set <project> --file <subtitles.json>");
    }
    const file = values.get("--file");
    if (!file) usageError("subtitle set requires --file <subtitles.json>");
    assertOptions(
      ["--file", "--expected-revision", "--projects-dir", "--output-dir"],
      [],
      true,
    );
    return { ...common, command: "subtitle.set", project: positionals[2], file };
  }
  if (positionals[0] === "export") {
    if (positionals.length !== 2) {
      usageError(
        "Usage: chengfeng-videocut export <project> [--out <file.mp4>] [--scale 2] [--fps 60] [--keep-work]",
      );
    }
    assertOptions(
      ["--out", "--scale", "--fps", "--projects-dir", "--output-dir"],
      ["--keep-work"],
      true,
    );
    const rawScale = values.get("--scale");
    const scale = rawScale === undefined ? undefined : Number(rawScale);
    if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0 || scale > 4)) {
      usageError("--scale must be a number between 0 and 4 (1 = the source's own size)");
    }
    const rawFps = values.get("--fps");
    const fps = rawFps === undefined ? undefined : Number(rawFps);
    if (fps !== undefined && (!Number.isFinite(fps) || fps < 1 || fps > 120)) {
      usageError("--fps must be a frame rate between 1 and 120");
    }
    return {
      ...common,
      command: "export",
      project: positionals[1],
      outFile: values.get("--out"),
      scale,
      fps,
    };
  }
  if (positionals[0] === "visual" && positionals[1] === "get") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut visual get <project>");
    }
    assertOptions(["--projects-dir", "--output-dir"]);
    return { ...common, command: "visual.get", project: positionals[2] };
  }
  if (positionals[0] === "visual" && positionals[1] === "add") {
    if (positionals.length !== 3) {
      usageError(
        "Usage: chengfeng-videocut visual add <project> --module <path> --cues <id,id> [--id <layer>]",
      );
    }
    const modulePath = values.get("--module");
    if (!modulePath) usageError("visual add requires --module <project-relative .html>");
    const cues = values.get("--cues");
    if (!cues) {
      usageError("visual add requires --cues <subtitle cue ids>, so the layer is bound to speech");
    }
    assertOptions(
      ["--module", "--cues", "--id", "--zoom", "--expected-revision", "--projects-dir", "--output-dir"],
      [],
      true,
    );
    const rawZoom = values.get("--zoom");
    let zoom: { x: number; y: number; width: number; height: number } | undefined;
    if (rawZoom !== undefined) {
      const parts = rawZoom.split(",").map((part) => Number(part.trim()));
      if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
        usageError("--zoom must be x,y,width,height as frame percentages, e.g. 10,58,42,22");
      }
      zoom = { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
    }
    return {
      ...common,
      command: "visual.add",
      project: positionals[2],
      modulePath,
      cueIds: cues.split(",").map((part) => part.trim()).filter(Boolean),
      layerId: values.get("--id"),
      zoom,
    };
  }
  if (positionals[0] === "visual" && positionals[1] === "frame") {
    if (positionals.length !== 3) {
      usageError(
        "Usage: chengfeng-videocut visual frame <project> --cues <id,id> [--count <n>] [--out <dir>]",
      );
    }
    const cues = values.get("--cues");
    if (!cues) usageError("visual frame requires --cues <subtitle cue ids>");
    assertOptions(["--cues", "--count", "--out", "--projects-dir", "--output-dir"], [], true);
    const rawCount = values.get("--count");
    const count = rawCount === undefined ? 3 : Number(rawCount);
    if (!Number.isInteger(count) || count < 1 || count > 12) {
      usageError("--count must be an integer between 1 and 12");
    }
    return {
      ...common,
      command: "visual.frame",
      project: positionals[2],
      cueIds: cues.split(",").map((part) => part.trim()).filter(Boolean),
      frameCount: count,
      outDir: values.get("--out"),
    };
  }
  if (positionals[0] === "visual" && positionals[1] === "remove") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut visual remove <project> --id <layer>");
    }
    const layerId = values.get("--id");
    if (!layerId) usageError("visual remove requires --id <layer>");
    assertOptions(["--id", "--expected-revision", "--projects-dir", "--output-dir"], [], true);
    return { ...common, command: "visual.remove", project: positionals[2], layerId };
  }
  if (positionals[0] === "transcript" && positionals[1] === "playback") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut transcript playback <project>");
    }
    assertOptions(["--projects-dir", "--output-dir"]);
    return { command: "transcript.playback", project: positionals[2], ...common };
  }
  if (positionals[0] === "cuts" && positionals[1] === "get") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut cuts get <project>");
    }
    assertOptions(["--projects-dir", "--output-dir", "--api-base"]);
    return { command: "cuts.get", project: positionals[2], ...common };
  }
  if (positionals[0] === "cuts" && positionals[1] === "set") {
    if (positionals.length !== 3) {
      usageError(
        "Usage: chengfeng-videocut cuts set <project> --file <cut-selection.json>",
      );
    }
    const file = values.get("--file");
    if (!file) usageError("cuts set requires --file <cut-selection.json>");
    const expectedRevision = values.get("--expected-revision");
    if (!dryRun && !expectedRevision) {
      usageError("cuts set requires --expected-revision <revision> unless --dry-run is used");
    }
    if (expectedRevision && !/^(?:none|[a-f0-9]{64})$/.test(expectedRevision)) {
      usageError("--expected-revision must be 'none' or a SHA-256 revision");
    }
    assertOptions(
      [
        "--file",
        "--expected-revision",
        "--projects-dir",
        "--output-dir",
        "--api-base",
      ],
      ["--full-selection"],
      true,
    );
    return {
      command: "cuts.set",
      project: positionals[2],
      file,
      ...common,
    };
  }
  if (positionals[0] === "edit-list" && positionals[1] === "get") {
    if (positionals.length !== 3) {
      usageError("Usage: chengfeng-videocut edit-list get <project>");
    }
    assertOptions(["--projects-dir", "--output-dir", "--api-base"]);
    return { command: "editList.get", project: positionals[2], ...common };
  }
  if (positionals[0] === "edit-list" && positionals[1] === "patch") {
    if (positionals.length !== 3) {
      usageError(
        "Usage: chengfeng-videocut edit-list patch <project> --file <operation.json> --expected-revision <sha256>",
      );
    }
    const file = values.get("--file");
    if (!file) {
      usageError("edit-list patch requires --file <operation.json>");
    }
    const expectedRevision = values.get("--expected-revision");
    // Unlike cuts set there is no dry-run branch here: the whole point of this
    // command is to exercise the same guarded path the editor uses, and a
    // dry-run that skipped the edit-list guards is what previously produced a
    // green light followed by a 409.
    if (!expectedRevision) {
      usageError("edit-list patch requires --expected-revision <sha256> from a prior edit-list get");
    }
    if (!/^(?:none|[a-f0-9]{64})$/.test(expectedRevision)) {
      usageError("--expected-revision must be 'none' or a SHA-256 revision");
    }
    assertOptions(
      ["--file", "--expected-revision", "--projects-dir", "--output-dir", "--api-base"],
      [],
      true,
    );
    return {
      command: "editList.patch",
      project: positionals[2],
      file,
      ...common,
    };
  }
  usageError(`Unknown command: ${positionals.join(" ")}`);
}
