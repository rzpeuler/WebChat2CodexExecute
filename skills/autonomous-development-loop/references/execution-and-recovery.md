# Execution and Recovery

## Agent-native loop

```text
inspect → diagnose → plan internally → execute → observe → validate → continue
```

Keep the loop bounded by evidence. When the same failure signature repeats,
change the diagnostic or strategy; do not retry an unchanged command forever.

## Failure classes

- Recoverable engineering failure: debug and continue.
- Transient external failure: retry with bounded backoff and alternatives.
- Environment configuration blocker: try safe local alternatives before asking
  for missing access or installation.
- Governance blocker: preserve safe work and report the exact conflict.
- Architecture decision required: stop before selecting an unauthorized route.
- Unsafe operation: do not perform it; record the concrete risk.

## Recoverable transaction boundary

Local Git commits and pending-state persistence form a recoverable transaction
boundary. A process crash may occur between any two filesystem or Git
operations. On restart, reconstruct state only when repository, report,
branch, commit ancestry, path scope, and remote facts uniquely establish the
intended transaction. Recovery is evidence-based, deterministic, idempotent,
and fail-closed when ambiguous. Git, the report, and the pending record remain
sufficient; no daemon, database, transaction manager, or external state
machine is introduced.

## Resume

After interruption, reconstruct state from the repository root, active
governance, branch, HEAD, remote, worktree, task report, status, plan, history,
tests, and code. Conversation memory is supplementary only.

Do not claim completion without a durable report and the evidence required by
the task contract.
