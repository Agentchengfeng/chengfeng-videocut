// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isEditableTarget } from "./timelineDiscovery";

describe("isEditableTarget — hotkey and nudge text-editing guard", () => {
  it.each(["input", "textarea", "select"])("guards %s controls", (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true);
  });
  it.each(["textbox", "searchbox", "combobox"])("guards role=%s", (role) => {
    const element = document.createElement("div");
    element.setAttribute("role", role);
    expect(isEditableTarget(element)).toBe(true);
  });
  it.each(["contenteditable", "textbox", "cm-editor"])("guards descendants of %s", (kind) => {
    const editor = document.createElement("div");
    if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
    else if (kind === "textbox") editor.setAttribute("role", "textbox");
    else editor.className = "cm-editor";
    const child = document.createElement("span");
    editor.append(child);
    expect(isEditableTarget(child)).toBe(true);
  });
  it("guards the native contenteditable flag", () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "isContentEditable", { value: true });
    expect(isEditableTarget(element)).toBe(true);
  });
  it("allows ordinary timeline targets, disabled contenteditable and absent targets", () => {
    const element = document.createElement("div");
    element.setAttribute("contenteditable", "false");
    expect(isEditableTarget(element)).toBe(false);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(new EventTarget())).toBe(false);
  });
});
