# v0.4.9 prerelease — canonical CutRange repair

> **Prerelease / controlled test only.** This patch keeps the Windows Desktop
> controlled-test distribution boundary introduced in v0.4.8. It does not make
> a general-availability claim.

## What changed

- New projects now write their natural-pause `cutRanges` through the same
  canonical range builder that validates projects.
- During an ordinary `project prepare`, a legacy `cuts-derived` project is
  repaired only when its saved ranges exactly prove the old range shape and its
  word IDs still resolve against the current transcript. The resulting ranges,
  edit list, and preview projection are regenerated together.
- Manual timelines, unknown range shapes, duplicate or unknown word IDs, and
  projects that cannot be proved to be the legacy form are left untouched and
  continue to fail closed for review.

## Validation boundary

This release has automated coverage for fresh natural-pause projects, provable
legacy `cuts-derived` migration, mixed semantic selections, and fail-closed
manual or unprovable projects. It does **not** claim a real Studio interaction,
an exported video, or human listening review has been validated by this change.

## Download verification

Use assets from the exact v0.4.9 GitHub Release and verify each download against
its attached `SHA256SUMS.txt`. The checksum manifest detects download mismatch;
it is not a publisher signature.
