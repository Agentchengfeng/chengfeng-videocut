import type { DurableJob, PublicDurableJob } from "@video-workbench/contracts";

/** Public/API projection. The process token is a private recovery proof. */
export function publicJob(job: DurableJob): PublicDurableJob {
  return {
    ...job,
    owner: job.owner ? {
      pid: job.owner.pid,
      startedAt: job.owner.startedAt,
      heartbeatAt: job.owner.heartbeatAt,
    } : null,
  };
}
