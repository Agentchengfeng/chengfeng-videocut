# v0.4.8 prerelease — Windows Desktop controlled test

> **Prerelease / controlled test only.** This build is for invited Windows
> Desktop testers and the matching downloadable Runtime used by Chengfeng
> VideoCut Skills. Do not treat it as a general-availability release.

## What is included

- Windows x64 NSIS Desktop installer with the shared managed Runtime payload.
- Version-pinned and stable-name portable Runtime archives.
- Version-pinned and stable-name CLI `.tgz` archives for diagnostics or
  controlled installation.
- **No macOS Desktop DMG is attached to this Release.** macOS Desktop testing
  is outside the v0.4.8 controlled-test scope.

## Download verification

Download assets only from this exact GitHub Release. Before running an
installer, verify its SHA-256 against the `SHA256SUMS.txt` attached to the same
Release. The manifest covers both installers, both portable names, both `.tgz`
names, and the Windows EXE. It detects a download mismatch; it is not a
publisher signature.

## Test boundary and known limits

- The EXE is an unsigned prerelease test artifact. Windows reputation or
  security prompts may appear; do not bypass a warning you cannot attribute to
  this exact Release and checksum.
- Code signing, macOS notarization, automatic updating, and the redistribution
  license review for bundled FFmpeg/FFprobe are **not complete**. This release
  makes no claim that they are complete.
- Test on Windows 10/11 x64 only. The installer is per-user and does not request
  elevation. First launch installs the shared Runtime under the product-managed
  user directory; it does not modify the system PATH.

## Feedback requested

Report the exact Release tag, asset filename, SHA-256 result, Windows version,
and whether first launch, Runtime health, and uninstall behaved as expected.
