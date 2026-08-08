# Managed renderer source preview

This branch is a **source-level technical preview**, not a Runtime release and
not a Codex Plugin release. It lets a developer verify the exact behavior that
matters for the new export path:

```text
empty Product cache
  -> confirmed overlay export downloads one pinned Chrome Headless Shell
  -> archive hash / executable checks
  -> local cache activation
  -> HTML subtitle frames
  -> FFmpeg MP4
  -> frame, size and audio readback
```

## What this preview does and does not prove

- It does not install or use the computer's Google Chrome, Chromium, Edge, or
  Electron.
- On a cache miss, it downloads Chrome for Testing Headless Shell from the
  official Chrome for Testing public bucket. The code locks the platform, build
  ID and SHA-256; it does not ask for `latest` at runtime.
- The first run needs network access to that source and downloads roughly
  100 MB. Later exports reuse the verified cache.
- This branch has been run end-to-end on macOS arm64 and a GitHub-hosted
  Windows x64 runner (Windows Server 2025). The Windows source E2E starts from
  an empty Product cache, renders a 30-frame subtitle MP4, reads back its
  video/audio/frame properties, and proves the second engine lookup is a
  cache hit ([run 31244024390](https://github.com/Agentchengfeng/chengfeng-videocut/actions/runs/31244024390)).
  It is not a Windows installer, SmartScreen, signature, user-project, or
  human-listening acceptance run.
- It is not an installer test: the public Plugin remains on its previous
  Runtime release, and this preview does not ship a Runtime asset, signature,
  or redistribution approval.

## Run the full local proof

Prerequisites: Bun 1.3+ and an `ffmpeg`/`ffprobe` pair on `PATH`. The filtered
install deliberately avoids the repository's historical desktop/Electron
workspace; no Electron download is needed for this test.

```bash
git clone --branch agent/remotion-managed-renderer-20260808 \
  https://github.com/Agentchengfeng/chengfeng-videocut.git
cd chengfeng-videocut
bun install --filter '@video-workbench/koubo-adapter' --ignore-scripts
CHENGFENG_VIDEOCUT_RENDERER_E2E=1 \
  bun test packages/koubo-adapter/src/export/exportFilm.managed-runtime.test.ts
```

The test uses a tracked two-second MP4 fixture, starts from an empty temporary
Product data directory, renders a subtitle overlay, writes a real MP4, then
counts its frames and probes its video/audio tracks. Temporary downloaded
engine and output files are removed by the test.

Do not use the existing public Plugin installation instructions to test this
branch: they currently resolve the older Runtime release and therefore test a
different browser path.
