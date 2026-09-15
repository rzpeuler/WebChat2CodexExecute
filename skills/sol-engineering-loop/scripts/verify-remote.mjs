import { main } from './lib/cli.mjs';
import { fetchBranch, remoteTip, snapshot } from './lib/git.mjs';

await main(async (input) => {
  if (!input?.repo || !input?.remote || !input?.branch)
    return { ok: false, code: 'REMOTE_INPUT_REQUIRED', message: 'repo, remote, and branch are required' };
  if (input.fetch !== false) await fetchBranch(input.repo, input.remote, input.branch);
  const observed = await remoteTip(input.repo, input.remote, input.branch);
  const relation = !observed.known ? 'UNKNOWN' : observed.tip === input.expected_remote_tip ? 'EXPECTED' : input.expected_remote_tip === null ? 'ADVANCED' : 'CHANGED';
  const local = await snapshot(input.repo, { remote: input.remote });
  return {
    ok: observed.known && (relation === 'EXPECTED' || input.allow_changed === true),
    code: observed.known ? `REMOTE_${relation}` : 'REMOTE_UNKNOWN',
    relation,
    observed_remote_tip: observed.tip,
    expected_remote_tip: input.expected_remote_tip ?? null,
    branch: local.branch,
  };
});
