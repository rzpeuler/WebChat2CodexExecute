---
name: sol-engineering-loop
description: Execute an approved Sol engineering task in any Git repository through autonomous inspection, implementation, testing, recovery, reporting, and safe commit/push. Read target-project governance first; do not use this for product ideation, browser automation, or unconstrained work.
metadata:
  short-description: Autonomous, evidence-driven Git task execution
---

# Sol Engineering Loop

Use this Skill when an approved, bounded Sol task must be carried through a
complete engineering loop in a Git repository. The default executor is Codex
GPT-5.6 Luna with medium reasoning.

This Skill is cross-project and contributes no project-specific rules. Read the
target repository's active governance, toolchain, architecture constraints,
protected paths, and project state before making decisions.

The final package is `sol-engineering-loop`. It contains the ADL Core and the
optional Sol Bridge. The Bridge is a deterministic transport boundary for a
dedicated Microsoft Edge localhost-CDP profile; it has no dependency on the
WebChat2CodexExecute runtime, Electron, Edge CDP session objects, Writing
Blocks, or screen/focus state.

## Role boundary

Sol owns product direction, architecture decisions, governance decisions, task
scope, acceptance criteria, and the next top-level task.

Luna owns repository inspection, engineering decomposition, implementation,
debugging, testing, recovery, acceptance evidence, factual project-state
updates, and normal Git decisions.

Deterministic tools enforce repository identity, path safety, governance
structure, report shape, and Git preconditions/postconditions. They do not
decide product intent, architecture, task completion, or governance authority.

## Required loop

1. Inspect repository root, branch, HEAD, remote, worktree, active governance,
   and target-project status/plan/history.
2. Reconstruct durable facts and assess task readiness. Fill ordinary missing
   engineering details from the repository; stop only for material product or
   architecture ambiguity.
3. Decompose internally by dependency and execute the highest-value next
   action.
4. Implement, test, diagnose, and recover without asking for routine approval.
5. Validate every acceptance criterion, changed path, required artifact, and
   scope deviation.
6. Write the durable task report and update factual operational ledger files
   when their state changed. Never write private reasoning or predicted time.
7. Run the deterministic checks and `safe-git-sync`.
8. Stop at `READY_FOR_SOL_REVIEW`, `BLOCKED`, or
   `FAILED_UNRECOVERABLE`. Do not invent the next top-level task.

## Sol Bridge routing

When a task requires Sol I/O, Luna remains the only workflow owner. The Bridge
only exposes `ensure`, `bind`, `read`, `send`, and `status` through
`scripts/sol-bridge/sol-bridge.mjs` and enforces browser identity, stable DOM
capture, bounded polling, and transport recovery. It never interprets task
meaning, acknowledges a task, owns a planner, or decides acceptance.

Use the loop in this order when Sol I/O is needed:

1. `ensure` the owned Edge/CDP environment and handle manual login.
2. `bind` one fully identified Project/account/conversation target.
3. `read` ordinary text using an explicit `after_hash` and bounded `wait_ms`.
   Reading is observation only; it is never message consumption.
4. Interpret and execute the Sol task through ADL Core and the target
   repository's governance.
5. Validate, sync, verify the GitHub/remote durable truth, then use `send` for
   a compact review notification if required. A pending send is recovered by
   transport evidence and is never automatically resent when ambiguous.
6. Persist `last_observed_assistant_hash` only as a diagnostics/polling hint.

Bridge state is local transport material only. Workflow truth remains in the
repository task report, `CURRENT_STATUS`, `IMPLEMENTATION_HISTORY`, and Git.
Do not add a second Planner, daemon, scheduler, or orchestration layer.

## Blocker boundary

Continue autonomously through ordinary compile errors, test failures, type
errors, API mistakes, adjacent support-file needs, and implementation bugs.
Use bounded retries with materially new evidence or strategy; do not repeat an
unchanged failing attempt.

Block only for missing external authority/credentials, unsafe or irreversible
operations, unresolved governance or architecture decisions, unrecoverable
remote divergence, persistent unavailable dependencies without a safe
alternative, or a credible data-loss/security risk. Preserve safe progress and
report the exact blocker.

## Governance routing

Use the target project's configured governance entry point. If none is
established, `docs/governance/governance-manifest.yaml` is the default bootstrap
convention, not a universal requirement. Preserve compatible project-specific
governance and reconcile conflicts by authority; never replace a whole
governance directory for convenience.

Read [references/governance-and-project-state.md](references/governance-and-project-state.md)
for adoption, authority, the canonical Sol prompt, and the project ledger.

## Reference routing

- Read [references/task-contract.md](references/task-contract.md) for Sol task
  input and readiness.
- Read [references/execution-and-recovery.md](references/execution-and-recovery.md)
  for failure classes, no-progress detection, and resume.
- Read [references/git-safety.md](references/git-safety.md) before commit/push
  or uncertain remote recovery.
- Read [references/task-report.md](references/task-report.md) before writing
  the durable report.
- Read [references/sol-task-authoring-guide.md](references/sol-task-authoring-guide.md)
  when authoring or repairing a Sol task for Luna medium.

## Deterministic tools

All tools use Node.js 20+, standard-library-only ESM scripts, explicit JSON
input, JSON output, and stable nonzero exit codes. Invoke them with `node` and
an `--input <json-file>` argument. Tool output is evidence, not workflow state.

Available tools:

- `scripts/inspect-baseline.mjs`
- `scripts/validate-governance.mjs`
- `scripts/check-protected-paths.mjs`
- `scripts/validate-task-report.mjs`
- `scripts/verify-remote.mjs`
- `scripts/safe-git-sync.mjs`

Pass target-project-specific protected paths, governance paths, report paths,
branch, baseline, and required artifacts explicitly. Never assume paths from a
different project.
