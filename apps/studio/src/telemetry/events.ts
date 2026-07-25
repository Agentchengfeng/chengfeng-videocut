// 遥测已移除，见 ../utils/studioTelemetry.ts。
export function trackStudioSessionStart(_props: { has_project: boolean }): void {}

export function trackStudioRenderStart(_props: Record<string, unknown>): void {}

export function trackStudioRazorSplit(_props: { mode: "single" | "all"; count: number }): void {}

export function trackStudioExpandedClipEdit(_props: Record<string, unknown>): void {}

export function trackStudioFeedback(_props: { rating: number; comment?: string }): void {}
