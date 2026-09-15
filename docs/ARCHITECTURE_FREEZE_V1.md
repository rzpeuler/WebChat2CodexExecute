# Autonomous Development Loop — V1 Architecture Freeze

Status: **FROZEN**  
Freeze date: 2026-09-15  
Freeze branch: `feat/luna-autonomous-development-skill`  
Freeze baseline: `37c54b1`  
Repository under analysis: `WebChat2CodexExecute`

## Freeze intent

This is the formal V1 architecture boundary for the Autonomous Development
Loop (ADL). `WebChat2CodexExecute` is the migration and analysis source only.
The delivered Skill is a reusable Codex Skill for arbitrary Git repositories;
it is not a W2C feature and must not inherit W2C-specific product, directory,
Electron, TypeScript, npm, Edge, CDP, or Writing Block assumptions.

The freeze authorizes implementation of the Skill package and deterministic
tools described here. It does not authorize deletion or refactoring of the
existing W2C runtime.

## Frozen ownership model

```text
Sol
  Product direction, architecture, governance decisions, task contract,
  acceptance, and next top-level task

Luna / Codex
  Repository inspection, engineering decomposition, implementation, debug,
  tests, recovery, acceptance evidence, project-state maintenance, Git choice

Deterministic tools
  Repository identity, paths, governance structure, report shape, Git
  preconditions, push outcome classification, and postconditions

Repository / GitHub
  Durable project facts, reports, ledger, governance, code, and commits
```

No external Orchestrator, second Planner, daemon, scheduler, task database,
browser transport, or multi-agent workflow is introduced.

## Frozen package boundary

The canonical, versioned Skill source is:

```text
skills/autonomous-development-loop/
```

This repository is the distribution source for the package. Installing the
package into a Codex-recognized personal or organization Skill directory is a
separate packaging action. The package itself contains no W2C-specific rules.

The target project contributes its own active governance, technical commands,
architecture constraints, protected paths, release policy, and product state.
Those rules are read at execution time and are never embedded in the generic
Skill.

## Frozen runtime choices

- Skill instructions are Markdown with required `SKILL.md` frontmatter.
- Detailed behavior is progressively disclosed through `references/`.
- Reusable task and report shapes are in `templates/`.
- Deterministic tools are Node.js ESM `.mjs` scripts using Node.js 20 or newer
  and the standard library only.
- Tools communicate through explicit JSON input and machine-readable JSON
  output. Diagnostics are redacted and exit codes are stable.
- Tools never invoke a shell; Git commands use positional argument arrays.
- Tool code is generic and receives target-project paths, policies, and expected
  values as inputs.

## Frozen governance boundary

The Skill discovers an explicit, safe, authoritative governance entry point in
the target project. If none is established, the default bootstrap convention
is:

```text
docs/governance/governance-manifest.yaml
```

This default is not a universal hard-coded project requirement. Existing
project conventions are preserved when they are explicit and authoritative.

The generic Skill owns only cross-project invariants:

- authority resolution;
- task scope and protected-operation boundaries;
- secret handling;
- evidence and report requirements;
- repository-based recovery;
- deterministic Git safety.

The target project owns language/toolchain commands, repository layout,
architecture and release rules, project-specific protected paths, milestones,
and product goals.

Governance is divided into:

- Normative governance: rules for how agents work; changes require explicit
  authority or mechanically resolvable reconciliation.
- Operational state: `CURRENT_STATUS.md`, `PROJECT_EXECUTION_PLAN.md`, and
  `IMPLEMENTATION_HISTORY.md`; Luna maintains factual updates during a round.
- `GOVERNANCE_CHANGELOG.md`: an append-only record of normative changes.

The canonical Sol prompt is maintained in the target project's governance as
`SOL_PROJECT_PROMPT_CANONICAL.md`. Updating it never means that the ChatGPT
Project Custom System Prompt was updated. Affected changes emit
`SOL_PROMPT_SYNC_REQUIRED` and the new revision.

## Frozen execution contract

