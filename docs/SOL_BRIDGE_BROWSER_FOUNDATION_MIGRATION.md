# Sol Bridge Browser Foundation Migration Impact

Task: `SOL-BRIDGE-BROWSER-FOUNDATION-SPIKE-001`

Selected foundation:

```text
SELECT_PLAYWRIGHT_DIRECT
+
RETAIN_W2C_SOL_POLICY
```

This is an implementation-foundation choice. V1.1 identity, binding, read,
send, recovery, security, GitHub gate, and Luna ownership remain unchanged.

## Classification of existing W2C code

| Existing source | Classification | Impact |
|---|---|---|
| `src/main/edge/cdp.ts` | `REPLACE_WITH_PLAYWRIGHT` | Do not migrate the custom WebSocket transport into the final adapter. Keep its security/timeout lessons as acceptance constraints. |
| `src/main/edge/cdp-conversation.ts` | `REUSE_ALGORITHM` / `REPLACE_WITH_PLAYWRIGHT` | Reuse composer, submit, confirmation, and identity-check algorithms; implement page actions with Playwright locators and bounded waits. |
| `src/main/edge/state-adapter.ts` | `REUSE_ALGORITHM` | Retain selector knowledge and stable DOM sampling concepts; exclude Writing Block parsing, protocol readiness, and W2C classification. |
| `src/main/edge/profile.ts` | `RETAIN_AS_POLICY` / `REUSE_ALGORITHM` | Retain dedicated profile, ownership token, Edge-only, bounded startup, and fail-closed reuse policy. Replace process/window plumbing with Playwright persistent context plus a minimal ownership adapter. |
| `src/main/edge/session-binding.ts` | `RETAIN_AS_POLICY` | Keep only minimal Project/account/conversation binding and target hints. Do not migrate W2C rotation, raw input, workflow, or phase state. |
| `src/main/edge/url-security.ts` | `RETAIN_AS_POLICY` | Preserve allowed ChatGPT origins, local transport rules, HTTPS, and canonical conversation checks. |
| `src/main/state/persistence.ts` | `REUSE_ALGORITHM` | Reuse only the minimal temp flush/close/atomic replace/backup/recovery pattern already implemented for Bridge local transport state. Do not migrate the W2C persistence framework. |
| `src/main/edge/windows-window-controller.ts` | `DELETE_FROM_NEW_SKILL` | No focus, screen geometry, window visibility, or User32/Powershell dependency is needed by the browser adapter. |
| MainOrchestrator/CodexRunner/Electron IPC/dashboard/tray | `DELETE_FROM_NEW_SKILL` | These are W2C runtime/workflow layers and remain outside the Skill. |
| Writing Block/protocol/phase FSM/session rotation | `DEFER` | Not part of the browser foundation and not part of Sol Bridge V1.1. |

## Proposed final adapter layout

```text
sol-engineering-loop/
└── scripts/sol-bridge/
    ├── sol-bridge.mjs             # ensure/bind/read/send/status orchestration
    └── lib/
        ├── browser-playwright.mjs # Edge persistent context and page lifecycle
        ├── chatgpt-capture.mjs     # raw DOM facts only
        ├── identity-policy.mjs     # origin and identity tuple checks
        ├── binding.mjs              # minimal durable binding
        ├── delivery-recovery.mjs    # pending intent and A-D proof rules
        ├── security.mjs             # URL/transport restrictions
        └── io.mjs                   # minimal crash-safe local state
```

`browser-playwright.mjs` must expose mechanics, not decisions. It may return
raw page facts such as URL, text, message hashes, visible thinking state,
Project/account evidence, and composer/send evidence. It must not decide which
page is trusted, whether a Sol task was consumed, whether delivery is safe, or
whether a task is accepted.

## Dependency boundary

Playwright `1.63.0` is a Spike-only development dependency in this repository.
The Spike does not add Playwright MCP, Browser Use, an agent, a daemon, or a
scheduler. Before production adoption, the dependency must be explicitly
accepted as part of the next implementation task; this spike does not migrate
the current production Bridge automatically.

## What remains frozen

- Skill identity remains `sol-engineering-loop`.
- ADL Core remains intact.
- Luna remains the only workflow controller.
- Bridge commands remain `ensure`, `bind`, `read`, `send`, and `status`.
- Identity remains allowed origin plus Project/account/conversation tuple.
- Reading remains observation, not consumption, with bounded stable sampling.
- Sending persists intent before submit and proves a transport transition;
  ambiguous delivery remains `SEND_UNCONFIRMED` without auto-resend.
- GitHub remains the only durable project truth and notification remains gated
  on verified remote state.

No architecture decision is reopened by this migration analysis.

