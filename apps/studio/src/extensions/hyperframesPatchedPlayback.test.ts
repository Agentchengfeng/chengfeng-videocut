// @vitest-environment happy-dom

/**
 * Run the pinned Studio package's transport suite from a product-owned test
 * entry. Vitest excludes node_modules as entry files, but the patched source is
 * the implementation compiled by this app and must remain regression-tested.
 */
import "../player/hooks/useTimelinePlayer.seek.test";
import "../hooks/usePreviewPersistence.fileChange.test";
import "../player/components/PlayerControls.test";
import "../player/components/Player.test";
import "../player/lib/timelineDOM.test";
import "../player/lib/timelineIframeHelpers.test";
import "../hooks/useRenderClipContent.test";
