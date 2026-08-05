# Chengfeng VideoCut Desktop preview

This package is an Electron shell for the existing Product Runtime. It does not
create a second Runtime or a Desktop-only API.

```bash
bun run desktop:test
bun run desktop:smoke
bun run desktop:dist:dir
```

The resource preparation step copies the already-built Runtime/Studio, a local
installer payload, and the target operating system's Bun, FFmpeg, and FFprobe
executables into `dist-resources/`. Build the Windows installer on Windows and
the macOS package on macOS; binaries are not cross-compiled.

Resource preparation also executes the exact FFprobe query used by the Runtime
against a generated video fixture. An old or incompatible media binary therefore
fails the package build instead of failing later on a user's project.

In a packaged app, first launch installs those resources into the normal
`~/.chengfeng-videocut/app/<version>` and `tools/<version>` layout, advances the
managed `current` links, and calls the installed stable CLI's `service ensure`.
The resulting launchd / Windows Task Scheduler service survives app exit and is
the same service used by every Plugin Skill. The app never exposes an Electron
resources path as a public CLI.

Foreground ownership is retained only behind
`CHENGFENG_VIDEOCUT_DESKTOP_TRANSIENT=1` for isolated smoke tests. Packaged
managed smoke additionally proves first install, parent exit survival, stable
launcher doctor, and explicit service stop.

This preview does not yet include code signing, notarization, an update
channel, or a completed redistribution-license review for the bundled media
binaries. The Windows workflow builds an NSIS installer, smoke-tests both the
unpacked and silently installed application, and uninstalls it afterward.
