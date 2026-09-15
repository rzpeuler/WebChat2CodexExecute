# Sol Bridge — V1.1 Design

Status: READY_FOR_V1.1_ARCHITECTURE_FREEZE
Date: 2026-09-15
Skill: `sol-engineering-loop`
Branch: `feat/adl-sol-bridge-v1.1`
Design base: `91f5cf2e2d476b1de6affe8e98355cd60844d0bc`

## 1. Goal

V1.1 gives Codex/Luna a safe, deterministic I/O bridge to the Web Chatbot
conversation used by Sol. Sol can provide a task and receive a concise review
notification without the user manually copying either the Sol task or the Luna
report.

V1.1 formally evolves the V1 Skill identity:

```text
autonomous-development-loop → sol-engineering-loop
```

`sol-engineering-loop` is the only final Skill. It contains the accepted ADL
Core and the new Sol Bridge. The rename is an architecture revision and a
whole-package migration, not a rewrite of the accepted ADL Core.

The bridge is not a second agent. It does not interpret Sol's text, choose an
implementation, manage an engineering phase, run Git, update governance, or
decide acceptance. Luna remains the controller of the complete engineering
loop. GitHub remains the only durable project-information channel that Sol
uses to inspect code, reports, ledger, governance, commits, and remote state.

## 2. Architecture and ownership

```text
                         ChatGPT Web
                              Sol
                         ↕ ordinary text
                       ┌─────────────┐
                       │ Sol Bridge  │
                       │ ensure      │
                       │ bind        │
                       │ read        │
                       │ send        │
                       │ status      │
                       └──────┬──────┘
                              │ bounded I/O
                       Codex / Luna
                              │ controller
               ┌──────────────┴──────────────┐
               │      sol-engineering-loop   │
               │ inspect / implement / test  │
               │ recover / report / Git      │
               └──────────────┬──────────────┘
                              │
                 local Git → verified push
                              │
                           GitHub
                              │
                     Sol reads project facts
```

### Sol Bridge owns

- dedicated Edge profile availability and CDP transport;
- allowed ChatGPT origin enforcement;
- live Project, account, and conversation identity verification;
- ordinary assistant text capture and stable sampling;
- composer discovery, message submission, and submission confirmation;
- minimal local binding state and redacted diagnostics;
- bounded I/O waits and deterministic error codes.

### Luna owns

- interpreting ordinary Sol text;
- deciding whether text is a new task, review, correction, governance issue,
  architecture decision, or ordinary explanation;
- all workflow control and next-action choice;
- repository inspection, implementation, tests, recovery, reporting, and Git;
- deciding whether a Sol response means acceptance or requires another round.

### GitHub owns durable project facts

Before Luna tells Sol that a task is ready for review, the implementation,
report, ledger updates, and final Git state must be pushed and verified. The
notification contains pointers and concise facts; Sol reads the complete
repository state from GitHub. A local binding file is not project truth.

## 3. Package boundary

The Bridge is a first-class sub-capability of the same Skill package because
Sol communication is the Skill's core purpose. The implementation is isolated
under `scripts/sol-bridge/` and has no imports from the W2C runtime.

```text
skills/sol-engineering-loop/
├── SKILL.md
├── references/
├── templates/
└── scripts/
    └── sol-bridge/
        ├── sol-bridge.mjs
        └── lib/
            ├── cdp.mjs
            ├── browser-profile.mjs
            ├── conversation.mjs
            ├── capture.mjs
            ├── binding.mjs
            └── io.mjs
```

The package is reusable across Git repositories. It does not assume W2C paths,
Electron, TypeScript, npm, Writing Block, a project-specific governance tree,
or a project-specific build command. V1.1's Bridge environment is explicitly
Microsoft Edge with localhost CDP on Windows; unsupported environments return a
deterministic error rather than weakening the security boundary.

### Rename and migration contract

The package migration is:

1. `skills/autonomous-development-loop/` becomes
   `skills/sol-engineering-loop/`.
