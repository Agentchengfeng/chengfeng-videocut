export type VideocutErrorCode =
  | "invalid_argument"
  | "project_not_found"
  | "invalid_project"
  | "invalid_json"
  | "invalid_transcript"
  | "invalid_cut_selection"
  | "invalid_edit_list"
  | "revision_required"
  | "revision_conflict"
  | "project_id_conflict"
  | "studio_origin_required"
  | "media_has_no_audio"
  | "missing_cloud_transcription_adapter"
  | "cloud_transcription_failed"
  /**
   * A write succeeded but reading it back did not match what was written. The
   * write protocol always required this check; leaving it as prose meant it could
   * be skipped, and on 2026-07-26 it was — a submission silently replaced the
   * previous conclusion and nothing objected. This code exists so an unverified
   * write reports failure rather than success.
   */
  | "readback_mismatch"
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
