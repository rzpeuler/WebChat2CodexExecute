# Sol Bridge — W2C Capability Extraction Mapping

Status: V1.1 ARCHITECTURE FROZEN
Date: 2026-09-15
Source repository: `WebChat2CodexExecute`
V1.1 branch: `feat/adl-sol-bridge-v1.1`
V1.1 design base: `6fd0cf3f604bb28d852dcc19739b03594ba50d04`

## Purpose and boundary

This document records which proven W2C capabilities can support the Sol Bridge
in V1.1. The current W2C runtime remains operational and is not deleted,
refactored, or rewired by this mapping.

The target is one reusable Codex Skill, `sol-engineering-loop`, whose core
purpose is to let Codex/Luna communicate with Sol through a Web Chatbot while
using GitHub as Sol's durable project-information channel. The Skill remains
usable for arbitrary Git repositories: project-specific governance, commands,
paths, and acceptance rules continue to come from the target repository.

V1.1 is an architecture revision of the accepted V1 Skill identity:

```text
autonomous-development-loop → sol-engineering-loop
```

There is one final Skill, not two overlapping Skills. The final package
contains both the retained ADL Core and the new Sol Bridge. The rename is not a
replacement of the ADL Core and does not authorize rewriting its accepted
contracts or deterministic tools.

## V1 Skill migration

The migration is a whole-package identity migration:

1. Rename the canonical source directory from
   `skills/autonomous-development-loop/` to `skills/sol-engineering-loop/`.
2. Update `SKILL.md` frontmatter and all documentation, tests, references,
   templates, and script paths to the new name.
3. Keep every V1 ADL reference, template, and deterministic
   Git/governance/report tool in the final package.
4. Add only the V1.1 Sol I/O capability under
   `skills/sol-engineering-loop/scripts/sol-bridge/`.
5. Remove the old source and installed paths after migration; do not retain a
   second discoverable Skill with overlapping behavior.
6. Do not rewrite or re-scope the accepted ADL Core to accommodate the Bridge.

The migration changes package identity and routing only. Luna remains the
workflow owner; deterministic tools remain safety/evidence enforcement; the
existing V1 Git finalization, governance, report, and recovery semantics stay
intact.

The target responsibility boundary is:

```text
Sol Web
  ↕ read / send ordinary assistant text
Sol Bridge
  ↕ bounded, identity-checked I/O
Luna / Codex
  ↕ interpretation, workflow control, engineering decisions
sol-engineering-loop
  ↕ repository safety, implementation, testing, recovery, reporting
local Git → verified push → GitHub
  ↕ durable code, reports, ledger, and commit facts
Sol reads GitHub
```

Sol Bridge is eyes and mouth. Luna is the only loop controller. GitHub is the
only durable project-information channel available to Sol. The Bridge never
decides task meaning, task completion, governance authority, or Git outcome.

## Existing evidence

The inspected W2C modules are:

- `src/main/edge/cdp.ts`
- `src/main/edge/cdp-conversation.ts`
- `src/main/edge/state-adapter.ts`
- `src/main/edge/profile.ts`
- `src/main/edge/session-binding.ts`
- `src/main/edge/url-security.ts`
- `src/main/edge/types.ts`
- `src/main/edge/windows-window-controller.ts`
- `src/main/edge/session-rotation.ts`
- `src/main/state/persistence.ts`

The principal tests are in `test/unit/phase-three-edge.test.ts` and
`test/unit/phase-seven-session-recovery.test.ts`. They are migration evidence,
not a test suite to copy wholesale. Current repository governance does not
contain a committed `docs/governance` tree; the V1 freeze and migration
documents are the local architecture evidence for this design phase.

## Capability mapping

