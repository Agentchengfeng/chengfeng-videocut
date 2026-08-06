export const NATIVE_RELEASE_STAGE_BLOCK_REASON =
  "Native release staging is blocked: independent protected release orchestrator is not implemented or configured";

export function stageNativeRelease(): never {
  // A source-controlled workflow, policy path, digest, CLI argument, or
  // environment variable cannot authenticate an independent release trust
  // anchor. Keep this repository incapable of producing a formal staged
  // directory until the protected external orchestrator exists and is audited.
  throw new Error(NATIVE_RELEASE_STAGE_BLOCK_REASON);
}

if (import.meta.main) stageNativeRelease();