2. `SKILL.md` frontmatter, references, templates, scripts, and tests use the
   `sol-engineering-loop` identity.
3. All accepted V1 ADL behavior and deterministic Git, governance, report, and
   recovery tools remain in the final package.
4. V1.1 adds only Sol I/O and its transport recovery records.
5. The old source and installed paths are removed after migration; two
   overlapping Skills are not supported.
6. No ADL Core rewrite, workflow-ownership change, or W2C runtime refactor is
   implied by the rename.

Luna remains the workflow owner throughout migration. The final package is
`sol-engineering-loop`, not a long-term pair of ADL and Bridge Skills.

## 4. CLI contract

The executable is one CLI with five commands. It follows the Skill's existing
tool convention: `node`, explicit `--input <json-file>`, JSON stdout, redacted
JSON diagnostics, and stable nonzero exit behavior. The exact command-line
parser is an implementation detail; the JSON contracts below are normative.

### `ensure`

Input contains a local state directory and explicit Edge configuration or
permitted defaults:

```json
{
  "state_dir": "<local Codex/Skill state directory>",
  "executable_path": "<optional>",
  "user_data_directory": "<dedicated persistent profile>",
  "remote_debugging_port": 9333,
  "initial_url": "https://chatgpt.com/"
}
```

The operation is:

```text
inspect configured profile
→ inspect local debugging endpoint
→ reuse only an ownership-matching Edge
→ otherwise launch owned dedicated Edge
→ verify CDP target availability
→ return browser and login facts
```

Success is shaped like:

```json
{
  "ok": true,
  "code": "BRIDGE_READY",
  "browser": "edge",
  "cdp_available": true,
  "login_required": false,
  "reused": true
}
```

First login is a deliberate human action. The Bridge never handles passwords,
OTP, MFA, or Captcha. If login is required, return `LOGIN_REQUIRED` and keep
the persistent profile for a later `ensure`.

### `bind`

`bind` requires a live, allowed ChatGPT page and optional expected identity
constraints. It must not select the first matching CDP target. Binding is
allowed only when an explicit expected conversation URL/target selection
identifies exactly one target, or when exactly one live target satisfies the
complete allowed-origin, Project, account, and conversation identity
constraints. Otherwise it returns `BINDING_AMBIGUOUS` and persists nothing.

When one target is uniquely identified, `bind` samples it and persists:

```json
{
  "version": 1,
  "project_fingerprint": "...",
  "account_fingerprint": "...",
  "conversation_id": "...",
  "conversation_url": "https://chatgpt.com/g/.../c/...",
  "conversation_title": "Sol",
  "target_id_hint": "...",
  "last_observed_assistant_hash": "...",
  "updated_at": "..."
}
```

The state is stored only under the local Codex/Skill state directory, not in
the target repository. `target_id_hint` is not authoritative because CDP
target IDs can change after a browser restart. Every later operation resolves
the live target again and verifies URL, conversation, Project, and account
identity.

Binding fails closed when any required identity is missing, unknown, or
conflicting. A bind never silently replaces an existing binding without an
explicit bind operation.

### `read`

Input may include:

```json
{
  "after_hash": "<optional previous assistant hash>",
  "wait_ms": 60000,
  "stable_sample_count": 2
}
```

The result returns ordinary assistant text and transport facts, not a task
classification:

```json
{
  "ok": true,
  "code": "ASSISTANT_OUTPUT_READY",
  "conversation_id": "...",
  "assistant_text": "...",
  "assistant_hash": "...",
  "is_thinking": false,
  "stable": true,
  "sampled_at": "...",
  "diagnostics": {
    "login_required": false,
    "network_error": false,
    "session_missing": false
  }
}
```

Stable output requires all of:

```text
isThinking == false
assistant_text is non-empty
assistant_hash is equal across stable_sample_count samples
```

The default stable sample count is `2`. Reading is observation, not
acknowledgement or consumption. The exact `read --after` contract is:

