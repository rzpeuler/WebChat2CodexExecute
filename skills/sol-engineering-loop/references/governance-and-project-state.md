# Governance and Project State

## Target-project adoption

First locate the target project's explicit governance entry point. If none is
authoritative, use `docs/governance/governance-manifest.yaml` as the default
bootstrap convention. Do not treat a normal README as authoritative merely
because it exists.

Apply exactly one adoption case:

- No governance: inspect the repository, propose the minimal compatible
  governance entry point, and bootstrap only when the task or authority allows
  it. Do not invent product policy.
- Compatible governance: preserve the existing entry point and rules; register
  only missing ADL evidence or ledger documents that the project accepts.
- Conflicting governance: identify the authoritative rule and exact conflict,
  preserve unrelated project content, and stop the conflicting change when no
  authority resolves it.

Preserve compatible project rules. For conflicts, identify authority, preserve
non-conflicting content, update only stale rules, revise the manifest/changelog,
update the canonical Sol prompt if needed, and validate. Never replace a whole
governance directory for convenience.

## Authority

```text
platform/safety → current user → current Sol decision → active repository
governance → current task → history → ordinary docs → conversation memory
```

The target repository owns its toolchain, architecture, release rules,
protected paths, milestones, and product direction. The generic Skill owns only
cross-project safety and execution invariants.

## Dual Sol channel

The target repository may maintain `SOL_PROJECT_PROMPT_CANONICAL.md` as the
canonical text for the user-managed ChatGPT Project prompt. Luna can update
that file but must never claim to have changed the ChatGPT Project itself. A
governance change that affects Sol's role, task authoring, Luna assumptions,
architecture responsibility, acceptance, or task granularity emits
`SOL_PROMPT_SYNC_REQUIRED` with the new revision.

## Ledger

- `CURRENT_STATUS.md`: short current snapshot.
- `PROJECT_EXECUTION_PLAN.md`: milestones, dependencies, statuses, and next
  planned work; never a planner or scheduler.
- `IMPLEMENTATION_HISTORY.md`: append-only factual round history; no private
  reasoning or complete command transcripts.
- `GOVERNANCE_CHANGELOG.md`: normative governance change record.

Time fields are observational only. Record actual start, completion,
interruption, block, and measured duration. Never add ETA or model-estimated
duration for future work.
