# v0.4.10 prerelease — Windows Chrome discovery

This release carries the Windows export renderer fix from the v0.4.9 baseline.

- The CLI export renderer now discovers Google Chrome in machine-wide and per-user Windows installations.
- `CHENGFENG_VIDEOCUT_CHROME_PATH` may explicitly select an existing absolute Chrome executable.
- Invalid overrides fail closed instead of silently falling back to another browser.
- macOS and Linux discovery remains covered by regression tests.

Windows installation and final subtitle/HTML-layer export must still be verified on the target machine after installing this release.
