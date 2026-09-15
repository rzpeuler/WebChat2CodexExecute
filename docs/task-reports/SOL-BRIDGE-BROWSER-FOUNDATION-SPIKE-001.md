task_id: SOL-BRIDGE-BROWSER-FOUNDATION-SPIKE-001
status: READY_FOR_SOL_REVIEW
baseline: e74a6a204af811ba390a77020d84e97a23af1b98
architecture_baseline: 60df5440fc659ad2d8d8dd2058e178a57850fe10
branch: feat/adl-sol-bridge-v1.1
implementation_commit: 7ececd29fd9b9dcdc26a345cfd7c7ec9393ab63e
verified_remote_tip: 7ececd29fd9b9dcdc26a345cfd7c7ec9393ab63e
sync_status: SYNCED
summary: Compared W2C custom CDP, Playwright Direct, and Playwright over CDP using one isolated Edge fixture plus real ChatGPT read-only probes. Selected Playwright Direct as the browser foundation and retained W2C Sol-specific policy outside the browser driver.
changes: Added an isolated spikes/sol-bridge-browser-foundation harness and fixture, added temporary Playwright 1.63.0 development dependency, and documented the weighted comparison and migration impact. No production Sol Bridge code or old W2C runtime was changed.
tests: passed
bridge_focused_tests: fixture harness passed all three candidates for mechanics; Direct persistent profile reuse proven; over-CDP and custom-CDP restart marker not verified
adl_regression_tests: existing Edge/ADL focused tests passed 40/40; full repository suite passed 450/450
full_repository_validation: npm test -- --testTimeout=15000 passed 450/450; npm run typecheck passed; npm run build passed; spike and Skill mjs node checks passed; git diff --check passed
real_e2e_result: Real read-only Edge probes reached https://chatgpt.com through all three candidates. Direct, over-CDP, and custom CDP showed the unauthenticated ChatGPT page; no credentials were entered and no Sol message was sent.
acceptance_criteria: exactly three candidates evaluated; common isolated harness exercised; weighted score matrix recorded; one concrete recommendation selected; W2C generic plumbing separated from Sol policy; no architecture reopening; no production notification
selected_foundation: SELECT_PLAYWRIGHT_DIRECT + RETAIN_W2C_SOL_POLICY
governance_status: unchanged; no new project governance or production workflow state
architecture_freeze_status: V1.1 ARCHITECTURE REMAINS FROZEN
scope_deviations: none
blockers: none for the foundation decision; authenticated ChatGPT conversation behavior remains a production implementation validation requirement
remaining_risks: Playwright direct DOM selectors and authenticated Project/account identity need validation in the next approved implementation task. The external-process restart marker did not persist in the over-CDP and custom-CDP fixture experiments and must remain fail closed until resolved.
task_input_quality: complete
