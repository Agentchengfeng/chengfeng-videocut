# Video Workbench Engineering Rules

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

Run `bun run typecheck`, targeted tests, and `bun run build` before declaring an
editor change complete. Preserve seek-safe HyperFrames behavior in previews and
renders.

