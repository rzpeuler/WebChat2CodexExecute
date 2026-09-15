# Task Report

Write one durable Markdown report for every meaningful round. Use the template
and keep values factual and concise.

Required fields are:

```text
task_id
status
baseline
branch
implementation_commit
verified_remote_tip
sync_status
summary
tests
acceptance_criteria
governance_status
blockers
```

Also record changes, validation results, important design decisions, debugging
summary, remaining risks, scope deviations, task input quality, and information
resolved by Luna. Do not include private reasoning, credentials, or full shell
output.

Use `READY_FOR_SOL_REVIEW`, `BLOCKED`, or `FAILED_UNRECOVERABLE` as terminal
statuses. A failed test is evidence and should be recorded accurately; it is
not automatically a blocker.

Before synchronization, use `implementation_commit: pending`,
`verified_remote_tip: pending`, and `sync_status: READY_TO_SYNC`. After the
implementation commit has been pushed and verified, `safe-git-sync` creates a
separate report-finalization commit and changes the report to
`implementation_commit: <C>`, `verified_remote_tip: <C>`, and
`sync_status: SYNCED`. The report deliberately does not record the
report-finalization commit because doing so would require a self-referential
commit hash. The current remote HEAD is always the remote branch tip returned
by Git.
