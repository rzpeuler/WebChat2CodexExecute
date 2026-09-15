# Sol Bridge Browser Foundation Evaluation

Task: `SOL-BRIDGE-BROWSER-FOUNDATION-SPIKE-001`

Status: implementation-detail spike; V1.1 Sol Bridge architecture remains
frozen.

## Decision

```text
SELECT_PLAYWRIGHT_DIRECT
+
RETAIN_W2C_SOL_POLICY
```

Playwright Direct is the recommended browser execution foundation. Sol Bridge
policy remains responsible for origin, identity, binding, bounded observation,
delivery recovery, and security. No browser library is allowed to select the
trusted Project, account, or conversation on its own.

## Environment and evidence

- Windows 11 host, Node.js `v24.16.0`, Microsoft Edge `153.0.4234.32`.
- Playwright `1.63.0`, installed as a Spike-only development dependency.
- Existing repository branch: `feat/adl-sol-bridge-v1.1`.
- Frozen architecture baseline: `60df5440fc659ad2d8d8dd2058e178a57850fe10`.
- Local fixture: an isolated HTTP ChatGPT-like page with assistant/user
  messages, Project/account attributes, conversation URL, thinking indicator,
  composer, submit action, and transport confirmation.
- No credentials, cookies, OTP/MFA, screenshots, or production Sol messages
  were used.

The deterministic harness is:

```text
node spikes/sol-bridge-browser-foundation/run-spike.mjs
```

It runs the same start/reuse, page selection, identity capture, assistant/user
capture, thinking detection, composer input, submit, and confirmation scenario
for all three candidates. Fixture results prove browser mechanics only.

## Candidate results

### A. Extracted W2C Custom CDP

Existing focused W2C/Bridge tests execute the low-level CDP behavior and the
isolated harness exercised target enumeration, raw DOM capture, composer
submission, and confirmation successfully. The fixture restart marker was
`null` after an external Edge process restart, so persistent profile reuse is
not verified by this harness.

The reusable W2C source surface is substantial: `cdp.ts` 402 lines,
`cdp-conversation.ts` 287, `state-adapter.ts` 360, `profile.ts` 560,
`session-binding.ts` 308, `url-security.ts` 25, and `persistence.ts` 554.
Much of that surface is generic browser/process/persistence plumbing or W2C
workflow integration rather than Sol policy.

Strengths: mature localhost CDP security checks, strong hidden/minimized DOM
capture model, explicit timeout and ownership logic, no new runtime dependency.

Weaknesses: low-level WebSocket and profile lifecycle maintenance remains our
burden; target/page lifecycle is easy to stale after restart; selectors and
send mechanics are coupled to custom CDP code; the current production profile
probe's `--enable-automation` dependency is incompatible with the observed
Google OAuth login rejection and must not be carried into a new foundation.

Real ChatGPT: `https://chatgpt.com/` was reachable through custom CDP and
showed the unauthenticated login page. No authenticated conversation was
available; no message was sent.

### B. Playwright Direct

The harness used `chromium.launchPersistentContext` with the Microsoft Edge
executable and a dedicated profile. It enumerated pages, selected the fixture
conversation, captured identity and latest messages, detected not-thinking,
filled the composer, submitted, confirmed the user message, closed Edge,
reopened the same profile, and observed the persistence marker.

Result: `PROVEN_FIXTURE`, `persistent_profile_reuse: true`.

Strengths: browser process/context/page lifecycle, persistent profiles,
locators, input, waiting, cancellation, and restart handling are provided by a
maintained browser API; direct persistent-context reuse is the strongest
observed evidence; policy can remain a small deterministic wrapper.

Weaknesses: Playwright does not provide Sol identity or delivery recovery;
locator selectors still require maintenance; actual ChatGPT login and current
DOM behavior remain unverified without credentials.

Real ChatGPT: headful Edge reached the unauthenticated ChatGPT page with login
controls. No login was attempted and no message was sent.

### C. Playwright over CDP

