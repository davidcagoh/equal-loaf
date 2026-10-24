# Hackathon archival WIP snapshot (2026-10-24)

This directory preserves uncommitted diffs from task worktrees without merging or modifying those worktrees. These patches are archival and unintegrated; they are not a release or evidence of end-to-end behavior. The tiny synthetic credential and transcript literals in test fixtures were replaced with redaction markers, so those fixture values must be restored before applying/running affected tests.

Apply each patch only against its original task branch/ref after reviewing it:

- `patches/task-boson-0sp-28-32-2-uncommitted.patch`
- `patches/task-boson-0sp-28-32-3-uncommitted.patch`

The `.beads/issues.jsonl` export is intentionally omitted: it contains account identifiers and extensive private project handoff/history. Beads remains local and its newly created archive task is recorded in the local Dolt database.
