# Installed Product E2E Harness

`scripts/e2e-installed-product.ts` is an opt-in harness for the installed
chengfeng-videocut product. By default it exits with `SKIP` and does not build,
install, start services, or touch a Product home.

Run it only when you want an installed-world acceptance pass:

```sh
CHENGFENG_VIDEOCUT_INSTALLED_E2E=1 bun run e2e:installed-product -- --json
```

The harness creates a fresh root under the system temp directory, sets `HOME` to
`<run-root>/home`, and lets the default Product root resolve naturally to
`<run-root>/home/.chengfeng-videocut`. It rejects an explicit `--output-root`
outside the system temp directory or a non-empty output root.

What it verifies:

- builds a self-contained local-test-only candidate and installs it with
  `assetDownloads=0`;
- uses the static media tools from this worktree's `node_modules`:
  `ffmpeg-static@5.3.0` and `@derhuerst/ffprobe-static@5.3.0`, both reporting
  real `6.0` binaries;
- authorizes local development inside the isolated HOME and checks
  `doctor --local-development --json` for the local-development readiness and
  capability contract;
- creates an isolated project from task-local media and transcript inputs,
  then verifies full transcript playback pagination;
- writes one cut selection through the Studio HTTP API with CAS and readback,
  then proves a stale CAS conflict;
- verifies the Studio HTTP route marker at
  `/api/projects/<projectId>/surface`;
- exercises silent-media failure, source fake-provider response-loss retry,
  stale transcript cursor, and foreground server restart;
- fingerprints original media before and after, checks the user's default
  Product projects snapshot, and avoids the default `5190` service path.

Real cloud ASR is not faked. To include it, provide a real voice media file and
credentials:

```sh
CHENGFENG_VIDEOCUT_INSTALLED_E2E=1 \
CHENGFENG_VIDEOCUT_INSTALLED_E2E_CLOUD=1 \
VOLCENGINE_API_KEY=... \
bun run e2e:installed-product -- --voice-media /absolute/path/to/voice.mp4 --json
```

If credentials or voice media are missing, the real cloud stage is reported as
`SKIP`. The fake-provider retry stage remains local-only evidence for recovery
logic and is not reported as cloud ASR coverage.

When `--voice-media` is omitted, the installed project path uses generated A/V
media to exercise real media ingestion, hashing, copy, playback, and Studio
routes. That built-in media is not human speech, so the human-voice input stage
is reported as `UNVERIFIED`.

The harness writes a final evidence JSON file under the system temp directory.
By default it removes the run root after collecting evidence. Pass `--keep` to
preserve the isolated run root for inspection.
