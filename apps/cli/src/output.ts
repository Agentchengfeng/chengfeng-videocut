import type { DoctorCheck } from "@video-workbench/core/node";
import type { StudioServiceCommandResult } from "./service";

export const CLI_SCHEMA_VERSION = 1;
export const PRODUCT_NAME = "chengfeng-videocut";
export const BRAND_NAME = PRODUCT_NAME;
export const PACKAGE_NAME = "chengfeng-videocut";
export const PRODUCT_VERSION = "0.4.7";

export interface SuccessEnvelope {
  schemaVersion: number;
  product: string;
  command: string;
  ok: true;
  data: unknown;
}

export interface ErrorEnvelope {
  schemaVersion: number;
  product: string;
  command: string;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function successEnvelope(command: string, data: unknown): SuccessEnvelope {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    command,
    ok: true,
    data,
  };
}

export function errorEnvelope(
  command: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    command,
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

export function humanDoctor(data: { healthy: boolean; checks: DoctorCheck[] }): string {
  const lines = data.checks.map(
    (check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`,
  );
  lines.push(data.healthy ? `${BRAND_NAME} is ready` : `${BRAND_NAME} needs attention`);
  return lines.join("\n");
}

export function humanService(data: StudioServiceCommandResult): string {
  if (data.action === "logs" && data.logs) {
    return [
      `Studio service: ${data.state}`,
      `stdout (${data.paths.stdoutLogPath}):`,
      data.logs.stdout || "(empty)",
      `stderr (${data.paths.stderrLogPath}):`,
      data.logs.stderr || "(empty)",
    ].join("\n");
  }
  const lines = [
    `Studio service: ${data.state}`,
    `URL: ${data.url}`,
    `Installed: ${data.installed ? "yes" : "no"}`,
    `Loaded: ${data.loaded ? "yes" : "no"}`,
    `Ready: ${data.ready ? "yes" : "no"}`,
  ];
  if (data.pid) lines.push(`PID: ${data.pid}`);
  if (data.detail) lines.push(`Detail: ${data.detail}`);
  return lines.join("\n");
}

export const HELP_TEXT = `chengfeng-videocut ${PRODUCT_VERSION}

Usage:
  chengfeng-videocut start [--host <host>] [--port <port>] [--projects-dir <dir>] [--data-dir <dir>] [--open] [--json]
  chengfeng-videocut service install [--json]
  chengfeng-videocut service start [--json]
  chengfeng-videocut service stop [--json]
  chengfeng-videocut service restart [--json]
  chengfeng-videocut service status [--json]
  chengfeng-videocut service logs [--lines <1-1000>] [--json]
  chengfeng-videocut service ensure [--open] [--json]
  chengfeng-videocut doctor [--json]
  chengfeng-videocut config get [--json]
  chengfeng-videocut config set <transcription.apiKey|transcription.resourceId|transcription.modelName> <value> [--json]
  chengfeng-videocut inspect <project> [--json]
  chengfeng-videocut open <project> [--origin <url>] [--json]
  chengfeng-videocut transcribe <job-dir> --video <task-local-path> --output <task-local-path> [--language <code>] [--json]
  chengfeng-videocut project create <job-dir> --video <task-local-path> --transcript <task-local-path> [--aspect-ratio <W:H>] [--projects-dir <dir>] [--json]
  chengfeng-videocut project prepare <job-dir> [--video <task-local-path>] [--transcript <task-local-path>] [--duration <seconds>] [--force-index] [--refresh-transcript] [--json]
  chengfeng-videocut artifact put <project> --type <subtitles|visual-plan|animation-manifest|timeline> --file <file> --expected-project-revision <sha256> --expected-artifact-revision <none|sha256> [--json]
  chengfeng-videocut workflow get <project> [--api-base <url>] [--json]
  chengfeng-videocut workflow transition <project> --action <start-final|confirm-storyboard|confirm-animation|confirm-timeline> --expected-revision <sha256> --confirmed [--file <config.json>] [--api-base <url>] [--json]
  chengfeng-videocut render run <project> --expected-revision <sha256> --confirmed [--renderer <absolute-file>] [--projects-dir <dir>] [--output-dir <dir>] [--json]
  chengfeng-videocut transcript playback <project> [--json]
  chengfeng-videocut transcript retranscribe <project> --output <file> [--language <code>] [--json]
  chengfeng-videocut transcript align <project> --script <file> [--json]
  chengfeng-videocut transcript dictionary <project> --dictionary <file> [--dry-run] [--json]
  chengfeng-videocut transcript correct <project> --file <corrections.json> [--dry-run] [--json]
  chengfeng-videocut cuts get <project> [--api-base <url>] [--json]
  chengfeng-videocut cuts set <project> --file <file> --expected-revision <none|sha256> [--full-selection] [--api-base <url>] [--json]
  chengfeng-videocut cuts set <project> --file <file> --dry-run [--json]
  chengfeng-videocut cuts apply <project> --expected-revision <sha256> --expected-edit-list-revision <sha256> --confirmed [--api-base <url>] [--json]
  chengfeng-videocut subtitle get <project> [--json]
  chengfeng-videocut subtitle build <project> [--replace] [--max-columns <n>] [--break-pause <seconds>] [--dry-run] [--json]
  chengfeng-videocut subtitle set <project> --file <subtitles.json> [--expected-revision <sha256>] [--dry-run] [--json]
  chengfeng-videocut visual get <project> [--json]
  chengfeng-videocut visual add <project> --module <project-relative .html> --cues <id,id,...> [--id <layer>] [--expected-revision <sha256>] [--dry-run] [--json]
  chengfeng-videocut visual remove <project> --id <layer> [--expected-revision <sha256>] [--dry-run] [--json]
  chengfeng-videocut export <project> [--out <file.mp4>] [--scale <n>] [--fps <n>] [--keep-work] [--dry-run] [--json]

service ensure is the product entry point: it atomically installs or recovers the managed user service (launchd on macOS, Task Scheduler on Windows) and waits for a matching ready Runtime.
service stop disables and unloads the managed user service; service start re-enables it. Service commands fail closed on unsupported platforms and never kill an unknown process occupying port 5190.
start serves the Studio in the foreground on 127.0.0.1:5190 by default. It remains available for development diagnostics and does not open a browser unless --open is provided.
config stores machine-wide settings in ~/.chengfeng-videocut/config.json at mode 0600, and prints secrets masked. An environment variable of the same name always wins, so one command can be overridden without editing anything. The cloud transcription credential was previously an environment variable and nothing else: required by the product, assumed by the Skills, mentioned in no contract and checked by no command — a shell without it failed at the moment of the call.
Project may be an absolute directory or an id registered in the Workbench.
cuts set writes through the running product API; --dry-run performs a local read-only calculation.
transcript correct fixes what the transcript says without touching when it says it: word ids, word count and every timestamp must come out identical, or the write is refused. A mis-heard proper noun is not surplus speech, so cutting cannot repair it.
transcript playback flattens the transcript into what the audience hears, in that order, with removed speech marked. Judging repetition depends on heard adjacency, so this is the only correct input for a semantic pass — assembling it by hand gets it wrong silently.
transcript retranscribe transcribes the cut itself, without exporting it first: it concatenates only the kept ranges' audio and sends that. The times that come back are already on the cut timeline, because the audio that went in is the cut — nothing maps between timelines. This is what subtitles need.
export burns the whole film: the cut, the push-ins, the subtitles and the HTML layers, in one file. Everything before it is annotation and nothing else in the product writes a picture. The overlay is drawn by the same browser engine, from the same CSS and the same modules the preview uses, one frame at a time — so the file is the preview rather than an agreement with it. --scale defaults to 2: the footage gains no detail from an upscale, but the subtitles and modules are redrawn at the output size and those are the parts a viewer reads. --dry-run prints the plan (length, frame count, screens, layers, push-ins) without encoding anything.
visual add places an HTML layer over the footage for the span of the subtitle screens named by --cues. The layer stores those screens' word ids, never seconds, so it moves with the cut instead of drifting off it. The module is a project-relative .html that must already exist; the preview drives it by seeking, so it must render a deterministic frame for any instant rather than playing on its own clock.

transcript dictionary applies the operator's own spellings and reports every one it changed with its context. Unlike align it needs no evidence: within one speaker's work a name is spelled one way, and a rule is that statement. Screens showing a renamed word are rewritten in the same operation, because subtitles keep their own text and the staleness check cannot see a respelling.
transcript align proposes spellings from the script the speaker wrote, by finding each term's neighbours in both texts. It corrects only what the context singles out and reports the rest as undecided — transcription mishears proper nouns in ways no dictionary derives from the audio, and a wrong name is worse than a misheard one.
subtitle cues store word ids, never seconds: the cut owns when, the subtitle owns what is written. Timing and staleness are therefore recomputed on every read and never stored, and every subtitle command reports stale as the exact list of broken screens — the product may not say "subtitles may be out of date".
subtitle build writes a first draft split at deleted speech, at heard pauses, and at the column limit. It refuses to overwrite an existing document without --replace, because splitting and wording are the part a person spent their time on.
cuts set reads the result back and reports any previously-cut words it let go of.
cuts set submits a semantic overlay by default: the natural-pause baseline is merged back in on every write, so a proposal can only add deletions — the right guard for a Skill, and exactly what makes releasing a pause impossible. --full-selection switches to the Studio's own checkbox semantics: what is submitted is all there is, including which pauses stay. Use it when the person wants pauses kept (e.g. short breaths under 0.3s).
cuts get returns the independent cut-selection revision required by cuts set.
cutRanges are derived from transcript.json + cutWordIds; supplied cutRanges are ignored.
cuts apply requires the exact edit-list revision returned to the user at confirmation time; it never substitutes the current latest revision.
project create atomically establishes a new project from real task-local video and transcript files, then prepares and registers it. It never overwrites an existing project or injects demo media.
transcribe extracts task-local source audio, calls the configured Volcengine ASR service, and atomically writes a new task-local word transcript. It requires VOLCENGINE_API_KEY and never creates a project.
project prepare refreshes an existing canonical project; it does not create project.json.
render run executes locally and requires --renderer or CHENGFENG_VIDEOCUT_RENDERER_PATH.
Render exit codes: 7 missing renderer, 8 renderer failed, 9 verification failed.`;
