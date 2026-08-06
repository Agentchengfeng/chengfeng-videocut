# v0.5.0 — native installer and managed tools

Status: implementation branch; public release blocked.

0.5.0 adds platform-native compiled installers, a checksummed install manifest, transactional
Runtime/tools activation, and a fixed managed Chrome resolver. The intended user installs only
the Codex Plugin; system Node, Bun, FFmpeg, FFprobe, and Chrome are not prerequisites.

The asset contract and unresolved gates are documented in `docs/distribution.md`. Third-party
redistribution review, signing, macOS x64, Windows x64, and real scheduler verification remain
UNVERIFIED. Native staging now independently requires strict Developer ID/Gatekeeper verification,
native Windows Authenticode verification, pinned publisher identities, and cryptographic GitHub
artifact attestations bound to the protected tag workflow. The signing policy intentionally remains
`UNCONFIGURED`, so unsigned or locally invented identities fail closed. Local fixture bundles must
not be published.
