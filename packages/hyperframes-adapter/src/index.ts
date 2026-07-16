import type {
  WorkbenchEngineAdapter,
  WorkbenchOpenState,
  WorkbenchProjectManifest,
} from "@video-workbench/contracts";

export interface HyperframesAdapterOptions {
  studioOrigin: string;
}

function encodeFlag(value: boolean | undefined, fallback: boolean): string {
  return (value ?? fallback) ? "1" : "0";
}

export function createHyperframesAdapter(
  options: HyperframesAdapterOptions,
): WorkbenchEngineAdapter {
  const origin = new URL(options.studioOrigin);

  return {
    kind: "hyperframes",
    canOpen(manifest) {
      return manifest.engine.kind === "hyperframes";
    },
    buildPreviewUrl(
      manifest: WorkbenchProjectManifest,
      state: WorkbenchOpenState = {},
    ) {
      if (manifest.engine.kind !== "hyperframes") {
        throw new TypeError(`Unsupported engine: ${manifest.engine.kind}`);
      }
      const query = new URLSearchParams({
        v: "1",
        t: String(state.time ?? 0),
        tab: state.tab ?? "design",
        tv: encodeFlag(state.timelineVisible, true),
      });
      const projectId = encodeURIComponent(manifest.engine.projectId);
      origin.hash = `project/${projectId}?${query.toString()}`;
      return origin.toString();
    },
  };
}

