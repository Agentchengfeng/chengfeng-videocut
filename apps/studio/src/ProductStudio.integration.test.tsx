// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const studioAppSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));

vi.mock("./App", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./App")>()),
  StudioApp: studioAppSpy,
}));

import { ProductStudio } from "./ProductStudio";
import { useKouboTimelineEditingAdapter } from "./extensions/koubo/useKouboTimelineEditingAdapter";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
  studioAppSpy.mockClear();
});

describe("ProductStudio production wiring", () => {
  it("keeps the normal Studio header free of a permanent Koubo view", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<ProductStudio />));

    expect(studioAppSpy).toHaveBeenCalled();
    const props = studioAppSpy.mock.lastCall?.[0];
    expect(props).toMatchObject({
      useTimelineEditingAdapter: useKouboTimelineEditingAdapter,
    });
    expect(props).not.toHaveProperty("views");

    act(() => root.unmount());
  });
});
