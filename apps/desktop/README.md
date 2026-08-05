# Chengfeng VideoCut Desktop experiment

This package is an isolated Electron shell experiment. It does not replace the
published Plugin + Runtime installation path.

```bash
bun run desktop:test
bun run desktop:smoke
bun run desktop:dist:dir
```

The resource preparation step copies the already-built Runtime/Studio plus the
target operating system's Bun, FFmpeg, and FFprobe executables into
`dist-resources/`. Build the Windows installer on Windows and the macOS package
on macOS; binaries are not cross-compiled.

Resource preparation also executes the exact FFprobe query used by the Runtime
against a generated video fixture. An old or incompatible media binary therefore
fails the package build instead of failing later on a user's project.

The shell reuses an already-running Runtime only when its product and version
match. Otherwise it fails closed. When it starts its own Runtime, normal app
shutdown stops only that child process.

This experiment does not yet include code signing, notarization, an update
channel, or a completed redistribution-license review for the bundled media
binaries. The Windows workflow builds an NSIS installer, smoke-tests both the
unpacked and silently installed application, and uninstalls it afterward.
