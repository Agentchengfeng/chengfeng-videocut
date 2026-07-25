// 遥测已移除。原实现把事件发往第三方 PostHog（HyperFrames 的项目），
// 本产品不采集也不外发任何使用数据。保留同名空实现，避免改动全部调用点。
type EventProperties = Record<string, unknown>;

export function trackStudioEvent(_event: string, _properties: EventProperties = {}): void {}

export function flushViaBeacon(): void {}
