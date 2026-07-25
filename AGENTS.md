# Video Workbench Engineering Rules

## Product record gate

- Before changing product behavior, architecture, UI, workflow, distribution, runtime lifecycle, or a public contract, read the current design record for the area you are touching and confirm the change against it.
- Read-only diagnosis and reproduction may precede the record. Once the intended product change is known, implementation waits until the record is updated.
- After acceptance, preserve observable proof and append the actual result to that area's history; update the design record whenever a stated rule changes.
- Product records live in the operator's private workspace outside this repository. Do not assume a path to them, do not copy their content into this repo, and never write confidential product judgement into any publishable directory.


## Ownership

- UI and editor behavior live in `apps/studio`.
- Shared data shapes live in `packages/contracts`.
- Engine-specific code lives in an engine adapter.
- Workflow-specific code lives in a workflow adapter.

Do not add imports from local skill directories or another source repository.
Do not hardcode `/Volumes/...` paths or service ports in application code.
Use environment variables and manifests at process boundaries.

## Runtime data

Projects are linked into `apps/studio/data/projects` or supplied through
`VIDEO_WORKBENCH_PROJECTS_DIR`. Runtime data, logs, media, and job artifacts are
local-only and must remain ignored by Git.

## Verification

The Agent owns first-pass QA; do not make the user discover the initial regression.
Run `bun run typecheck`, targeted tests, and `bun run build` before declaring an
editor change complete. For UI changes, also exercise the real project path in the
Codex built-in browser. For Runtime, process, installer, or distribution changes,
exercise the real install/start/parent-exit/crash-recovery/explicit-stop/conflict
paths. Preserve observable evidence with the private product records and preserve
seek-safe HyperFrames behavior in previews and renders. If a real path cannot be
tested, report it as unverified rather than fixed.
