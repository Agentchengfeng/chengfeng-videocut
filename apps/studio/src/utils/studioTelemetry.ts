interface EventProperties {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * chengfeng-VideoCut is a local-first product. The upstream Studio event API
 * remains as a compatibility seam, but the public distribution never sends
 * usage, project, error, or device data to a remote analytics service.
 */
export function trackStudioEvent(
  _event: string,
  _properties: EventProperties = {},
): void {
  // Intentionally local-only and side-effect free.
}

export function flushViaBeacon(): void {
  // Intentionally local-only and side-effect free.
}
