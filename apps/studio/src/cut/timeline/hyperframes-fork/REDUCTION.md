# HyperFrames Timeline live fork reduction

Immutable mother copy: `../hf-upstream-0.7.60/`.

The immutable mother copy keeps the full upstream presentation chain and
filenames:

```text
TimelinePane
  + TimelineResizeDivider
  + TimelineToolbar
  + Timeline
      + TimelineCanvas
          + TimelineRuler
          + TimelineLanes
              + TimelineClip
          + PlayheadIndicator
```

The live Product bundle deliberately reduces the outer height owner while
keeping the Timeline render chain:

```text
CutWorkspace (four-zone grid owns pane height)
  + TimelineToolbar
  + Timeline
      + TimelineCanvas
          + TimelineRuler
          + TimelineLanes
              + TimelineClip
          + PlayheadIndicator
```

Only these upstream branches are deleted from the live Product fork:

| Removed upstream branch | Reason |
| --- | --- |
| `usePlayerStore` and `useTimelineZoom` store ownership | Product Playback Kernel and EditList are the only owners. |
| keyframes and GSAP controls | Talking-head cut does not author animation. |
| beat analysis and beat editing | No music/beat editing contract in this workspace. |
| arbitrary multi-track creation and track visibility | The two rows are linked video/audio projections of one Product segment group. |
| asset/file/block drop | Media import belongs to the Product project workflow. |
| HyperFrames drag/resize persistence and optimistic revisions | One Product EditList CAS transaction commits each edit. |
| composition drill-down and context menus | No nested composition exists in the talking-head workspace. |
| marquee/range/keyframe selection | Product selection is one linked A/V group. |
| mounted `TimelinePane` / `TimelineResizeDivider` height owner | The Product four-zone grid is the single layout owner. The source files remain traceable in the fork, while the live grid row is sized to the upstream 242px canvas plus toolbar instead of creating a second height store. |

The following applicable upstream controls remain: selection, snapping,
split, fit, logarithmic zoom, pinch zoom, ruler, two lanes, clips, trim handles
and playhead. Delete is a Product extension wired to the same single EditList
transaction. Filmstrip and waveform children are Product adapters inside the
upstream clip shell. Neither a `<video>` nor `<audio>` element is created by
the fork.
