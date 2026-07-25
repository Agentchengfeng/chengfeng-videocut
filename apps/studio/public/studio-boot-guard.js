(function installStudioBootGuard() {
  "use strict";

  var BOOT_TIMEOUT_MS = 12_000;
  var RECOVERY_WINDOW_MS = 30_000;
  var RECOVERY_STORAGE_KEY = "chengfeng-videocut:studio-auto-recovery";
  var guard = document.getElementById("studio-boot-guard");
  var root = document.getElementById("root");
  var status = document.getElementById("studio-boot-status");
  var detail = document.getElementById("studio-boot-detail");
  var reloadButton = document.getElementById("studio-boot-reload");

  if (!guard || !root || !status || !detail || !reloadButton) return;

  var ready = false;
  var timeoutId = null;
  var observer = null;

  function safeSessionStorage() {
    try {
      return window.sessionStorage;
    } catch (_error) {
      return null;
    }
  }

  function setState(state, title, message, showReload) {
    guard.hidden = false;
    guard.dataset.state = state;
    status.textContent = title;
    detail.textContent = message;
    reloadButton.hidden = !showReload;
  }

  function buildRecoveryUrl(reason) {
    var url = new URL(window.location.href);
    url.searchParams.set("studio-recovery", String(Date.now()));
    url.searchParams.set("studio-recovery-reason", reason);
    return url.toString();
  }

  function navigate(url) {
    if (typeof window.__CHENGFENG_STUDIO_NAVIGATE__ === "function") {
      window.__CHENGFENG_STUDIO_NAVIGATE__(url);
      return;
    }
    window.location.replace(url);
  }

  async function serverIsReachable() {
    try {
      var response = await window.fetch("/api/health", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      // The Vite development server does not expose the packaged health route.
      // A 404 still proves that the same-origin server is reachable.
      return response.ok || response.status === 404;
    } catch (_error) {
      return false;
    }
  }

  function recentRecoveryAttempt(now) {
    var storage = safeSessionStorage();
    if (!storage) return false;
    var value = Number(storage.getItem(RECOVERY_STORAGE_KEY));
    return Number.isFinite(value) && now - value < RECOVERY_WINDOW_MS;
  }

  function recordRecoveryAttempt(now) {
    try {
      safeSessionStorage()?.setItem(RECOVERY_STORAGE_KEY, String(now));
    } catch (_error) {
      // Storage can be unavailable in sandboxed or privacy-restricted tabs.
    }
  }

  async function reloadOnce(reason) {
    var now = Date.now();
    if (recentRecoveryAttempt(now)) {
      setState(
        "error",
        "工作台没有正常启动",
        "自动恢复已经尝试过一次。请点击“重新打开”；如果仍然失败，请关闭这个标签页后重新进入。",
        true,
      );
      return false;
    }

    setState("recovering", "正在恢复工作台", "正在确认本地服务并重新载入页面…", false);
    if (!(await serverIsReachable())) {
      setState(
        "error",
        "本地服务没有响应",
        "请重新启动 chengfeng-videocut，然后点击“重新打开”。",
        true,
      );
      return false;
    }

    recordRecoveryAttempt(now);
    navigate(buildRecoveryUrl(reason));
    return true;
  }

  async function forceReload(reason) {
    setState("recovering", "正在重新打开工作台", "正在确认本地服务…", false);
    if (!(await serverIsReachable())) {
      setState(
        "error",
        "本地服务没有响应",
        "请重新启动 chengfeng-videocut，然后再次点击“重新打开”。",
        true,
      );
      return false;
    }
    recordRecoveryAttempt(Date.now());
    navigate(buildRecoveryUrl(reason || "manual"));
    return true;
  }

  function markReady() {
    if (ready) return;
    ready = true;
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    observer?.disconnect();
    guard.hidden = true;
    document.documentElement.dataset.studioReady = "true";
  }

  function showFailure(title, message) {
    setState("error", title, message, true);
  }

  function onReloadClick() {
    void forceReload("manual");
  }

  function onPreloadError(event) {
    event.preventDefault();
    void reloadOnce("asset-version-mismatch");
  }

  function onWindowError(event) {
    var target = event.target;
    if (target && target.tagName === "SCRIPT" && !ready) {
      void reloadOnce("script-load-error");
    }
  }

  function dispose() {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    observer?.disconnect();
    reloadButton.removeEventListener("click", onReloadClick);
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.removeEventListener("error", onWindowError, true);
  }

  reloadButton.addEventListener("click", onReloadClick);
  window.addEventListener("vite:preloadError", onPreloadError);
  window.addEventListener("error", onWindowError, true);

  observer = new MutationObserver(function () {
    if (root.childElementCount > 0) markReady();
  });
  observer.observe(root, { childList: true });

  timeoutId = window.setTimeout(function () {
    if (root.childElementCount > 0) {
      markReady();
      return;
    }
    void reloadOnce("mount-timeout");
  }, BOOT_TIMEOUT_MS);

  window.__CHENGFENG_STUDIO_BOOT__ = {
    markReady: markReady,
    reloadOnce: reloadOnce,
    forceReload: forceReload,
    showFailure: showFailure,
    dispose: dispose,
    getState: function () {
      return { ready: ready, state: guard.dataset.state || "loading" };
    },
  };
})();
