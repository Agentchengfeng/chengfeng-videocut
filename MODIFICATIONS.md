# Modifications to HyperFrames

chengfeng-videocut contains a modified Studio interface and runtime components derived from [HyperFrames](https://github.com/heygen-com/hyperframes), licensed under the Apache License 2.0.

## Baseline

- Upstream project: HyperFrames
- Upstream organization: HeyGen, Inc.
- Baseline used by this project: 0.7.54
- Modification record date: 2026-07-16

The version above identifies the intended integration baseline. Exact dependency resolutions used to build a Release are recorded by the repository lockfile and the Release artifacts.

## Material changes

Relative to the upstream Studio and runtime, this project has made material changes including:

1. Rebranded the product as `chengfeng-videocut` and removed upstream product wordmarks from the distributed interface.
2. Added product-owned project, transcript, cut-selection, revision and render-status contracts.
3. Added the `chengfeng-videocut` CLI and a local server intended for Skills, scripts and Agent automation.
4. Added local project registration, revision-aware writes, atomic cut-selection updates and confirmation-gated rendering.
5. Added talking-head workflow adapters, transcript and silence review behavior, caption/timeline integration and product-specific interface changes.
6. Changed packaging so the Studio and required runtime assets can be distributed together through GitHub Releases.
7. Disabled analytics telemetry in the distributed product and kept the default service binding on `127.0.0.1`.
8. Added product-specific validation, diagnostics, media verification, tests and release checks.

These modifications are maintained by 成峰 / AI产品自由 and are not authored, reviewed or endorsed by HeyGen, Inc.

## Source identification

Files under `apps/studio` and integration code that imports `@hyperframes/*` may contain or build upon upstream concepts or code. Product-owned code is also present under `apps/cli` and `packages`. The repository history and this document provide the prominent modification notice required for the redistributed derivative.

The complete Apache License 2.0 text is included in `LICENSE` and `LICENSES/HyperFrames-Apache-2.0.txt`. Additional notices are listed in `THIRD_PARTY_NOTICES.md`.
