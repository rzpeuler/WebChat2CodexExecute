# Governance Architecture Review

Status: Design-stage analysis only  
Date: 2026-09-15  
Target: `sol-engineering-loop`

## Review objective

Define how ADL enters an existing Git project, establishes or adopts durable
governance, maintains the Sol/Luna contract, and records project progress
without becoming a second orchestration system.

The `WebChat2CodexExecute` repository is only the migration reference used by
this review. ADL is a generic Skill for other Git projects. It must not embed
W2C-specific paths, Electron/TypeScript/npm assumptions, Writing Block rules,
Edge behavior, or project-specific product and architecture decisions.

The repository is the durable source of truth. Conversation history is useful
context only and must not be the primary recovery mechanism.

## Findings about current W2C governance

The current W2C initializer installs `docs/governance` with a manifest,
`README.md`, `PROJECT_RULES.md`, `DEVELOPMENT_WORKFLOW.md`, `AGENT_ROLES.md`,
`GIT_POLICY.md`, and Writing Block templates. The manifest and file replacement
logic are safety-conscious, but the content still assumes:

- an automation layer owns the workflow;
- Sol emits Writing Blocks;
- Edge and ChatGPT Web are part of execution;
- an external Codex runner is responsible for Luna transport.

ADL must reuse the safety mechanisms while replacing those role assumptions.
Existing project-specific governance must never be overwritten merely because
it is not shaped like the W2C template.

## Governance adoption cases

### Case A — No governance

When the target project's configured governance entry point is absent (with
`docs/governance` as the default convention):

1. Inspect the repository root, build files, CI files, security files, and
   project-specific policy documents.
2. Treat ordinary `README` or contributor documentation as context, not
   authoritative governance, unless an explicit repository rule says otherwise.
3. Infer only technical facts that can be verified from the repository.
4. Create a minimal ADL governance set adapted to the detected language,
   package manager, test runner, and architecture.
5. Create the manifest at the selected governance entry point as the single
   active-document registry.
6. Create the three project-state ledger documents and canonical Sol prompt.
7. Validate paths, manifest entries, internal references, and consistency.
8. Commit the bootstrap as a distinct, reviewable governance change.

The bootstrap must not copy W2C Writing Block, Edge, external Orchestrator, or
Electron assumptions.

### Case B — Existing compatible governance

When governance exists and is compatible:

1. Preserve existing documents and project-specific rules.
2. Identify missing ADL capabilities rather than rewriting equivalent content.
3. Add only the missing manifest, role, task-authoring, Git, report, or ledger
   pieces.
4. Keep existing terminology when it does not change the authority model.
5. Validate active documents and cross-document consistency.
6. Record only meaningful changes in `GOVERNANCE_CHANGELOG.md`.

Idempotent adoption is a requirement: a second adoption pass with no changed
facts must produce no meaningless rewrite.

### Case C — Existing conflicting governance

When existing rules conflict with a current authoritative decision:

```text
inspect
→ identify authority
→ classify each conflict
→ preserve non-conflicting content
→ update only stale rules
→ update manifest and revision
→ append governance changelog
→ update canonical Sol prompt when affected
→ validate
```

The agent may resolve mechanical inconsistencies when authority is clear. A
real policy conflict with two materially different safe outcomes is a blocker.
The agent must never replace the entire governance directory or weaken a rule
to make implementation easier.

## Authority model

ADL uses this default hierarchy:

```text
Platform / safety constraints
→ explicit current user decision
→ explicit current Sol architecture or governance decision
→ active authoritative repository governance
→ current Sol task
→ historical implementation records
→ ordinary project documentation
→ conversation memory
```

The target project's formal governance may refine this order, but the active
manifest must identify the applicable authority entry point and revision. If
two active documents disagree and no authority rule resolves them, execution
stops for that conflict only.

## Dual-channel Sol constraint

Sol is constrained through two channels:

```text
Channel A: repository governance
Channel B: user-maintained ChatGPT Project Custom System Prompt
```

The repository must maintain:

```text
docs/governance/SOL_PROJECT_PROMPT_CANONICAL.md
```

This file is the canonical text that the user may manually copy into the
ChatGPT Project. ADL may update the file, its revision, and its compatibility
metadata. ADL must not claim that the ChatGPT Project prompt was changed.

If governance changes affect Sol's role, Luna assumptions, task authoring,
architecture responsibility, acceptance, or task granularity, the result must
include:

```text
SOL_PROMPT_SYNC_REQUIRED
```

and the new canonical prompt revision. The user's manual synchronization is a
separate action.

## Manifest and document classes

The target project's governance manifest is the only active-source registry.
`docs/governance/governance-manifest.yaml` is the default location, not a
universal hard-coded requirement. A project-specific established governance
entry point may be preserved when it is explicit, safe, and authoritative.
Each registered document should carry an id, path, audience, version, status,
and type. Paths must remain project-internal and safe.

The generic Skill owns only cross-project invariants such as authority
resolution, secret handling, scope discipline, evidence requirements, and
safe recovery. The target repository owns language/toolchain commands,
directory conventions, architecture constraints, release policy, and other
project-specific rules through its active governance.

### Normative governance

These documents define how agents must work:

- `AGENT_ROLES.md`
- `AUTONOMY_POLICY.md`
- `SOL_TASK_AUTHORING_GUIDE.md`
- `GIT_POLICY.md`
- `TESTING_POLICY.md`
- `ARCHITECTURE_GOVERNANCE.md`, when the project needs a separate architecture
  authority document
- `GOVERNANCE_CHANGE_POLICY.md`
- `SOL_PROJECT_PROMPT_CANONICAL.md`

Luna may change these only for an explicit user decision, explicit Sol
governance/architecture decision, an explicitly authorized task, or a
mechanically resolvable reconciliation.

### Operational project state

These documents record facts and may be maintained as part of a normal task:

- `CURRENT_STATUS.md`
- `PROJECT_EXECUTION_PLAN.md`
- `IMPLEMENTATION_HISTORY.md`
- `GOVERNANCE_CHANGELOG.md` for the record of normative changes

Operational updates must not silently change product direction, milestone
goals, priorities, or frozen architecture.

## Project State Ledger

### `CURRENT_STATUS.md`

Keep this short. It records current stage, current task, latest completed work,
current blocker, branch/HEAD, and the next recommended action.

### `PROJECT_EXECUTION_PLAN.md`

This is a human-readable roadmap, not a planner, scheduler, database, or
second agent. It records milestones, task statuses, dependencies, priority or
order, current workstream, blockers, and next planned work.

### `IMPLEMENTATION_HISTORY.md`

This is append-oriented engineering history. Each meaningful round records the
task, objective, actual outcome, changes, tests, commit, important decisions,
problems, resolutions, remaining risks, and plan impact. It must not contain
private reasoning, chain-of-thought, full command logs, or every failed attempt.

### Time semantics

Time fields are observational, never predictive.

- Planned tasks record status, dependency, milestone, and priority/order only.
- Started work may record actual `started_at`.
- Completed work may record actual `completed_at`.
- Blocked or interrupted work may record actual `blocked_at` or
  `interrupted_at`.
- Duration is recorded only when measured from reliable execution events.

Never add ETA, estimated duration, predicted completion, planned start time, or
model-estimated hours for work that has not happened.

## Governance reconciliation invariants

Every reconciliation must:

1. capture the current repository and document state;
2. identify the authority and exact conflict;
3. preserve unrelated project-specific content;
4. verify expected file hashes before replacement;
5. use safe staging and recoverable backups;
6. update manifest/revision and changelog where applicable;
7. update canonical Sol prompt and flag manual sync when required;
8. validate the resulting manifest, paths, references, and policy consistency.

The deterministic tool may reject unsafe paths, invalid hashes, invalid UTF-8,
binary content, missing manifest entries, or unsafe backups. It must not decide
which product or policy outcome is correct.

## Adoption validation matrix

| Scenario | Required result |
|---|---|
| No governance | Minimal ADL governance is created at the selected/default entry point and validated without W2C assumptions |
| Compatible governance | Existing rules are preserved; only missing capabilities are added |
| Conflicting governance | Authority and conflicts are reported; only safe, authorized reconciliation is applied |
| Repeated adoption | No meaningless rewrite or revision churn |
| Canonical prompt affected | File and revisions update; `SOL_PROMPT_SYNC_REQUIRED` is emitted |
| Ledger-only change | Operational documents update without policy changes |
| Interrupted run | State is reconstructed from repository facts and durable reports |
| Invalid or unsafe governance file | Fail closed with a concrete path, reason, or hash diagnostic |

## Design boundary

This review defines the target governance architecture only. It does not
modify the current W2C initializer, install governance into another project,
delete current runtime files, or change Electron behavior.
