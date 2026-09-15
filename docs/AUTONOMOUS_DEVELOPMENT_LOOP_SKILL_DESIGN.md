# Autonomous Development Loop Skill Design

Status: Design-stage proposal  
Date: 2026-09-15  
Skill name: `sol-engineering-loop`
Executor: Codex GPT-5.6 Luna, reasoning `medium`

## Goal

Give Luna a reusable, Codex-native method for completing a bounded Sol
engineering work package with low human intervention, durable evidence, safe
Git synchronization, and repository-based recovery.

The Skill is cross-project by design. This `WebChat2CodexExecute` repository is
only the migration source used to identify reusable capabilities. The final
Skill must work with arbitrary Git repositories and must not contain W2C's
Electron, TypeScript, npm, Edge, CDP, Writing Block, directory, or product
assumptions.

The Skill supplies rules, contracts, references, templates, and deterministic
tools. It does not create a new agent, daemon, scheduler, browser transport,
Electron application, Writing Block protocol, or external Orchestrator.

## Generic Skill versus target-project governance

The package contains only cross-project behavior:

- autonomous execution and recovery rules;
- task and report contracts;
- authority and scope boundaries;
- secret and protected-path safety principles;
- deterministic Git preconditions and postconditions;
- repository-based resumption semantics.

The adopted target repository supplies project-specific behavior:

- language, framework, package manager, and test commands;
- repository layout and build conventions;
- architecture and security constraints;
- release and deployment policy;
- project-specific protected paths and required artifacts;
- milestone and product direction.

ADL reads those rules from the target repository's active governance. It may
use `docs/governance` as the default convention, but the generic Skill must not
hard-code W2C's governance files or require a W2C-shaped project.

## Trigger and exclusions

The Skill applies when a user provides a Sol work package or asks Luna to carry
an approved repository task through inspection, implementation, testing,
debugging, reporting, commit, and push.

It should not trigger for:

- product or architecture brainstorming before a task exists;
- a one-off explanation or code snippet that does not require repository work;
- direct ChatGPT Web, Edge, CDP, or Electron automation;
- inventing the next top-level product task after current acceptance;
- broad unconstrained requests with no objective or safe boundary.

## Role model

```text
Sol
  WHAT / WHY / BOUNDARY / ARCHITECTURAL DECISIONS / CONSTRAINTS / ACCEPTANCE

Luna
  HOW / DECOMPOSE / IMPLEMENT / DEBUG / TEST / RECOVER / VALIDATE

Deterministic tools
  Repository identity / paths / governance / report / Git safety evidence
```

Luna owns normal engineering decisions and must not ask for approval for
routine implementation, adjacent support files, ordinary test strategy, or
debugging. Sol retains product, frozen architecture, governance, and final
acceptance authority.

## Proposed file tree

```text
sol-engineering-loop/
├── SKILL.md
├── references/
│   ├── sol-task-authoring-guide.md
│   ├── task-contract.md
│   ├── execution-and-recovery.md
│   ├── git-safety.md
│   ├── governance-and-project-state.md
│   └── task-report.md
├── templates/
│   ├── sol-task-template.md
│   └── task-report-template.md
└── scripts/
    ├── inspect-baseline.*
    ├── validate-governance.*
    ├── check-protected-paths.*
    ├── validate-task-report.*
    ├── verify-remote.*
    └── safe-git-sync.*
```

`SKILL.md` stays short: trigger, roles, loop, blocker boundary, completion
definition, reference routing, and tool routing. Detailed policy belongs in
references. The first implementation should use the smallest script set that
preserves the safety invariants; `safe-git-sync` is required as a V1 design
capability but must remain a deterministic operation, not a workflow engine.

## Standard execution loop

```text
Receive Sol Task
→ Read active governance
→ Check governance consistency
→ Inspect repository, branch, HEAD, remote, and worktree
→ Read CURRENT_STATUS, PROJECT_EXECUTION_PLAN, and relevant history/report
→ Reconstruct current project state
→ Assess task readiness
→ Decompose internally by dependency
→ Implement the highest-value next action
→ Test, diagnose, and recover
→ Validate acceptance criteria and scope
→ Write durable task report
→ Update operational ledger documents when facts changed
→ Reconcile governance only when authorized or mechanically required
→ Update canonical Sol prompt when governance affects Sol
→ Run deterministic safety checks
→ Commit and push safely
→ Verify remote branch equals pushed commit
→ READY_FOR_SOL_REVIEW
```

