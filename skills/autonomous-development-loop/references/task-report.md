# Task Report

Write one durable Markdown report for every meaningful round. Use the template
and keep values factual and concise.

Required fields are:

```text
task_id
status
baseline
branch
final_commit
remote_verified
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
