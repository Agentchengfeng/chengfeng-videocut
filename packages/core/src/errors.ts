export type VideocutErrorCode =
  | "invalid_argument"
  | "project_not_found"
  | "invalid_project"
  | "invalid_json"
  | "invalid_transcript"
  | "invalid_cut_selection"
  | "invalid_edit_list"
  | "invalid_subtitles"
  | "invalid_visuals"
  /** A subtitle document exists and rebuilding it would discard hand-editing. */
  | "subtitles_exist"
  | "revision_required"
  | "revision_conflict"
  | "project_id_conflict"
  | "studio_origin_required"
  | "media_has_no_audio"
  | "missing_cloud_transcription_adapter"
  | "cloud_transcription_failed"
  | "cloud_transcription_checkpoint_corrupt"
  | "cloud_transcription_checkpoint_mismatch"
  | "cloud_transcription_cancelled"
  /**
   * A write succeeded but reading it back did not match what was written. The
   * write protocol always required this check; leaving it as prose meant it could
   * be skipped, and on 2026-07-26 it was — a submission silently replaced the
   * previous conclusion and nothing objected. This code exists so an unverified
   * write reports failure rather than success.
   */
  | "readback_mismatch"
  | "invalid_operation_id"
  | "operation_id_conflict"
  | "operation_in_progress"
  | "operation_replay_stale"
  | "operation_replay_conflict"
  | "operation_audit_invalid_field"
  | "operation_audit_corrupt"
  | "operation_audit_record_too_large"
  | "committed_with_followup_failure"
  | "operation_failed"
  | "io_error";

export class VideocutError extends Error {
  readonly code: VideocutErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: VideocutErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VideocutError";
    this.code = code;
    this.details = details;
  }
}

export function asVideocutError(error: unknown): VideocutError {
  if (error instanceof VideocutError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new VideocutError("io_error", message);
}
