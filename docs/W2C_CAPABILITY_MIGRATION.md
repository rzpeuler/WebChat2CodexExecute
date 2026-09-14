# W2C Capability Migration

Status: Design-stage analysis only  
Date: 2026-09-15  
Repository baseline: `feat/luna-autonomous-development-skill` at `37c54b1`

## Purpose

This document maps the current Web Chat 2 Codex (W2C) capabilities to the target
Codex-native Autonomous Development Loop (ADL) model. The classifications are
target ownership decisions, not permission to delete or refactor the current
runtime during this design phase.

The current `WebChat2CodexExecute` workspace is the migration and analysis
subject only. It is not the target project contract. The final ADL Skill must
be reusable in arbitrary Git repositories and must not assume this repository's
Electron, TypeScript, npm, Edge, W2C paths, governance wording, or product
rules. Project-specific rules belong to the adopted target repository's active
governance, not to the generic Skill package.

The target model is:

```text
Sol = product, architecture, governance, task authoring, acceptance
Luna = engineering orchestration, implementation, debug, test, recovery, Git
Tools = deterministic safety and evidence checks
GitHub = durable project truth
```

## Classification rules

- `LUNA_NATIVE`: Luna's existing agent loop should perform the reasoning or
  decision; no external workflow engine should reproduce it.
- `SKILL`: reusable behavior rules, contracts, governance guidance, templates,
  or reporting conventions.
- `DETERMINISTIC_TOOL`: small, composable, testable checks or operations whose
  result must not depend on an agent's interpretation.
- `DELETE`: W2C-specific transport, UI, browser, process orchestration, or
  duplicated state-machine behavior with no ADL runtime role.

## Current evidence

The current implementation has the following relevant boundaries:

- `src/main/orchestration/orchestrator.ts` is a large external workflow engine
  covering Sol observation, protocol parsing, update application, Luna
  execution, Git synchronization, notification, retry, and recovery.
- `src/main/codex/codex-runner.ts` contains both W2C process transport and
  valuable validation logic for reports, repository snapshots, protected paths,
  and scope review.
- `src/main/git/git-controller.ts` already captures repository identity,
  branch, HEAD, worktree, remote tip, protected paths, pending pushes, and
  post-push verification.
- `src/main/governance/manifest.ts` and
  `src/main/governance/canonical-text-hash.ts` provide reusable manifest,
  path-safety, canonical-text, and SHA-256 behavior.
- `src/main/project/initializer.ts` currently installs W2C-specific governance
  documents and Writing Block templates into a target project. Those templates
  are evidence of existing safety patterns, not the ADL governance contract.
- The current repository does not contain a committed `docs/governance`
  directory; it is generated for adopted projects by the W2C initializer.

This evidence is intentionally repository-local. It identifies reusable
algorithms and W2C-specific responsibilities; it does not define the final
Skill's supported project layout.

## Capability mapping

