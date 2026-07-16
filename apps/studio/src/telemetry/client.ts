type EventProperties = Record<string, string | number | boolean | undefined>;

export function shouldTrack(): boolean {
  return false;
}

/**
 * Compatibility no-op for inherited Studio call sites. Public builds are
 * local-only and never transmit anonymous analytics or project metadata.
 */
export function trackEvent(
  _event: string,
  _properties: EventProperties = {},
): void {
  // Intentionally local-only and side-effect free.
}
