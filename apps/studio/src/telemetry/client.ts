// 遥测已移除，见 ../utils/studioTelemetry.ts。
type EventProperties = Record<string, unknown>;

export function shouldTrack(): boolean {
  return false;
}

export function trackEvent(_event: string, _properties: EventProperties = {}): void {}
