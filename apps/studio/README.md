# chengfeng-VideoCut Studio

The browser editing shell for `chengfeng-VideoCut`. It runs as an independent
application against versioned HyperFrames engine packages, while the talking-head
workflow, confirmation gates, and final render are owned by the product adapters.

## Development

```bash
bun run dev
bun run typecheck
bun run test
bun run build
```

Projects are discovered from `data/projects` by default. Set
`VIDEO_WORKBENCH_PROJECTS_DIR` to use another registry without editing source.

This package owns editor UI only. Workflow-specific behavior belongs in a
workflow adapter under `packages/`.