| Current capability / module | Target classification | Reuse decision | V1 need | Replacement or destination |
|---|---|---|---|---|
| `MainOrchestrator` workflow and phase machine | `DELETE` | Do not port the class or phase graph | No | Luna's native loop guided by `SKILL.md` and references |
| Orchestrator task decomposition and next-action choice | `LUNA_NATIVE` | Preserve as behavior, not code | Yes | Luna's internal plan and evidence-driven next action |
| Orchestrator retry and recovery reasoning | `LUNA_NATIVE + SKILL` | Extract policy and failure taxonomy only | Yes | `references/execution-and-recovery.md` |
| `CodexRunner` process spawning and Luna session transport | `DELETE` | Do not retain external Codex process control | No | The current Codex runtime is already Luna's execution host |
| Codex result/report/path validation | `DETERMINISTIC_TOOL` | Extract and simplify validated checks | Yes | `validate-task-report`, `check-protected-paths` |
| Codex repository snapshot comparison | `DETERMINISTIC_TOOL` | Reuse baseline comparison semantics | Yes | `inspect-baseline`, `safe-git-sync` preflight |
| Codex scope-review prompt and approval reasoning | `SKILL` | Retain the rule; remove W2C prompt transport | Yes | Scope-deviation guidance and report evidence |
| `GitController.captureBaseline` | `DETERMINISTIC_TOOL` | Direct algorithm candidate | Yes | `inspect-baseline` |
| `GitController.verifyBaseline` | `DETERMINISTIC_TOOL` | Direct algorithm candidate | Yes | `safe-git-sync` preflight |
| `GitController.readRepositoryStatus` | `DETERMINISTIC_TOOL` | Direct algorithm candidate | Yes | Baseline and post-operation evidence |
| `GitController.syncCode` / `syncGovernance` | `DETERMINISTIC_TOOL` | Reuse safety semantics, not Electron ports | Yes | `safe-git-sync` with explicit inputs |
| `GitController.recoverPendingPushes` and pending-push state | `DETERMINISTIC_TOOL` | Preserve uncertain-push state semantics | Yes | `safe-git-sync` recovery record |
| Git protected/sensitive path matching and output redaction | `DETERMINISTIC_TOOL` | Directly preserve and test | Yes | `check-protected-paths` and shared tool library |
| `GovernanceManifestStore` | `DETERMINISTIC_TOOL` | Reuse validation and safe document indexing | Yes | `validate-governance` |
| `hashCanonicalGovernanceText` / `canonicalizeGovernanceText` | `DETERMINISTIC_TOOL` | Directly reuse semantics | Yes | Governance reconciliation precondition |
| Governance change/reconciliation appliers | `DETERMINISTIC_TOOL + SKILL` | Tool applies safe content; Skill decides authority and scope | Yes | Explicit governance reconciliation workflow |
| Project initializer path checks and backup discipline | `DETERMINISTIC_TOOL` | Reuse path and backup principles selectively | Yes for adoption | ADL governance bootstrap/adoption helper |
| Project initializer's W2C standard documents | `DELETE` | Do not copy W2C role or protocol assumptions | No | ADL-specific governance templates |
| Writing Block parser and template protocol | `DELETE` | Do not make ADL depend on Sol DOM/marker transport | No | Plain Sol Task Contract plus repository files |
| `AtomicJsonFileStore`, `AtomicTextFileStore`, file locks | `DETERMINISTIC_TOOL` | Reuse crash-safe persistence patterns where needed | Yes, selectively | Atomic ledger/report writes; no app state machine |
| State coordinator and W2C top-level state machine | `DELETE` | Do not port runtime state transitions | No | Durable repository facts and task report |
| Edge/CDP/profile/session rotation | `DELETE` | No browser dependency in ADL | No | Direct Codex task input |
| Sol prompt compiler and Web Chat message transport | `SKILL + DELETE` | Convert policy to authoring guide; delete transport | Yes as guidance | Sol authoring guide and canonical prompt |
| Electron dashboard, notifications, IPC, tray lifecycle | `DELETE` | Not a Skill responsibility | No | Final report and Codex UI output |
| Existing W2C unit tests | `SKILL` reference | Use as migration evidence; do not wholesale port | Partial | New isolated ADL scenario tests |

## Concrete source reuse candidates

The following functions and classes are the strongest implementation references
for a later V1 tool extraction:

### Git and repository safety

- `GitController.captureBaseline`
- `GitController.verifyBaseline`
- `GitController.readRepositoryStatus`
- `GitController.commitAndPushProject`
- `GitController.recoverPendingPushes`
- `PersistentGitPendingPushState`
- The local path normalization, protected-path matching, sensitive-path
  detection, remote-tip comparison, and output-redaction helpers in
  `src/main/git/git-controller.ts`

`commitAndPushProject` should not be copied as a monolithic W2C service. Its
preconditions, uncertain-push handling, and post-push assertions should be
re-expressed as a CLI tool with explicit machine-readable input and output.

### Governance and canonical text

- `validateGovernanceManifest`
- `indexGovernanceManifest`
- `GovernanceManifestStore.load` and `readDocument`
- `normalizeGovernanceText`
- `hashCanonicalGovernanceText`
- `canonicalizeGovernanceText`
- Safe staging, expected-content checks, and backup behavior from
  `GovernanceReconciliationApplier`

The agent, not the tool, must decide which document is authoritative and
whether a policy change is authorized.

### Path and persistence safety

- `isPathWithinProject`
- `resolveProjectPath`
- `AtomicJsonFileStore`
- `AtomicTextFileStore`
- `withSharedStateTransactionLock`

These are useful safety patterns. The W2C dashboard state model and its phase
transitions are not part of the target Skill.

### Report and execution evidence

The report-path validation, result-status aggregation, test-status validation,
repository snapshot checks, and scope-drift evidence in `CodexRunner` should be
split into deterministic checks and a Skill-level reporting contract. The
current `LUNA_RESULT` Writing Block envelope itself is not retained.

## Migration boundary

The migration must not:

- delete or refactor W2C runtime code as part of Skill design;
- preserve Edge, CDP, Electron, Writing Block, or external-Codex assumptions in
  ADL;
- move product or architecture decisions into deterministic scripts;
- make `safe-git-sync` decide whether a task is complete;
- create a second planner, daemon, scheduler, task database, or orchestrator.

The later implementation should begin with a standalone Skill package and
isolated tools. W2C can remain operational until a separate, explicitly
authorized migration task removes it.
