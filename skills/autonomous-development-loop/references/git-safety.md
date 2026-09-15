# Git Safety

Before a task, capture repository root, branch, HEAD, remote, remote tip, and
worktree. Preserve unrelated local changes.

Before synchronization:

1. Re-check repository identity and branch.
2. Fetch/query the remote and compare the expected remote tip.
3. Check changed paths against target-project protected paths and generic secret
   patterns.
4. Validate the required report and state paths.
5. Use `safe-git-sync` with explicit JSON input.

Never force-push, reset destructively, rewrite shared history, or commit
credentials by default. A remote advance must be inspected and integrated or
reported as a blocker.

The tool uses two commits without self-reference. Implementation commit `C`
contains the ready-to-sync report. After remote `C` is verified, a separate
report-finalization commit `D` records `implementation_commit: C`,
`verified_remote_tip: C`, and `sync_status: SYNCED`; the remote HEAD is `D`.
The report does not record `D` because that would require a self-referential
commit hash. The pending record tracks the active phase and both commits, but
is never staged as a project change.

For either active push, the expected previous remote tip is the baseline for
`C` or `C` for `D`: the expected tip permits a safe retry, the local commit
means success for that phase, another tip refuses overwrite, and an unknown
tip remains uncertain.

Crash recovery is conservative. With no pending record and `HEAD != B`, ADL
reconstructs `C` only when `B` is an ancestor, the worktree is clean, the
current branch and report identity match, the report is `READY_TO_SYNC`, all
changed paths satisfy policy, and required paths plus the expected remote tip
are present. With `phase: REPORT_FINALIZATION` and no recorded `D`, ADL
reconstructs `D` only when `D^ = C`, the worktree is clean, the commit changes
only the finalized report, and the report is valid and identifies `C`.
Ambiguous evidence fails closed.
