# Sol Bridge Browser Foundation Spike

This directory is experimental and is not imported by the production Skill.
It compares the three frozen candidates against one local ChatGPT-like fixture:

```text
node spikes/sol-bridge-browser-foundation/run-spike.mjs
```

`direct` uses Playwright's persistent Edge context, `cdp` uses
`connectOverCDP`, and `custom` uses the existing extracted custom CDP
transport. The fixture proves browser mechanics and profile reuse only; it is
not evidence of ChatGPT login or current ChatGPT DOM compatibility.

No passwords, OTP, MFA, cookies, localStorage dumps, or production Sol
messages are used.