The harness launched an externally managed Edge with localhost CDP,
connected with `chromium.connectOverCDP`, enumerated the exposed context/page,
ran the same DOM and send scenario, and attempted profile reuse after an
external process restart.

Result: fixture mechanics passed, but restart marker was `null`:
`NOT_VERIFIED_RESTART_MARKER`. This is a concrete lifecycle limitation in the
current experiment, not evidence that every CDP profile can never persist.

Strengths: Playwright locators and DOM operations with an externally managed
Edge profile; useful when another trusted process must own Edge.

Weaknesses: context/page lifecycle is constrained by the external browser;
disconnect/restart and profile-lock behavior need extra ownership machinery;
the tested restart did not prove persistence; it retains both CDP and
Playwright failure surfaces.

Real ChatGPT: reached the unauthenticated ChatGPT page through CDP. No login
was attempted and no message was sent.

## Weighted score matrix

Scores are 1–5. Critical dimensions have weight 3, important dimensions weight
2, and secondary dimensions weight 1. The eight critical dimensions are
persistent login, exact targeting, Project/account/conversation identity,
assistant capture, user capture, send confirmation, browser restart recovery,
and security boundary. The two dimensions not explicitly assigned in the
frozen weighting list, dedicated profile isolation and Edge support, are
treated as important implementation dimensions with weight 2.

| Dimension | Weight | A: Custom CDP | B: Direct | C: CDP |
|---|---:|---:|---:|---:|
| Persistent login | 3 | 4 | 5 | 3 |
| Dedicated profile isolation | 2 | 4 | 5 | 4 |
| Edge support | 2 | 5 | 5 | 5 |
| Hidden/minimized capture | 2 | 5 | 4 | 4 |
| Exact conversation targeting | 3 | 4 | 5 | 4 |
| Project/account/conversation identity | 3 | 4 | 4 | 4 |
| Assistant capture | 3 | 4 | 5 | 5 |
| User capture | 3 | 4 | 5 | 5 |
| Thinking detection | 2 | 4 | 5 | 5 |
| Composer interaction | 2 | 3 | 5 | 5 |
| Send confirmation | 3 | 4 | 4 | 4 |
| Browser restart recovery | 3 | 3 | 5 | 3 |
| Multi-tab behavior | 2 | 3 | 4 | 3 |
| Timeout behavior | 2 | 4 | 5 | 4 |
| Testability | 2 | 4 | 5 | 4 |
| Dependency weight | 1 | 5 | 2 | 2 |
| Portability | 1 | 4 | 3 | 3 |
| Maintenance burden | 1 | 2 | 4 | 3 |
| ChatGPT DOM change resilience | 2 | 2 | 4 | 4 |
| Security boundary | 3 | 5 | 4 | 4 |
| **Weighted total** |  | **175** | **204** | **180** |

The score is intentionally weighted; Direct wins on lifecycle, restart,
targeting, interaction, and testability rather than raw feature count.

## Generic plumbing versus Sol policy

Generic browser plumbing:

- Edge executable discovery and process/context lifecycle;
- persistent profile creation/reuse;
- CDP transport or Playwright connection;
- page enumeration and locator/action APIs;
- bounded browser waits, navigation, and target lifecycle;
- DOM extraction mechanics and composer interaction.

Sol-specific policy:

- allowed ChatGPT origin and localhost transport security;
- Project fingerprint, account fingerprint, conversation ID, and canonical URL;
- unique target binding and fail-closed ambiguity handling;
- stable assistant sampling and bounded `read --after`;
- observation-not-consumption and at-least-once observation;
- pre-send user baseline, pending delivery, delivery proof, and no auto-resend;
- Luna workflow ownership and GitHub verification gate.

## Security and maintenance conclusion

Playwright is selected only as the browser adapter. It does not become an
agent, planner, scheduler, MCP controller, or source of workflow truth. The
adapter returns raw page facts; Sol Bridge policy validates every identity and
transport transition. The selected design preserves fail-closed behavior even
when Playwright cannot prove delivery or a page cannot be uniquely identified.
