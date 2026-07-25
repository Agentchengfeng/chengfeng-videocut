import type { DomEditSelection } from "./domEditing";

export const EDIT_LIST_INSPECTOR_BLOCKED_MESSAGE =
  "此口播片段由剪口播时间线管理。请在底部时间线移动、裁剪、分割或删除；为避免结果分叉，这里不会直接修改 index.html。";

interface EditListManagedDomTarget {
  dataAttributes?: Record<string, string>;
  element?: Element | null;
}

export function isEditListManagedDomElement(element: Element | null | undefined): boolean {
  return Boolean(element?.hasAttribute("data-edl-segment-id"));
}

export function containsEditListManagedDomElement(element: Element | null | undefined): boolean {
  return Boolean(
    isEditListManagedDomElement(element) || element?.querySelector("[data-edl-segment-id]"),
  );
}

export function isEditListManagedDomSelection(
  selection:
    | EditListManagedDomTarget
    | Pick<DomEditSelection, "dataAttributes" | "element">
    | null,
): boolean {
  return Boolean(
    selection?.dataAttributes?.["edl-segment-id"]?.trim() ||
      isEditListManagedDomElement(selection?.element),
  );
}

export function blockEditListManagedDomMutation(
  selection: EditListManagedDomTarget | null,
  showToast: (message: string, tone?: "error" | "info") => void,
): boolean {
  if (!isEditListManagedDomSelection(selection)) return false;
  showToast(EDIT_LIST_INSPECTOR_BLOCKED_MESSAGE, "info");
  return true;
}
