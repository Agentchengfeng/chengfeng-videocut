import {
  WORKBENCH_SCHEMA_VERSION,
  type WorkbenchProjectManifest,
  type WorkbenchSubtitleCue,
  type WorkbenchWorkflowAdapter,
} from "@video-workbench/contracts";

export interface KouboProjectResponse {
  jobId: string;
  status?: string;
  projectDir?: string;
  config?: { aspectRatio?: string };
  artifacts?: Record<string, string>;
  duration?: number;
}

export interface KouboAdapterOptions {
  apiBase: string;
  projectIdForJob?: (job: KouboProjectResponse) => string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function createKouboAdapter(
  options: KouboAdapterOptions,
): WorkbenchWorkflowAdapter {
  const apiBase = trimTrailingSlash(options.apiBase);

  return {
    kind: "koubo",
    async loadProject(jobId) {
      const response = await fetch(`${apiBase}/api/jobs/${encodeURIComponent(jobId)}`);
      if (!response.ok) {
        throw new Error(`Failed to load koubo job ${jobId}: ${response.status}`);
      }
      const job = (await response.json()) as KouboProjectResponse;
      const projectId = options.projectIdForJob?.(job) ?? job.jobId;
      return {
        schemaVersion: WORKBENCH_SCHEMA_VERSION,
        id: job.jobId,
        title: job.jobId,
        duration: Number(job.duration ?? 0),
        aspectRatio: job.config?.aspectRatio,
        engine: { kind: "hyperframes", projectId, entry: "index.html" },
        workflow: { kind: "koubo", jobId: job.jobId, apiBase },
        subtitles: job.artifacts?.subtitles
          ? { source: job.artifacts.subtitles }
          : undefined,
        artifacts: job.artifacts,
      } satisfies WorkbenchProjectManifest;
    },
    async saveSubtitles(jobId: string, cues: WorkbenchSubtitleCue[]) {
      const response = await fetch(
        `${apiBase}/api/jobs/${encodeURIComponent(jobId)}/subtitles`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, cues }),
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to save subtitles for ${jobId}: ${response.status}`);
      }
    },
    async appendEvent(jobId, type, payload = {}) {
      const response = await fetch(
        `${apiBase}/api/jobs/${encodeURIComponent(jobId)}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, payload }),
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to append event for ${jobId}: ${response.status}`);
      }
    },
  };
}

export * from "./mediaCut";
export * from "./edlPreviewRuntime";
export * from "./previewProxy";
export * from "./naturalPause";
export * from "./project";
export * from "./projectLock";
export * from "./workflow";
export * from "./cutArtifactState";
export * from "./artifact";
export * from "./render";
export * from "./transcription";
