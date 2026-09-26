import { expect, it } from "vitest";
import { VITE_RENDER_CAPABILITY } from "./vite.renderCapability";
import { parseRenderCapability } from "./src/components/renders/useRenderCapability";
it("declares the development producer capability explicitly", () => {
  expect(VITE_RENDER_CAPABILITY).toEqual({ schemaVersion: 1, enabled: true, source: "vite-producer-adapter", reason: "开发工作台提供通用 HTML 导出。" });
  expect(parseRenderCapability({ genericHtmlRender: VITE_RENDER_CAPABILITY }).enabled).toBe(true);
});