- no positive wait: if `after_hash` equals the current stable hash, return
  `NO_NEW_ASSISTANT_OUTPUT` immediately;
- positive bounded wait: if `after_hash` equals the current hash, continue
  polling until a new hash is stable and `isThinking == false`;
- deadline with no hash change: return `NO_NEW_ASSISTANT_OUTPUT`;
- deadline after a new hash appeared but never became stable/not-thinking:
  return `READ_TIMEOUT`.

The Bridge never waits indefinitely and never decides whether the text is a
task, review, correction, or acceptance.

The persisted hint is named `last_observed_assistant_hash`. It is used only for
diagnostics, polling optimization, and dedupe hints. It is not task-consumption
state. The required semantics are at-least-once Sol observation plus
idempotent Luna execution. Luna checks the repository, task report,
`CURRENT_STATUS`, `IMPLEMENTATION_HISTORY`, Git state, and verified GitHub
history to determine whether a task was executed. A read crash may therefore
cause safe re-observation, never silent loss or false consumption.

Capture uses DOM usability and `innerText → textContent` fallback. It does not
use `getBoundingClientRect`, screen visibility, window focus, minimization, or
occlusion as a validity gate. Hidden/minimized operation is therefore a
transport/runtime test condition, not a semantic shortcut.

### `send`

Input contains text and may include expected identity fields. The operation is:

```text
load local binding
→ ensure live allowed target
→ verify Project/account/conversation identity
→ locate usable composer
→ insert text
→ locate and click submit
→ confirm composer cleared or observable assistant/submission change
```

Success:

```json
{
  "ok": true,
  "code": "MESSAGE_SENT",
  "conversation_id": "...",
  "message_hash": "..."
}
```

If the message may have been submitted but confirmation is unavailable, return
`SEND_UNCONFIRMED`; never claim `MESSAGE_SENT`. Wrong Project, account, or
conversation returns `CONVERSATION_IDENTITY_CHANGED` and does not retry against
another target.

#### Pending delivery recovery

Before submission, persist this local transport-recovery record:

```text
version
conversation identity
message_hash
delivery_key
created_at
```

The send transaction is:

```text
persist pending delivery intent
→ submit message
→ confirm delivery
→ clear pending delivery record
```

If a process crashes after submission but before confirmation persistence, the
next invocation reloads the record, revalidates the bound conversation, and
captures only the latest bound-conversation user text/hash. If it matches the
pending `message_hash`, return `MESSAGE_ALREADY_DELIVERED` and clear the
record. If it cannot be proven, return `SEND_UNCONFIRMED` and do not send the
message again automatically. While the pending delivery remains unresolved,
`send` must not bypass it by submitting another message; it returns
`SEND_UNCONFIRMED` until an explicit recovery decision clears the record. This
evidence path never parses task semantics.

### `status`

`status` reports only live Bridge facts:

```json
{
  "ok": true,
  "browser_running": true,
  "cdp_available": true,
  "login_required": false,
  "bound": true,
  "project_matches": true,
  "account_matches": true,
  "conversation_matches": true,
  "sol_thinking": false
}
```

It never reports `RUNNING_TASK`, workflow phase, Git status, acceptance, or
next-task state.

## 5. Identity model

The binding identity is the tuple:

```text
allowed ChatGPT origin
+ Project fingerprint
+ account fingerprint
+ conversation ID and canonical URL
```

The current live target must match the tuple before `read` or `send`. A CDP
target ID is only a lookup hint. Missing identity is not equivalent to a match.

When multiple live targets have an allowed ChatGPT origin, `bind` must not
choose the first result. It may bind only through an explicit expected
conversation URL/target selection or when exactly one target satisfies the
complete identity tuple. Otherwise it returns `BINDING_AMBIGUOUS` and persists
nothing.

The Bridge must reject:

- non-HTTPS or non-ChatGPT origins;
- arbitrary browser URLs supplied by Sol message content;
- a different Project;
- a different account;
- a different conversation or navigation;
- a target with no usable CDP endpoint;
- malformed or ambiguous CDP responses.

## 6. Error taxonomy

The first implementation must expose stable codes in these families:

| Code | Meaning | Luna action |
|---|---|---|
| `ENVIRONMENT_UNSUPPORTED` | Edge/CDP environment is unavailable for V1.1 | Report environment blocker |
| `EDGE_EXECUTABLE_NOT_FOUND` | Configured/default Edge executable is absent | Request configuration or manual setup |
| `EDGE_PROFILE_OWNERSHIP_INVALID` | Existing endpoint is not owned by this profile | Stop; never attach |
| `CDP_UNAVAILABLE` | Endpoint cannot be reached or target list is invalid | Bounded retry, then report |
| `LOGIN_REQUIRED` | Manual login is required | Ask user to log in once |
| `BINDING_MISSING` | No local Sol binding exists | Require explicit bind |
| `BINDING_AMBIGUOUS` | Multiple allowed live targets cannot be uniquely identified | Require explicit target/URL selection |
| `IDENTITY_UNKNOWN` | Required Project/account/conversation identity is unavailable | Fail closed |
| `CONVERSATION_IDENTITY_CHANGED` | Live target no longer matches binding | Stop and require explicit rebind |
| `NO_NEW_ASSISTANT_OUTPUT` | `read --after` observed no new output | Luna may continue waiting or execute no action |
| `READ_TIMEOUT` | Bounded wait ended without stable output | Luna decides whether to retry |
| `SEND_UNCONFIRMED` | Submission cannot be proven | Do not duplicate automatically |
| `MESSAGE_ALREADY_DELIVERED` | Pending message matches latest bound-conversation user message | Clear pending delivery; do not resend |
| `CONTEXT_LIMIT` | ChatGPT reports a context limit | Luna decides; no automatic rotation in V1.1 |
| `SESSION_MISSING` | Conversation/session is unavailable | Luna decides; no hidden target switch |
| `NETWORK_ERROR` | Live page or CDP network failure | Bounded retry, then report |
| `MALFORMED_RESPONSE` | Browser/CDP data violates the contract | Fail closed and report |

Error messages must be concise and redacted. They must not include cookies,
tokens, passwords, OTPs, full storage contents, or sensitive URLs beyond the
validated conversation URL fields required for diagnosis.

## 7. Luna integration

`SKILL.md` will route Luna through the Bridge without embedding its
implementation. The canonical loop is:

```text
ensure Sol Bridge
→ read current Sol output
→ Luna interprets ordinary text
→ if it is an approved work package, execute sol-engineering-loop
→ update governance/ledger when required
→ safe-git-sync and verify GitHub remote
→ construct concise READY_FOR_SOL_REVIEW notification
→ send through Sol Bridge
→ remember current assistant hash as `last_observed_assistant_hash` only
→ read --after that hash
→ Luna interprets Sol's next response
```

The notification is intentionally short:

```text
READY_FOR_SOL_REVIEW

Task: <TASK_ID>
Branch: <branch>
Implementation: <C>
Remote HEAD: <D>
Report: <path>

Please inspect the repository and perform Sol acceptance.
```

The notification is sent only after the final remote tip has been verified.
Sol's next response is ordinary text. Luna decides whether it means:

- acceptance with no next task → stop and wait;
- acceptance with a next task → execute the next approved task;
- changes required → continue the current correction round;
- governance or architecture decision → follow target governance and authority;
- ordinary explanation → no workflow transition is inferred.

No `WAIT_SOL`, `PARSE_TASK`, `RUN_LUNA`, `SYNC_CODE`, or `NOTIFY_SOL` phase
machine is introduced. Those are agent-loop concepts, not Bridge state.

## 8. Browser and persistence lifecycle