| W2C source | V1.1 classification | Reuse decision | V1.1 destination or action |
|---|---|---|---|
| `edge/cdp.ts` / `HttpCdpTransport` | `EXTRACT` | Reuse the transport contract, target listing, `Runtime.evaluate`, CDP command calls, localhost WebSocket validation, bounded HTTP/WebSocket waits, malformed-response rejection, and close behavior. Re-express in standalone ESM. | `skills/sol-engineering-loop/scripts/sol-bridge/lib/cdp.mjs` |
| `edge/cdp-conversation.ts` / `sendMessage` path | `EXTRACT WITH SIMPLIFICATION` | Preserve URL, Project, account, and conversation checks; composer discovery; `Input.insertText`; submit-button discovery; composer-cleared or assistant-change confirmation; deterministic unconfirmed-send error. Remove conversation-recovery and W2C orchestration coupling. | `conversation.mjs` and `send` command |
| `edge/cdp-conversation.ts` / `createConversation` path | `DEFER` | V1.1 binds an existing conversation. Automatic same-Project conversation creation is not required and must not be introduced as hidden recovery. | Revisit only in V1.2 after dogfood evidence |
| `edge/state-adapter.ts` / DOM usability and capture | `EXTRACT WITH SIMPLIFICATION` | Retain `innerText → textContent` fallback, connected/visible DOM checks, latest assistant text, SHA-256 hash, thinking signals, login/error diagnostics, URL-derived Project identity, and stable sampling. | `capture.mjs` |
| `edge/state-adapter.ts` / Writing Block and protocol layer | `DELETE FROM BRIDGE` | Do not retain `extractWritingBlockTail`, marker normalization, `parseWritingBlocks`, `protocolReady`, user-message markers, protocol diagnostics, final-answer candidate semantics, or consumability classification. Luna interprets ordinary text. | No replacement parser |
| `edge/profile.ts` / executable discovery | `EXTRACT` | Retain explicit Edge executable validation and Windows discovery. | `browser-profile.mjs` |
| `edge/profile.ts` / dedicated profile and ownership | `EXTRACT WITH MINIMAL LIFECYCLE` | Retain dedicated user-data directory, remote debugging port, ownership token, persistent login profile, owned-process reuse, ownership verification, bounded startup, and process-exit invalidation. | `browser-profile.mjs` and `ensure` command |
| `edge/profile.ts` / window controller calls | `OPTIONAL ISOLATED ADAPTER` | Hidden/background operation is required as a capability, but PowerShell/User32 window manipulation is not part of the Bridge contract. Do not import Electron lifecycle or focus-stealing behavior. | Keep behind a narrow platform adapter only if needed by real dogfood |
| `edge/session-binding.ts` / identity binding | `EXTRACT WITH REDUCTION` | Retain persistent Project, account, conversation, URL, identity evidence, and `last_observed_assistant_hash`. Revalidate identity on every read/send. | `binding.mjs` |
| `edge/session-binding.ts` / raw input and recovery fields | `DELETE FROM BINDING` | Do not persist raw Sol messages, context-recovery attempts, rotation keys, pause state, or workflow status in Bridge state. | Luna and repository report/ledger own those facts |
| `edge/session-rotation.ts` | `DEFER` | Do not port the rotation state machine or automatic replacement conversation flow. | Structured `CONTEXT_LIMIT` / `SESSION_MISSING` errors only |
| `edge/url-security.ts` | `REUSE` | Preserve allowed ChatGPT origins, localhost CDP hosts, secure URL parsing, and known-identity checks. | `lib/security.mjs` or `binding.mjs` |
| `edge/types.ts` | `REFERENCE ONLY` | Use the useful identity and transport concepts, but do not carry W2C protocol/status types into the Bridge API. | New small JSON schemas/contracts |
| `edge/index.ts` | `DO NOT PORT` | The barrel export is a W2C TypeScript module, not a Skill runtime boundary. | CLI imports local `.mjs` modules explicitly |
| `state/persistence.ts` / `AtomicJsonFileStore` | `REUSE PATTERN ONLY` | Preserve temp write, flush, atomic replace, Windows-safe backup/recovery, permissions, and corruption diagnostics. Do not copy the full W2C persistence framework or state coordinator. | Minimal `io.mjs` for local binding state |
| `windows-window-controller.ts` | `OPTIONAL / OUT OF CORE` | No arbitrary window management, focus stealing, or Electron window lifecycle. Any hidden-window helper must be narrowly scoped and independently testable. | Platform adapter only if required |
| W2C `MainOrchestrator` | `DELETE FROM TARGET` | Do not port phases, polling loop, notification workflow, recovery state machine, or Sol semantic parsing. | Luna native loop guided by `SKILL.md` |
| W2C `CodexRunner` | `DELETE FROM TARGET` | Do not port process spawning or external Codex session transport. | Current Codex host executes Luna directly |
| W2C Electron IPC/dashboard/tray | `DELETE FROM TARGET` | Not a Skill responsibility. | CLI JSON output and Codex task context |
| Existing W2C edge tests | `SELECTIVE MIGRATION EVIDENCE` | Retain behavioral intent for transport, identity, composer, hidden DOM, profile ownership, and error cases. Do not retain Writing Block assertions. | New isolated Bridge tests |

## Reusable behavior versus non-reusable behavior

### Reusable behavior

The extraction may preserve these invariants:

1. Only `https://chatgpt.com`, `www.chatgpt.com`, `chat.openai.com`, and
   `www.chat.openai.com` are valid ChatGPT origins.
2. CDP WebSocket endpoints must use a local host and the configured port.
3. Target, Project, account, and conversation identity are checked before
   sending a message.
4. A send is successful only after a concrete submission confirmation.
5. DOM capture must work while the owned Edge window is hidden or minimized;
   screen geometry, focus, and occlusion are not output-validity gates.
6. Network waits, socket waits, browser startup, and read waits are bounded.
7. Local binding state is redacted operational state and is not committed to the
   target project.

## Observation is not consumption

Reading Sol is an observation only. It never acknowledges, consumes, reserves,
or marks a Sol Task as executed.

The local field is named `last_observed_assistant_hash` and has only these
uses:

- diagnostics;
- polling optimization;
- a dedupe hint for Luna.

It is never task-consumption state. The required delivery model is:

```text
at-least-once Sol observation
+
idempotent Luna execution
```

Luna determines whether a task was executed by inspecting the durable
repository facts: the task report, `CURRENT_STATUS`,
`IMPLEMENTATION_HISTORY`, Git state, and verified GitHub history. If a process
crashes after reading Sol, the next run may observe the same output again; it
must not silently discard it because a local hash was updated.

The frozen invariant is:

> Reading a Sol message does not acknowledge or consume it.

Outbound and inbound guarantees are deliberately asymmetric:

```text
Sol → Luna
at-least-once observation
+ idempotent execution

Luna → Sol
persist intent before send
+ prove transport transition
+ never auto-resend ambiguous delivery
```

## Bounded `read --after` semantics

The Bridge has two distinct read modes.

### No wait

With no positive wait deadline:

```text
after_hash == current stable hash
→ NO_NEW_ASSISTANT_OUTPUT
```

The command returns immediately after the current observation is classified as
stable. The Bridge does not infer task meaning.

### Bounded wait

With `after_hash == current hash` and `wait_ms > 0`, the Bridge continues
polling until the deadline. It returns `ASSISTANT_OUTPUT_READY` only when all
of the following hold:

```text
new assistant hash
+
stable sample sequence
+
isThinking == false
```

At the deadline, distinguish the two outcomes:

- the hash never changed → `NO_NEW_ASSISTANT_OUTPUT`;
- a new hash appeared but never became stable/not-thinking → `READ_TIMEOUT`.

The wait is always bounded. Luna decides whether to call `read` again.

### Explicitly non-reusable W2C behavior

The Bridge must not inherit:

- Writing Block parsing or marker counting;
- `protocolReady`, `UNCONSUMABLE_CANDIDATE`, or W2C status classification;
- user-message extraction or protocol envelope handling;
- W2C phase transitions, `MainOrchestrator`, or `CodexRunner`;
- Electron app lifecycle, IPC, dashboard, tray, or notification state;
- automatic session rotation or context replay;
- Git commands or project governance mutation;
- any rule that assumes W2C's directory layout, npm scripts, TypeScript, or
  product behavior.

## Proposed package boundary

The Bridge is a first-class capability inside the same Skill package because
communication with Sol is the Skill's core purpose. Its implementation remains
internally separated from the generic engineering method:

```text
skills/sol-engineering-loop/
├── SKILL.md                         # Luna routing and ownership
├── references/                      # task, governance, recovery, Git rules
├── templates/                       # task and report shapes
└── scripts/
    └── sol-bridge/
        ├── sol-bridge.mjs           # one CLI, five commands
        └── lib/
            ├── cdp.mjs              # transport only
            ├── browser-profile.mjs  # owned Edge profile only
            ├── conversation.mjs     # identity, composer, send confirmation
            ├── capture.mjs          # ordinary assistant text capture
            ├── binding.mjs           # local binding state only
            └── io.mjs                # bounded local persistence only
```

The core Skill remains Git-project reusable because the Bridge has no project
paths, product rules, or W2C runtime imports. Edge/ChatGPT availability is an
execution-environment capability reported by `ensure` and `status`, not a
target-project assumption.

## External interface mapping

The only public Bridge commands are:

```text
sol-bridge ensure
sol-bridge bind
sol-bridge read
sol-bridge send
sol-bridge status
```

The CLI uses explicit JSON input and machine-readable JSON output, consistent
with the existing Skill tool contract. Subcommands are intentionally narrow:

- `ensure`: start or reuse only an owned dedicated Edge profile and verify CDP
  and ChatGPT availability.