The loop is an agent behavior principle, not a rigid software state machine.
Luna may change implementation strategy when evidence changes, while preserving
task scope and frozen decisions.

## Sol Task Contract

The default input is a human-readable task contract, not a Writing Block. It
must contain:

```text
TASK_ID
TITLE
OBJECTIVE
WHY
BASELINE
CURRENT_STATE
REQUIRED_BEHAVIOR
SCOPE
OUT_OF_SCOPE
ARCHITECTURAL_DECISIONS
IMPLEMENTATION_FREEDOM
ACCEPTANCE_CRITERIA
VALIDATION
PROTECTED_CONSTRAINTS
EXPECTED_ARTIFACTS
KNOWN_RISKS
BLOCKING_CONDITIONS
```

Sol authors the outcome and boundary for Luna medium. Luna may search the
repository to fill in file locations, package commands, and implementation
facts. A task is blocking only when missing information would create materially
different product or architecture outcomes.

## Failure and recovery policy

### Recoverable transaction boundary

Local Git commits and pending-state persistence form a recoverable transaction
boundary. A process crash may occur between any two filesystem or Git
operations. On restart, ADL reconstructs state only when repository, report,
branch, commit ancestry, path scope, and remote facts uniquely establish the
intended transaction. Recovery is evidence-based, deterministic, idempotent,
and fail-closed when ambiguous. Git, the report, and the pending record remain
sufficient; no daemon, database, transaction manager, or external state
machine is introduced.

| Failure class | Luna V1 behavior |
|---|---|
| Recoverable engineering failure | Diagnose root cause, change strategy, continue |
| Transient external failure | Bounded retry with backoff and an alternative path where reasonable |
| Environment configuration blocker | Try existing tools, safe installation, mock, or non-core bypass before blocking |
| Governance blocker | Stop the conflicting part, preserve safe progress, report exact conflict |
| Architecture decision required | Block with the competing outcomes and required decision |
| Unsafe operation | Do not perform it; report the exact risk and required authorization |
| No progress | Record failure signature and evidence; require materially new evidence or strategy before retry |

Normal test failure is evidence, not an automatic blocker. Luna must not loop
the same failing command without a new diagnosis or strategy. A failed
implementation with valid evidence may be reported for Sol review; false
completion is not acceptable.

## Governance and project state

Luna begins from the target project's configured active governance manifest,
using `docs/governance/governance-manifest.yaml` only as the default convention,
or performs the three-case adoption flow described in
`GOVERNANCE_ARCHITECTURE_REVIEW.md` when governance is absent, compatible, or
conflicting.

Normative governance controls how agents work and requires explicit authority
for policy changes. Operational documents record project facts and may be
updated during a normal round:

```text
CURRENT_STATUS.md
PROJECT_EXECUTION_PLAN.md
IMPLEMENTATION_HISTORY.md
GOVERNANCE_CHANGELOG.md
```

Ledger updates are factual only. Time fields are observational: record actual
start, completion, interruption, block, and measured duration; never add ETA or
model-estimated duration for future work.

The canonical Sol prompt is maintained at:

```text
docs/governance/SOL_PROJECT_PROMPT_CANONICAL.md
```

If a governance change affects Sol's role, task authoring, Luna assumptions,
architecture responsibility, acceptance, or task granularity, update the
canonical file and revision, then emit `SOL_PROMPT_SYNC_REQUIRED`. Never claim
that the ChatGPT Project Custom System Prompt was changed.

## Deterministic tool contracts

### `inspect-baseline`

Returns machine-readable repository root, branch, HEAD, remote name and URL,
remote tip, worktree state, and a normalized baseline identifier. It rejects
unsafe roots, unexpected remotes, invalid branches, and unresolved repository
identity.

### `validate-governance`

Validates manifest syntax, active document paths, status/version fields,
canonical prompt metadata, revision references, safe UTF-8 text, and required
ledger structure. It does not decide policy content.

### `check-protected-paths`

Checks changed paths against project-outside, `.git`, governance, architecture,
credential, secret, and other configured protected patterns. It reports exact
paths and never silently filters an unsafe change.

### `validate-task-report`

Checks required report fields, task identity, baseline, status, tests, acceptance
evidence, changed paths, blockers, and scope deviations. It rejects missing,
unsafe, binary, or mismatched report files.

### `verify-remote`

Fetches without rewriting local history and returns the observed remote branch
tip, branch identity, and relationship to the expected commit. Unknown remote
state remains unknown.

### `safe-git-sync`

This is a deterministic safety operation with explicit input; it is not the
agent's workflow owner. It must:

