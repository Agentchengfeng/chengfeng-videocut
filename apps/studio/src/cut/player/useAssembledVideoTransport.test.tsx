// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useAssembledVideoTransport } from "./useAssembledVideoTransport";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
});

function Harness({ sourceUrl }: { sourceUrl: string | null }) {
  const transport = useAssembledVideoTransport({
    stream: null,
    sourceUrl,
    resolveFragmentUrl: (source) => source,
    duration: 10,
    initialTimelineTime: 0,
  });
  return (
    <>
      <span data-testid="published">{transport.timelineTime.toFixed(2)}</span>
      {sourceUrl ? <video ref={transport.videoRef} /> : null}
    </>
  );
}

describe("useAssembledVideoTransport", () => {
  // The player renders its <video> only once there is something to play, so the
  // element always arrives after this hook's first commit. Nothing else about the
  // hook's inputs need change when it does — so an effect that merely reads a ref
  // subscribes to a clock that is not there yet and never returns. That shipped
  // once: sound was perfect and the transcript playhead sat on the first word.
  it("follows a media element that mounts after the first render", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<Harness sourceUrl={null} />));
    expect(host.querySelector("video")).toBeNull();

    act(() => root.render(<Harness sourceUrl="/api/projects/demo/preview/source.mp4" />));
    const video = host.querySelector("video");
    expect(video).not.toBeNull();

    Object.defineProperty(video!, "currentTime", { value: 7.5, configurable: true });
    act(() => { video!.dispatchEvent(new Event("timeupdate")); });

    expect(host.querySelector('[data-testid="published"]')?.textContent).toBe("7.50");
  });
});
