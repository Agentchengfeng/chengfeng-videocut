const groups = ".caption-group, .caption-line, .caption-block";
/** Resolve a source and its exact live composition; never select a first candidate. */
export function resolveCaptionSource(doc: Document, activePath: string | null, sources: Map<string, string>): { path: string; scope: Element; metadataScope: Element } | null {
  if (!doc.querySelector(groups)) return null;
  const candidates = new Map<string, Set<Element>>();
  const add = (path: string, scope: Element) => {
    if (!scope.querySelector(groups)) return;
    const scopes = candidates.get(path) ?? new Set<Element>();
    // Loader host + its rendered root may describe the exact same instance.
    const currentGroups = [...scope.querySelectorAll(groups)];
    for (const existing of scopes) {
      const existingGroups = [...existing.querySelectorAll(groups)];
      if (currentGroups.length === existingGroups.length && currentGroups.every((group, i) => group === existingGroups[i])) {
        if (scope.contains(existing)) return;
        scopes.delete(existing);
      }
    }
    scopes.add(scope); candidates.set(path, scopes);
  };
  for (const scope of doc.querySelectorAll("[data-composition-id], [data-composition-src], [data-composition-file]")) {
    const explicit = scope.getAttribute("data-composition-src") || scope.getAttribute("data-composition-file");
    const id = scope.getAttribute("data-composition-id");
    const mapped = id ? sources.get(id) : undefined;
    if (explicit && mapped && explicit !== mapped) throw new Error("字幕来源标记不一致，已拒绝编辑");
    const path = explicit || mapped;
    if (path) add(path, scope);
  }
  // The current standalone composition may not have a source attribute/map yet.
  if (activePath && !candidates.has(activePath) && /caption/i.test(activePath)) {
    const roots = [...doc.querySelectorAll("[data-composition-id]")].filter(scope => !scope.parentElement?.closest("[data-composition-id]"));
    if (candidates.size === 0 && roots.length === 1) add(activePath, roots[0]);
  }
  const selected = activePath && candidates.has(activePath) ? activePath : candidates.size === 1 ? [...candidates.keys()][0] : null;
  if (!selected) throw new Error("无法唯一确定字幕源，请打开明确的字幕文件后编辑");
  const scopes = [...candidates.get(selected)!];
  if (scopes.length !== 1) throw new Error("同一字幕源存在多个画面实例，已拒绝编辑");
  const scope = scopes[0];
  const scopedGroups = [...scope.querySelectorAll(groups)];
  if (doc.querySelectorAll(groups).length !== scopedGroups.length) {
    throw new Error("当前画面含多个字幕来源，请打开独立字幕画面后编辑");
  }
  // A parent composition is not an exact scope if it also includes another source.
  for (const [path, others] of candidates) for (const other of others) {
    if (path !== selected && scope.contains(other)) throw new Error("字幕范围包含其他来源，请打开具体字幕文件");
  }
  let metadataScope = scope;
  if (!scope.hasAttribute("data-duration") && scope.getAttribute("data-hf-inner-root") === "true") {
    const host = scope.parentElement?.closest("[data-composition-src], [data-composition-file]");
    const hostPath = host?.getAttribute("data-composition-src") || host?.getAttribute("data-composition-file");
    const hostGroups = host ? [...host.querySelectorAll(groups)] : [];
    if (host && hostPath === selected && hostGroups.length === scopedGroups.length
      && hostGroups.every((group, index) => group === scopedGroups[index])) metadataScope = host;
  }
  return { path: selected, scope, metadataScope };
}