- `bind`: inspect a selected live ChatGPT page, verify allowed origin, Project,
  account, and conversation identity, then persist only local binding state.
- `read`: return the latest stable ordinary assistant text, hash, thinking flag,
  identity, timestamp, and redacted diagnostics; support `after_hash` and a
  bounded wait.
- `send`: revalidate the persisted binding and live identity, submit text, and
  return success only after confirmation.
- `status`: report browser/CDP/login/binding/identity/thinking facts; never
  report ADL workflow state.

## Outbound delivery recovery

`send` has a transport-level crash boundary. Before submission, persist a small
local pending-delivery record:

```text
version
conversation identity
message_hash
delivery_key
pre_send_latest_user_hash
created_at
```

The record is local recovery material only. It is not workflow state, task
state, acceptance state, Git state, or a durable project artifact.

The send transaction is:

```text
revalidate binding
→ capture latest user-message transport state
→ persist pending delivery intent including pre-send baseline
→ submit message
→ confirm composer/assistant delivery evidence
→ clear pending delivery record
```

If the process crashes after submission but before confirmation state is
persisted, the next Bridge invocation must reload the pending record, revalidate
the origin, Project, account, and conversation, and capture only the current
latest bound-conversation user text/hash as transport evidence.

The minimum proof rule is a post-intent transport transition, not content
equality alone:

| Recovery case | Evidence | Result |
|---|---|---|
| A — message appeared | `current_latest_user_hash == message_hash` and `pre_send_latest_user_hash != message_hash` | Return `MESSAGE_ALREADY_DELIVERED`; clear pending |
| B — still pre-send state | `current_latest_user_hash == pre_send_latest_user_hash` and `current_latest_user_hash != message_hash` | Return `SEND_UNCONFIRMED`; retain pending; never auto-resend |
| C — identical pre-existing content | `pre_send_latest_user_hash == message_hash` | Return `SEND_UNCONFIRMED`; hash alone cannot prove a new message |
| D — unexpected later content | Current hash is neither the pre-send baseline nor the pending message hash | Return `SEND_UNCONFIRMED`; do not overwrite, guess, or auto-resend |

If a stronger, validated user-message identity is available, it may supplement
the hash proof. V1.1 does not require a DOM sequence database, message ledger,
or new state machine. While unresolved, `send` must not bypass the pending
record by submitting another message. The Bridge never parses the message as a
task or decides whether Luna should continue.

## Multiple live targets

`bind` must fail closed when more than one live target has an allowed ChatGPT
origin. It may bind only when:

- an explicit expected conversation URL or target selection identifies exactly
  one target; or
- exactly one target satisfies the complete Project, account, and conversation
  identity constraints.

Otherwise it returns `BINDING_AMBIGUOUS`. It must never select the first target
returned by CDP or silently bind a different conversation.

## Boundary risks requiring test evidence

- ChatGPT DOM selectors are external and may change; selector configuration is
  an implementation detail, while fail-closed behavior is architectural.
- Account identity may be unavailable on a page; unknown identity must reject
  binding/send rather than weaken verification.
- CDP target IDs may change after restart; conversation URL/ID and Project/account
  identity are the durable binding, with target ID treated only as a hint.
- A send may have taken effect even when confirmation is lost; return
  `SEND_UNCONFIRMED`, never a false success.
- Login, MFA, Captcha, expired accounts, and missing sessions require user/Luna
  handling; no credentials are automated.
- The final Sol notification is valid only after GitHub remote verification.

## Additional V1.1 regression requirements

The new Bridge tests must prove:

- `read --after H --wait` does not return merely because the first sample is
  still `H`;
- no-change and unstable-new-output deadlines return different codes;
- a crash after read does not mark a Sol Task consumed;
- send persists `pre_send_latest_user_hash` before submission;
- a crash after send and before confirmation persistence recovers the pending
  delivery;
- the four pending-delivery cases distinguish a real post-intent transition,
  pre-send state, identical pre-existing content, and unexpected later content;
- only a proven transition returns `MESSAGE_ALREADY_DELIVERED` without a
  duplicate send;
- every ambiguous pending delivery returns `SEND_UNCONFIRMED` without a retry;
- ambiguous multi-target bind returns `BINDING_AMBIGUOUS`;
- the renamed package retains all ADL V1 tests and tools.

This mapping is complete for the requested V1.1 extraction scope. It authorizes
no implementation by itself; the amended design contract in
`SOL_BRIDGE_V1_1_DESIGN.md` must be reviewed before coding.