1. verify the expected repository and branch;
2. verify the supplied baseline;
3. fetch the remote;
4. compare the expected remote tip;
5. detect protected and sensitive paths;
6. confirm required report and operational-state changes;
7. create implementation commit `C` with a `READY_TO_SYNC` report;
8. push `C` without force or history rewriting and verify remote `C`;
9. finalize the report in a separate commit `D` with the verified `C` facts;
10. push `D` without force and verify the remote branch equals `D`;
11. return a machine-readable result with redacted diagnostics.

Luna decides when the task is complete, which changes are reasonable, and how
to resolve a remote advance. The tool enforces preconditions and postconditions.

## Pending push recovery

V1 retains the following semantic model:

```text
local commit = C
baseline remote = B
push result = uncertain
```

On recovery:

| Observed remote | Meaning | Action |
|---|---|---|
| `C` | Push succeeded | Mark synchronized and clear pending state |
| `B` | Push did not take effect | Re-verify preconditions and retry safely |
| neither `B` nor `C` | Remote changed independently | Do not overwrite; inspect/integrate or block |
| unknown | Cannot establish outcome | Keep uncertain; do not assume success or failure |

The implementation may store this as a small JSON record rather than the W2C
runtime state model.

## Task report

Every meaningful round produces a durable report containing:

```text
task_id
status
objective
baseline
branch
implementation_commit
verified_remote_tip
sync_status
summary
changes
tests
validation_results
acceptance_criteria with evidence and status
important_design_decisions
debugging_summary
remaining_risks
governance_status
scope_deviations
blockers
task_input_quality
missing_information_resolved_by_luna
sol_review_notes
```

Supported terminal statuses are `READY_FOR_SOL_REVIEW`, `BLOCKED`, and
`FAILED_UNRECOVERABLE`. The report contains engineering facts and evidence,
not private reasoning or complete shell transcripts.

## V1 acceptance scenarios

The V1 implementation validates at least:

1. a normal bounded task completes without routine confirmation;
2. compile, typecheck, and test failures trigger autonomous diagnosis;
3. a long task is internally decomposed and completed in dependency order;
4. an absent governance directory is adopted safely;
5. compatible governance is preserved without meaningless rewrites;
6. conflicting governance is reconciled only when authority is clear;
7. a policy change updates changelog, revision, and canonical prompt status;
8. protected or sensitive changes are rejected with exact paths;
9. remote advancement is never overwritten;
10. uncertain push outcomes follow the `B`/`C` semantics above;
11. interruption resumes from repository facts and durable reports;
12. successful synchronization leaves the finalized report recoverable from the
    remote branch tip;
13. completion stops at `READY_FOR_SOL_REVIEW` and does not invent the next task.

## V1 non-goals

V1 introduces no MCP requirement, plugin requirement, Electron dependency,
Edge/CDP dependency, Writing Block parser, task database, scheduler, daemon,
second Planner, multi-agent orchestration, or direct ChatGPT Project prompt
mutation.

## Decision classification after V1 freeze

### FROZEN

- The package source is `skills/sol-engineering-loop/`; installation is
  a separate packaging action.
- Deterministic tools are Node.js 20+ ESM `.mjs` scripts using the standard
  library, explicit JSON I/O, positional Git arguments, and stable results.
- Sol owns product, architecture, governance, task scope, and acceptance;
  Luna owns the engineering loop; tools enforce safety facts only.
- An explicit authoritative governance entry point is preserved; the default
  bootstrap convention is `docs/governance/governance-manifest.yaml`.
- Implementation commit `C` is pushed and verified before a separate report
  finalization commit `D`; the report records `C` and the verified tip `C`, not
  `D`, so no report/Git self-reference is created.
- Pending recovery distinguishes expected previous tip, local commit, remote
  divergence, and unknown remote state; force push and silent overwrite remain
  forbidden.

### IMPLEMENTATION_DETAIL

- Personal versus repository distribution is a packaging choice outside the
  runtime contract.
- The shared `scripts/lib/` modules and CLI wrappers implement the frozen tool
  responsibilities.
- The minimal manifest fields, adoption bootstrap commit grouping, and the
  target project's policy for co-committing ledger updates are configurable
  repository details.
- The pending JSON record and its Windows-safe atomic replacement/backup
  fallback are local recovery details.

### STILL_REQUIRES_ARCHITECTURE_DECISION

None for V1. Any change to ownership, portability, governance separation, tool
responsibilities, two-commit report finalization, or uncertain-push semantics
requires a new architecture decision and freeze revision.
