import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { main, redact } from './lib/cli.mjs';
import { git, fetchBranch, remoteTip, snapshot } from './lib/git.mjs';
import { checkPaths, matchesPath } from './lib/path-policy.mjs';
import { validateTaskReport } from './lib/report.mjs';

function fail(code, message, exit_code = 1, details = {}) {
  return { ok: false, code, message, exit_code, ...details };
}

async function gitDirectory(repo) {
  const result = await git(repo, ['rev-parse', '--git-dir']);
  return resolve(repo, result.stdout.trim());
}

async function readPending(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`pending push state is invalid: ${error.message ?? error}`);
  }
}

async function writePending(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path, await readFile(temporary), { encoding: 'utf8' });
  await unlink(temporary).catch(() => undefined);
}

async function clearPending(path) {
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function allowed(path, rules) {
  return !Array.isArray(rules) || rules.length === 0 || rules.some((rule) => matchesPath(path, rule));
}

await main(async (input) => {
  if (!input?.repo || !input?.task_id || !input?.baseline_head || !input?.report_path)
    return fail('SYNC_INPUT_REQUIRED', 'repo, task_id, baseline_head, and report_path are required');
  const repo = resolve(input.repo);
  const remote = input.remote ?? 'origin';
  const before = await snapshot(repo, { remote });
  if (input.branch && before.branch !== input.branch) return fail('BRANCH_MISMATCH', 'current branch differs from input', 2, { baseline: before });
  const gitDir = await gitDirectory(repo);
  const pendingPath = resolve(gitDir, 'adl-pending-push.json');
  const pending = await readPending(pendingPath);
  const isPendingRetry = pending !== null;
  if (pending !== null && (pending.repository_root !== before.repository_root || pending.branch !== before.branch || pending.task_id !== input.task_id || pending.remote_name !== remote))
    return fail('PENDING_PUSH_CONFLICT', 'a different pending push belongs to this repository', 2, { pending });
  if (!isPendingRetry && before.head !== input.baseline_head)
    return fail('BASELINE_CHANGED', 'current HEAD differs from baseline_head', 2, { baseline: before });
  if (input.fetch !== false) await fetchBranch(repo, remote, before.branch);
  const observedBefore = await remoteTip(repo, remote, before.branch);
  if (!observedBefore.known) return fail('REMOTE_UNKNOWN', redact(observedBefore.reason), 22);
  const expectedRemote = pending?.baseline_remote_tip ?? input.baseline_remote_tip ?? null;
  if (observedBefore.tip !== expectedRemote)
    return fail('REMOTE_ADVANCED', 'remote tip differs from expected baseline; no commit or push performed', 21, { expected_remote_tip: expectedRemote, observed_remote_tip: observedBefore.tip });

  const report = await validateTaskReport({ repo, report_path: input.report_path, task_id: input.task_id, baseline: input.baseline_head });
  if (!report.ok) return fail(report.code, report.message, 2, { report });

  let localCommit = pending?.commit ?? null;
  let changedPaths = before.worktree;
  if (pending === null) {
    if (changedPaths.length === 0) return fail('NO_CHANGES', 'worktree has no changes to synchronize', 2);
    const policy = checkPaths(changedPaths, input.protected_paths ?? []);
    if (!policy.ok) return fail('PATH_POLICY_REJECTED', 'changed paths violate protected or sensitive path policy', 2, { policy });
    const outsideAllowed = changedPaths.filter((path) => !allowed(path, input.allowed_paths));
    if (outsideAllowed.length) return fail('PATH_NOT_ALLOWED', 'changed path is outside the explicit allowed set', 2, { paths: outsideAllowed });
    const required = [...new Set([input.report_path, ...(input.required_paths ?? [])].map(String))];
    const missing = required.filter((path) => !changedPaths.some((changed) => matchesPath(changed, path)));
    if (missing.length) return fail('REQUIRED_CHANGE_MISSING', 'required report or state path was not changed', 2, { missing });
    if (!input.commit_message || !String(input.commit_message).trim()) return fail('COMMIT_MESSAGE_REQUIRED', 'commit_message is required', 2);
    const staged = await git(repo, ['add', '-A', '--', ...changedPaths], { allowFailure: true });
    if (!staged.ok) return fail('GIT_ADD_FAILED', redact(staged.stderr || staged.stdout), 1);
    const committed = await git(repo, ['commit', '-m', String(input.commit_message)], { allowFailure: true });
    if (!committed.ok) return fail('COMMIT_FAILED', redact(committed.stderr || committed.stdout), 1);
    localCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  } else if (before.head !== localCommit) {
    return fail('PENDING_PUSH_HEAD_MISMATCH', 'local HEAD differs from pending commit', 2, { pending, head: before.head });
  }

  const record = {
    version: 1,
    repository_root: before.repository_root,
    remote_name: remote,
    branch: before.branch,
    task_id: input.task_id,
    baseline_head: input.baseline_head,
    baseline_remote_tip: expectedRemote,
    commit: localCommit,
    report_path: input.report_path,
  };
  await writePending(pendingPath, record);
  const pushed = await git(repo, ['push', remote, `HEAD:refs/heads/${before.branch}`], { allowFailure: true });
  const observedAfter = await remoteTip(repo, remote, before.branch);
  if (!observedAfter.known) return fail('REMOTE_UNKNOWN', redact(observedAfter.reason), 22, { commit: localCommit, push_error: redact(pushed.stderr || pushed.stdout) });
  if (observedAfter.tip === localCommit) {
    await clearPending(pendingPath);
    const after = await snapshot(repo, { remote });
    if (!after.clean || after.head !== localCommit)
      return fail('POST_SYNC_LOCAL_STATE_INVALID', 'remote is synchronized but local postcondition failed', 1, { commit: localCommit, baseline: after });
    return { ok: true, code: 'SYNCED', commit: localCommit, remote_tip: observedAfter.tip, changed_paths: changedPaths, push_command_succeeded: pushed.ok };
  }
  if (observedAfter.tip === expectedRemote)
    return fail('PUSH_NOT_CONFIRMED', 'remote remains at the baseline; local commit retained for safe retry', 20, { commit: localCommit, baseline_remote_tip: expectedRemote, remote_tip: observedAfter.tip, push_error: redact(pushed.stderr || pushed.stdout) });
  return fail('REMOTE_CHANGED_DURING_PUSH', 'remote changed to a commit other than the baseline or local commit; overwrite refused', 21, { commit: localCommit, baseline_remote_tip: expectedRemote, remote_tip: observedAfter.tip, push_error: redact(pushed.stderr || pushed.stdout) });
});
