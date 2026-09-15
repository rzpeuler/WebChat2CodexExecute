import { main } from './lib/cli.mjs';
import { snapshot, fetchBranch } from './lib/git.mjs';

await main(async (input) => {
  if (!input?.repo) return { ok: false, code: 'REPOSITORY_REQUIRED', message: 'repo is required' };
  const before = await snapshot(input.repo, { remote: input.remote ?? 'origin' });
  if (input.remote && input.fetch !== false) await fetchBranch(input.repo, input.remote, before.branch);
  const current = await snapshot(input.repo, { remote: input.remote ?? 'origin' });
  if (input.branch && current.branch !== input.branch)
    return { ok: false, code: 'BRANCH_MISMATCH', message: `expected ${input.branch}, observed ${current.branch}`, baseline: current };
  if (input.expected_head && current.head !== input.expected_head)
    return { ok: false, code: 'HEAD_MISMATCH', message: 'repository HEAD differs from expected_head', baseline: current };
  return { ok: true, code: 'OK', baseline: current };
});