`ensure` owns a dedicated persistent Edge profile with a unique ownership token
and localhost CDP port. It may reuse an existing process only after matching
executable, profile, port, ownership, and CDP evidence. An unrelated process on
the port is rejected.

The local binding state uses the smallest reliable persistence mechanism needed
for one JSON file:

1. validate input data before writing;
2. write a same-directory private temporary file;
3. flush and close the temporary file;
4. atomically replace the destination where supported;
5. use a Windows-safe backup/restore path when replace cannot overwrite;
6. load the backup only when the primary is missing or invalid and validate it;
7. retain diagnostic evidence when recovery was needed;
8. never persist binding state in the target repository.

This reuses the proven W2C persistence pattern without importing the W2C state
coordinator, event log, app lifecycle, or workflow state.

## 9. Testing strategy

Tests are isolated under a new Bridge suite and use fake CDP transports,
WebSockets, Edge process runners, filesystem state, and DOM snapshot results.
They must cover:

### Read

- latest stable assistant text and hash;
- thinking output not marked stable;
- no-wait unchanged `after_hash` returns immediately with
  `NO_NEW_ASSISTANT_OUTPUT`;
- bounded `after_hash` wait continues polling after an initial unchanged hash;
- no-change deadline and unstable-new-output deadline return different codes;
- bounded wait and timeout;
- hidden/minimized DOM usability without screen gates;
- empty assistant output;
- login wall, network error, missing session, and context limit;
- wrong Project, account, and conversation;
- ordinary prose containing Writing Block-like text remains ordinary text.

### Send

- contenteditable and textarea composer paths;
- composer unavailable;
- submit button unavailable;
- composer-cleared confirmation;
- assistant-change/thinking confirmation;
- unconfirmed submission;
- wrong target, Project, account, and conversation;
- no arbitrary URL navigation.

### Binding

- initial bind and persisted reload;
- target ID change with matching conversation identity;
- multiple allowed targets require explicit disambiguation or
  `BINDING_AMBIGUOUS`;
- identity change rejection;
- corrupt primary binding with valid backup recovery;
- corrupt primary and backup fail-closed;
- no credentials or raw conversation transcript in state.

### Observation and delivery recovery

- reading followed by a crash does not mark a Sol Task consumed;
- the persisted field is `last_observed_assistant_hash`, never a consumption
  marker;
- a crash after send and before confirmation persistence recovers the pending
  delivery;
- a matching latest user message returns `MESSAGE_ALREADY_DELIVERED` without a
  duplicate send;
- an unresolved pending delivery returns `SEND_UNCONFIRMED` without retrying;

### Browser

- owned Edge start;
- owned Edge reuse;
- unrelated process on the same port rejected;
- process exit invalidates stale lifecycle state;
- login required;
- bounded startup and CDP waits.

### End-to-end definition of done

After unit and repository tests pass, V1.1 requires one real Windows flow:

```text
Sol Web outputs task
→ Luna calls sol-bridge read
→ Luna receives task without manual copy
→ ADL executes task
→ GitHub is updated and verified
→ Luna calls sol-bridge send
→ Sol Web receives READY_FOR_SOL_REVIEW
```

This real flow is a release gate, not something that can be replaced by unit
test success alone. Credentials, MFA, Captcha, and any user-sensitive browser
action remain manual.

## 10. Non-goals

V1.1 does not add:

- a second Planner, daemon, scheduler, database, or orchestrator;
- a Bridge-owned workflow state machine;
- Writing Block parsing or protocol markers;
- automatic conversation creation or session rotation;
- direct Git commands inside Sol Bridge;
- governance mutation or Sol acceptance inside Sol Bridge;
- arbitrary browser URL control;
- password, OTP, MFA, or Captcha automation;
- W2C runtime deletion or refactoring;
- MCP, Plugin, Electron, or external Codex process dependencies;
- ETA, predicted completion, or model-estimated future timing.

## 11. Final V1.1 architecture decisions

The following decisions are closed and ready to freeze:

- `autonomous-development-loop` evolves into `sol-engineering-loop` as an
  architecture revision, with one final Skill containing ADL Core plus Sol
  Bridge.
- Every accepted V1 ADL capability and deterministic Git/governance/report
  tool remains in the final Skill; V1.1 adds only Sol I/O and transport
  recovery.
- Sol Bridge is a first-class capability of `sol-engineering-loop`.
- The Bridge exposes exactly `ensure`, `bind`, `read`, `send`, and `status`.
- Sol Bridge performs I/O and identity enforcement only; Luna controls meaning
  and workflow.
- GitHub remote verification is mandatory before Sol notification.
- The Bridge returns ordinary assistant text and never parses Writing Blocks.
- Reading never consumes or acknowledges a Sol message; binding state is local
  operational state and repository facts remain in Git/GitHub.
- `last_observed_assistant_hash` is only a diagnostics, polling, and dedupe
  hint; Luna uses durable repository evidence for idempotent execution.
- `read --after` is bounded and distinguishes no-change from unstable-new-
  output deadlines.
- `send` persists a local pending delivery intent before submission and never
  automatically resends an unresolved delivery.
- A matching latest user message resolves pending delivery as
  `MESSAGE_ALREADY_DELIVERED`.
- `bind` fails closed with `BINDING_AMBIGUOUS` when live targets cannot be
  uniquely identified.
- V1.1 targets owned Microsoft Edge plus localhost CDP on Windows.
- Context/session replacement is deferred; structured errors are sufficient.

### IMPLEMENTATION DETAIL

- Exact DOM selector arrays and selector priority.
- Target reacquisition algorithm after CDP target ID changes.
- JSON input-file parsing details and exit-code numbering.
- Exact local state-directory default resolution.
- Poll interval, timeout defaults, and WebSocket cleanup mechanics.
- Whether the isolated hidden-window adapter is needed after real dogfood.

### STILL REQUIRES ARCHITECTURE DECISION

None within the stated V1.1 scope. The design is ready for explicit V1.1
architecture freeze; implementation remains prohibited until that freeze is
accepted.

## 12. Architecture amendment closure

| Amendment | Final decision | Closure |
|---|---|---|
| A. Skill rename/migration | One final `sol-engineering-loop` retains ADL Core and adds Sol Bridge; old package paths are migrated and not retained as a second Skill. | Closed |
| B. Bounded `read --after` | No-wait unchanged hash returns `NO_NEW_ASSISTANT_OUTPUT`; bounded wait polls; no-change and unstable-new-output deadlines are distinct. | Closed |
| C. Observation versus consumption | Reading is not acknowledgement or consumption; `last_observed_assistant_hash` is only a hint; Luna uses durable repository evidence and idempotent execution. | Closed |
| D. Outbound delivery recovery | Persist pending intent before send; verify latest bound-conversation user hash after crash; return `MESSAGE_ALREADY_DELIVERED` or `SEND_UNCONFIRMED` without automatic duplicate send. | Closed |
| E. Multiple targets | Bind only with explicit disambiguation or one complete identity match; otherwise `BINDING_AMBIGUOUS`. | Closed |
| F. Regression coverage | The listed read, delivery, binding, rename-retention, and full ADL V1 tests are mandatory implementation gates. | Closed as a requirement |

No architecture issue remains open within the stated V1.1 scope.

## 13. Acceptance gate before coding

Coding may begin only after review confirms:

1. the integrated Skill boundary is correct;
2. GitHub is the mandatory Sol project-information channel;
3. Bridge/Luna/ADL/GitHub ownership is unambiguous;
4. no Writing Block or W2C runtime dependency is hidden in the extraction;
5. CLI and local-binding contracts are sufficient for deterministic tests;
6. the real Sol → Luna → GitHub → Sol flow is a required final gate.

This document is the V1.1 design artifact. It does not itself implement the
Bridge or modify the existing W2C runtime.
