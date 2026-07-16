export type VideocutErrorCode =
  | "invalid_argument"
  | "project_not_found"
  | "invalid_project"
  | "invalid_json"
  | "invalid_transcript"
  | "invalid_cut_selection"
  | "revision_conflict"
  | "project_id_conflict"
  | "studio_origin_required"
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
