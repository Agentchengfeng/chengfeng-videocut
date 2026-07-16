import type { DoctorCheck } from "@video-workbench/core/node";

export const CLI_SCHEMA_VERSION = 1;
export const PRODUCT_NAME = "chengfeng-videocut";
export const BRAND_NAME = PRODUCT_NAME;
export const PACKAGE_NAME = "chengfeng-videocut";
export const PRODUCT_VERSION = "0.1.1";

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

export const HELP_TEXT = `chengfeng-videocut 0.1.1

Usage:
  chengfeng-videocut start [--host <host>] [--port <port>] [--projects-dir <dir>] [--data-dir <dir>] [--open] [--json]
  chengfeng-videocut doctor [--json]
  chengfeng-videocut inspect <project> [--json]
  chengfeng-videocut open <project> [--origin <url>] [--json]
  chengfeng-videocut project prepare <job-dir> [--video <task-local-path>] [--transcript <task-local-path>] [--duration <seconds>] [--force-index] [--refresh-transcript] [--json]
  chengfeng-videocut artifact put <project> --type <subtitles|visual-plan|animation-manifest|timeline> --file <file> --expected-project-revision <sha256> --expected-artifact-revision <none|sha256> [--json]
  chengfeng-videocut workflow get <project> [--api-base <url>] [--json]
  chengfeng-videocut workflow transition <project> --action <start-final|confirm-storyboard|confirm-animation|confirm-timeline> --expected-revision <sha256> --confirmed [--file <config.json>] [--api-base <url>] [--json]
  chengfeng-videocut render run <project> --expected-revision <sha256> --confirmed [--renderer <absolute-file>] [--projects-dir <dir>] [--output-dir <dir>] [--json]
  chengfeng-videocut cuts set <project> --file <file> --expected-revision <none|sha256> [--api-base <url>] [--json]
  chengfeng-videocut cuts set <project> --file <file> --dry-run [--json]
  chengfeng-videocut cuts apply <project> --expected-revision <sha256> --confirmed [--api-base <url>] [--json]

start serves the Studio on 127.0.0.1:5190 by default. It does not open a browser unless --open is provided.
Project may be an absolute directory or an id registered in the Workbench.
cuts set writes through the running product API; --dry-run performs a local read-only calculation.
cutRanges are derived from transcript.json + cutWordIds; supplied cutRanges are ignored.
project prepare only accepts real task-local video and transcript files; it never injects demo media.
render run executes locally and requires --renderer or CHENGFENG_VIDEOCUT_RENDERER_PATH.
Render exit codes: 7 missing renderer, 8 renderer failed, 9 verification failed.`;
