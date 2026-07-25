export interface StudioBootGuard {
  markReady(): void;
  reloadOnce(reason: string): Promise<boolean>;
  forceReload(reason?: string): Promise<boolean>;
  showFailure(title: string, message: string): void;
  dispose(): void;
  getState(): { ready: boolean; state: string };
}

type StudioWindow = Window & {
  __CHENGFENG_STUDIO_BOOT__?: StudioBootGuard;
};

export function studioBootGuard(): StudioBootGuard | undefined {
  return (window as StudioWindow).__CHENGFENG_STUDIO_BOOT__;
}
