---
name: autonomous-development-loop
description: Execute an approved Sol engineering task in any Git repository through autonomous inspection, implementation, testing, recovery, reporting, and safe commit/push. Read target-project governance first; do not use this for product ideation, browser automation, or unconstrained work.
metadata:
  short-description: Autonomous, evidence-driven Git task execution
---

# Autonomous Development Loop

Use this Skill when an approved, bounded Sol task must be carried through a
complete engineering loop in a Git repository. The default executor is Codex
GPT-5.6 Luna with medium reasoning.

This Skill is cross-project and contributes no project-specific rules. Read the
target repository's active governance, toolchain, architecture constraints,
protected paths, and project state before making decisions.

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
