# Third-Party Notices

chengfeng-videocut bundles or builds upon third-party software. This file records the direct, material dependencies used by the distributed product. Transitive dependency versions and the exact dependency graph are recorded in `bun.lock`.

The complete license texts collected for binary distribution are in `THIRD_PARTY_LICENSES.md`. Apache License 2.0 is also reproduced in the repository root `LICENSE`.

## HyperFrames

This project contains a modified Studio interface and runtime components derived from HyperFrames.

- Project: https://github.com/heygen-com/hyperframes
- Copyright: Copyright 2026 HeyGen, Inc.
- License: Apache License 2.0
- Integration baseline: 0.7.54
- Packages: `@hyperframes/core`, `@hyperframes/parsers`, `@hyperframes/player`, `@hyperframes/producer`, `@hyperframes/sdk` and `@hyperframes/studio-server`

The upstream Apache License is included at `LICENSES/HyperFrames-Apache-2.0.txt`. Material changes are described in `MODIFICATIONS.md`.

chengfeng-videocut is not an official HyperFrames or HeyGen product. HyperFrames and HeyGen names and marks belong to their respective owners.

## Other direct dependencies

| Project or package family | Use in the product | License |
| --- | --- | --- |
| CodeMirror 6 (`@codemirror/*`) | Code and content editing | MIT |
| Phosphor Icons (`@phosphor-icons/react`) | Interface icons | MIT |
| React and React DOM | Studio interface runtime | MIT |
| Zustand | Studio state management | MIT |
| Marked | Markdown parsing | MIT |
| bpm-detective | Audio tempo analysis | MIT |
| DOMPurify | HTML sanitization | Apache-2.0 OR MPL-2.0; this distribution relies on the Apache-2.0 option |
| Mediabunny | Browser media processing | MPL-2.0 |
| GSAP 3.15.0, including MotionPathPlugin | Animation runtime | GSAP Standard “no charge” license |

The GSAP 3.15.0 package identifies its license as “Standard 'no charge' license.” GSAP and MotionPathPlugin are Copyright GreenSock/Webflow and their respective rights holders. Redistribution and use remain subject to https://gsap.com/standard-license/. The Apache-2.0 license for chengfeng-videocut does not replace those terms.

## License scope

Third-party components remain under their own licenses. Apache-2.0 applies to chengfeng-videocut project-owned code and the HyperFrames-derived Apache-2.0 portions, not to the complete bundled binary. Users are responsible for complying with applicable third-party terms; this notice does not provide a legal compliance guarantee.

chengfeng-videocut is not affiliated with or endorsed by HyperFrames, HeyGen, GSAP, GreenSock, or Webflow.

For the exact source corresponding to a published release, use the Git tag with the same version at:

https://github.com/Agentchengfeng/chengfeng-videocut