```text
Receive Sol Task
→ Read active target-project governance
→ Check governance consistency
→ Inspect repository / branch / HEAD / remote / worktree
→ Read target-project status, plan, history, and relevant reports
→ Reconstruct facts and assess readiness
→ Decompose internally
→ Implement / test / debug / recover
→ Validate acceptance criteria and scope
→ Write a READY_TO_SYNC task report and factual ledger updates
→ Run deterministic safety checks
→ Create and push implementation commit C through safe-git-sync
→ Verify remote C
→ Finalize the report in a separate commit D and verify remote D
→ READY_FOR_SOL_REVIEW
```

The loop is agent-native behavior, not a software state machine. Luna stops
only for genuine authority, safety, external-access, or unrecoverable-state
blockers, and never invents the next top-level task.

## Frozen tool set

```text
inspect-baseline
validate-governance
check-protected-paths
validate-task-report
verify-remote
safe-git-sync
```

Each tool has one deterministic responsibility. `safe-git-sync` composes
precondition and postcondition checks, but it does not decide task completion,
scope reasonableness, architecture, or conflict resolution.

### `safe-git-sync` invariants

The tool must verify, in order:

1. expected repository root and branch;
2. expected local baseline HEAD;
3. expected remote tip after fetch/query;
4. protected and sensitive changed paths;
5. required report and explicitly requested state paths;
6. commit creation without force or history rewriting;
7. push without force;
8. remote branch tip after a second fetch/query.

It returns a machine-readable result and never hides an unsafe path or remote
state.

## Frozen uncertain-push semantics

For implementation commit `C` and baseline remote `B`, the first push uses
`B` as its expected previous tip. After `C` is verified, report finalization
creates commit `D` and the second push uses `C` as its expected previous tip:

| Observed remote | Meaning | Required result |
|---|---|---|
| local phase commit | Push succeeded | Advance to the next phase; clear pending only after finalization commit is verified |
| expected previous tip | Push did not take effect | Retryable push state; retain local commit and pending record |
| neither expected tip nor phase commit | Independent remote advance/divergence | Refuse overwrite; require inspect/integrate or block |
| unknown | Outcome cannot be verified | Preserve uncertain state; do not claim success |

The pending record is local recovery material and must never be staged as a
project change.

## Frozen task and report boundary

The Skill accepts a human-readable Sol Task Contract with objective, why,
baseline, current state, required behavior, scope, out-of-scope,
architecture decisions, implementation freedom, acceptance criteria,
validation, protected constraints, expected artifacts, risks, and blocking
conditions.

The durable Task Report records facts and evidence, including task identity,
status, baseline, branch, implementation commit, verified remote tip, sync
status, tests, acceptance evidence, decisions, debugging summary, risks,
governance status, scope deviations, blockers, and input-quality feedback. A
pre-sync report uses `implementation_commit: pending`,
`verified_remote_tip: pending`, and `sync_status: READY_TO_SYNC`. The verified
final report records `implementation_commit: C`,
`verified_remote_tip: C`, and `sync_status: SYNCED`. It does not record the
report-finalization commit D because that would require a self-referential
commit hash. The current remote HEAD is the remote branch tip returned by Git.
The report never records private reasoning or full command transcripts.

Completion statuses are:

```text
READY_FOR_SOL_REVIEW
BLOCKED
FAILED_UNRECOVERABLE
```

Time fields are observational only: actual start, completion, interruption,
block, and measured duration may be recorded; ETA and model-estimated duration
are forbidden.

## Frozen V1 non-goals

V1 does not include:

- W2C runtime deletion or refactoring;
- Electron, Edge, CDP, ChatGPT Web, or Writing Block integration;
- MCP or Plugin packaging;
- a project-specific governance template copied from W2C;
- a task scheduler, daemon, planner, database, or multi-agent coordinator;
- automatic product planning after Sol acceptance;
- force push, destructive reset, unsafe rebase, or silent remote overwrite.

## Freeze change control

Any change to ownership, package portability, governance separation, tool
responsibilities, uncertain-push semantics, or V1 non-goals requires a new
architecture decision and a new freeze revision. Normal implementation detail,
test additions, and narrow tool hardening do not reopen this freeze.
