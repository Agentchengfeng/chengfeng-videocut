import type { DoctorCheck } from "@video-workbench/core/node";
import type { StudioServiceCommandResult } from "./service";

export const CLI_SCHEMA_VERSION = 1;
export const PRODUCT_NAME = "chengfeng-videocut";
export const BRAND_NAME = PRODUCT_NAME;
export const PACKAGE_NAME = "chengfeng-videocut";
export const PRODUCT_VERSION = "0.2.0";

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
  chengfeng-videocut inspect <project> [--json]
  chengfeng-videocut open <project> [--origin <url>] [--json]
  chengfeng-videocut transcribe <job-dir> --video <task-local-path> --output <task-local-path> [--language <code>] [--json]
  chengfeng-videocut project create <job-dir> --video <task-local-path> --transcript <task-local-path> --aspect-ratio <3:4|4:3|16:9> [--projects-dir <dir>] [--json]
  chengfeng-videocut project prepare <job-dir> [--video <task-local-path>] [--transcript <task-local-path>] [--duration <seconds>] [--force-index] [--refresh-transcript] [--json]
  chengfeng-videocut artifact put <project> --type <subtitles|visual-plan|animation-manifest|timeline> --file <file> --expected-project-revision <sha256> --expected-artifact-revision <none|sha256> [--json]
  chengfeng-videocut workflow get <project> [--api-base <url>] [--json]
  chengfeng-videocut workflow transition <project> --action <start-final|confirm-storyboard|confirm-animation|confirm-timeline> --expected-revision <sha256> --confirmed [--file <config.json>] [--api-base <url>] [--json]
  chengfeng-videocut render run <project> --expected-revision <sha256> --confirmed [--renderer <absolute-file>] [--projects-dir <dir>] [--output-dir <dir>] [--json]
  chengfeng-videocut cuts get <project> [--api-base <url>] [--json]
  chengfeng-videocut cuts set <project> --file <file> --expected-revision <none|sha256> [--api-base <url>] [--json]
  chengfeng-videocut cuts set <project> --file <file> --dry-run [--json]
  chengfeng-videocut cuts apply <project> --expected-revision <sha256> --expected-edit-list-revision <sha256> --confirmed [--api-base <url>] [--json]

service ensure is the product entry point: it atomically installs or recovers the macOS user LaunchAgent and waits for a matching ready Runtime.
service stop disables and boots out the LaunchAgent; service start re-enables it. Service commands fail closed on non-macOS systems and never kill an unknown process occupying port 5190.
start serves the Studio in the foreground on 127.0.0.1:5190 by default. It remains available for development diagnostics and does not open a browser unless --open is provided.
Project may be an absolute directory or an id registered in the Workbench.
cuts set writes through the running product API; --dry-run performs a local read-only calculation.
cuts get returns the independent cut-selection revision required by cuts set.
cutRanges are derived from transcript.json + cutWordIds; supplied cutRanges are ignored.
cuts apply requires the exact edit-list revision returned to the user at confirmation time; it never substitutes the current latest revision.
project create atomically establishes a new project from real task-local video and transcript files, then prepares and registers it. It never overwrites an existing project or injects demo media.
transcribe extracts task-local source audio, calls the configured Volcengine ASR service, and atomically writes a new task-local word transcript. It requires VOLCENGINE_API_KEY and never creates a project.
project prepare refreshes an existing canonical project; it does not create project.json.
render run executes locally and requires --renderer or CHENGFENG_VIDEOCUT_RENDERER_PATH.
Render exit codes: 7 missing renderer, 8 renderer failed, 9 verification failed.`;
