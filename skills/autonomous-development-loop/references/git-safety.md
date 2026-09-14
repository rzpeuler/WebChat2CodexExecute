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

The tool's uncertain-push result is based on local commit `C` and baseline
remote `B`: remote `C` means success, remote `B` permits a safe retry, another
remote tip refuses overwrite, and an unknown tip remains uncertain.
