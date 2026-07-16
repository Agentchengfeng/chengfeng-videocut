# Architecture

## Dependency direction

```text
Talking-head workflow (optional) ----> workflow adapter ----+
                                                          |
Workbench contracts <---- editor shell --------------------+
                                                          |
HyperFrames packages <---- engine adapter -----------------+
```

The arrows point toward dependencies. HyperFrames never imports workflow code,
and the talking-head workflow never owns editor layout.

## Layer responsibilities

### Workbench

- window layout, preview surface, playback controls, timeline, undo/redo
- editor state and project selection
- caption text/timing editing through the shared contract
- engine-neutral commands such as seek, split, trim, and export

### HyperFrames adapter

- opens a HyperFrames project in the Studio runtime
- translates workbench open state into HyperFrames routing state
- owns HyperFrames-specific preview and render calls

### Talking-head adapter

- reads `project.json` from the workflow service
- maps A-roll, B-roll, subtitles, and artifacts into the workbench contract
- writes user decisions through service APIs
- does not import skill files or editor components

## Data ownership

- The workflow keeps immutable generated artifacts such as the first SRT.
- The workbench writes editable state to a separate versioned artifact.
- A confirmed edit produces a derived SRT/JSON and appends a workflow event.
- Local project symlinks are runtime registry entries and stay outside Git.

## Migration sequence

1. Run the extracted Studio against versioned HyperFrames packages.
2. Keep the original fork running until preview, trim, and export parity pass.
3. Move caption persistence to the shared workbench contract.
4. Add the talking-head API adapter without adding business code to Studio.
5. Remove Chengfeng UI patches from the HyperFrames fork only after parity.

