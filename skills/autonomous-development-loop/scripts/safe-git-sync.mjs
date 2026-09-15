import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { main, redact } from './lib/cli.mjs';
import { git, fetchBranch, remoteTip, snapshot } from './lib/git.mjs';
import { checkPaths, matchesPath } from './lib/path-policy.mjs';
import { finalizeTaskReport, validateTaskReport } from './lib/report.mjs';

const IMPLEMENTATION_PUSH = 'IMPLEMENTATION_PUSH';
const REPORT_FINALIZATION = 'REPORT_FINALIZATION';

function fail(code, message, exit_code = 1, details = {}) {
  return { ok: false, code, message, exit_code, ...details };
}

async function gitDirectory(repo) {
  const result = await git(repo, ['rev-parse', '--git-dir']);
  return resolve(repo, result.stdout.trim());
}

async function parseJson(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, missing: true, error };
    return { ok: false, missing: false, error };
  }
}

async function readPending(path) {
  const primary = await parseJson(path);
  if (primary.ok) return { value: primary.value, recovered_from_backup: false };
  const backup = await parseJson(`${path}.bak`);
  if (backup.ok) {
    await writePending(path, backup.value);
    return { value: backup.value, recovered_from_backup: true };
  }
  if (primary.missing && backup.missing) return { value: null, recovered_from_backup: false };
  throw new Error(`pending push state is invalid: ${primary.error?.message ?? primary.error}`);
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceAtomically(temporary, target) {
  try {
    await rename(temporary, target);
    return;
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EEXIST'].includes(error?.code)) throw error;
  }

  const backup = `${target}.bak`;
  await rm(backup, { force: true });
  const targetExists = await fileExists(target);
  try {
    if (targetExists) await rename(target, backup);
    await rename(temporary, target);
    await rm(backup, { force: true });
  } catch (error) {
    try {
      if (!(await fileExists(target)) && (await fileExists(backup))) await rename(backup, target);
    } catch {
      // Keep the backup for the next recovery attempt; preserve the original error.
    }
    throw error;
  }
}

async function writePending(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await replaceAtomically(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearPending(path) {
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await unlink(`${path}.bak`).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function allowed(path, rules) {
  return !Array.isArray(rules) || rules.length === 0 || rules.some((rule) => matchesPath(path, rule));
}

function validPending(value) {
  return value && value.version === 2 && [IMPLEMENTATION_PUSH, REPORT_FINALIZATION].includes(value.phase)
    && typeof value.repository_root === 'string' && typeof value.branch === 'string'
    && typeof value.task_id === 'string' && typeof value.remote_name === 'string'
    && typeof value.baseline_head === 'string' && (value.expected_remote_tip === null || typeof value.expected_remote_tip === 'string')
    && typeof value.implementation_commit === 'string' && typeof value.report_path === 'string';
}

function remoteOutcome(remote, baseline, local) {
  if (remote === local) return 'LOCAL_COMMIT';
  if (remote === baseline) return 'BASELINE';
  return 'REMOTE_CHANGED';
}

async function pushAndObserve(repo, remote, branch) {
  const pushed = await git(repo, ['push', remote, `HEAD:refs/heads/${branch}`], { allowFailure: true });
  const observed = await remoteTip(repo, remote, branch);
  return { pushed, observed };
}

async function finalizeReportAndCommit({ repo, input, pending, implementationCommit }) {
  const before = await snapshot(repo, { remote: input.remote });
  if (before.head !== implementationCommit)
    return fail('FINALIZATION_HEAD_MISMATCH', 'local HEAD must remain the implementation commit before report finalization', 2, { head: before.head, implementation_commit: implementationCommit });
  const current = await validateTaskReport({ repo, report_path: input.report_path, task_id: input.task_id, baseline: input.baseline_head, branch: before.branch });
  if (!current.ok) return fail(current.code, current.message, 2, { report: current });
  if (current.fields.sync_status === 'READY_TO_SYNC') {
    const finalized = await finalizeTaskReport({
      repo,
      report_path: input.report_path,
      task_id: input.task_id,
      baseline: input.baseline_head,
      branch: before.branch,
      implementation_commit: implementationCommit,
      verified_remote_tip: implementationCommit,
    });
    if (!finalized.ok) return fail(finalized.code, finalized.message, 2, { report: finalized });
  } else if (current.fields.sync_status !== 'SYNCED' || current.fields.implementation_commit !== implementationCommit || current.fields.verified_remote_tip !== implementationCommit) {
    return fail('REPORT_FINALIZATION_STATE_INVALID', 'report is neither ready for nor consistently finalized', 2, { report: current });
  }
  const changed = (await snapshot(repo, { remote: input.remote })).worktree;
  const unrelated = changed.filter((path) => !matchesPath(path, input.report_path));
  if (unrelated.length) return fail('FINALIZATION_WORKTREE_DIRTY', 'unrelated changes appeared during report finalization', 2, { paths: unrelated });
  const staged = await git(repo, ['add', '--', input.report_path], { allowFailure: true });
  if (!staged.ok) return fail('REPORT_FINALIZATION_ADD_FAILED', redact(staged.stderr || staged.stdout), 1);
  const committed = await git(repo, ['commit', '-m', `chore: finalize ${input.task_id} report`], { allowFailure: true });
  if (!committed.ok) return fail('REPORT_FINALIZATION_COMMIT_FAILED', redact(committed.stderr || committed.stdout), 1);
  const finalizationCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const nextPending = {
    ...pending,
    version: 2,
    phase: REPORT_FINALIZATION,
    implementation_commit: implementationCommit,
    finalization_commit: finalizationCommit,
    expected_remote_tip: implementationCommit,
  };
  await writePending(resolve(await gitDirectory(repo), 'adl-pending-push.json'), nextPending);
  return { ok: true, finalizationCommit, nextPending };
}

async function completeFinalization({ repo, input, pending, implementationCommit, finalizationCommit, recoveredFromBackup }) {
  if (!finalizationCommit) {
    const prepared = await finalizeReportAndCommit({ repo, input, pending, implementationCommit });
    if (!prepared.ok) return prepared;
    finalizationCommit = prepared.finalizationCommit;
    pending = prepared.nextPending;
  }
  const pushed = await pushAndObserve(repo, input.remote, input.branch ?? pending.branch);
  if (!pushed.observed.known)
    return fail('REMOTE_UNKNOWN', redact(pushed.observed.reason), 22, { implementation_commit: implementationCommit, finalization_commit: finalizationCommit, push_error: redact(pushed.pushed.stderr || pushed.pushed.stdout) });
  const outcome = remoteOutcome(pushed.observed.tip, implementationCommit, finalizationCommit);
  if (outcome === 'LOCAL_COMMIT') {
    await clearPending(resolve(await gitDirectory(repo), 'adl-pending-push.json'));
    const report = await validateTaskReport({ repo, report_path: input.report_path, task_id: input.task_id, baseline: input.baseline_head, branch: input.branch ?? pending.branch, phase: 'final' });
    if (!report.ok) return fail(report.code, report.message, 2, { report });
    const after = await snapshot(repo, { remote: input.remote });
    if (!after.clean || after.head !== finalizationCommit)
      return fail('POST_SYNC_LOCAL_STATE_INVALID', 'remote is synchronized but local postcondition failed', 1, { implementation_commit: implementationCommit, finalization_commit: finalizationCommit, baseline: after });
    return {
      ok: true,
      code: 'SYNCED',
      sync_status: 'SYNCED',
      implementation_commit: implementationCommit,
      verified_remote_tip: implementationCommit,
      finalization_commit: finalizationCommit,
      remote_tip: pushed.observed.tip,
      recovered_from_pending_backup: recoveredFromBackup,
      changed_paths: [input.report_path],
      push_command_succeeded: pushed.pushed.ok,
    };
  }
  if (outcome === 'BASELINE')
    return fail('PUSH_NOT_CONFIRMED', 'remote remains at the implementation commit; report finalization commit retained for safe retry', 20, { implementation_commit: implementationCommit, finalization_commit: finalizationCommit, remote_tip: pushed.observed.tip, push_error: redact(pushed.pushed.stderr || pushed.pushed.stdout) });
  return fail('REMOTE_CHANGED_DURING_PUSH', 'remote changed to a commit other than the expected or local commit; overwrite refused', 21, { implementation_commit: implementationCommit, finalization_commit: finalizationCommit, expected_remote_tip: implementationCommit, remote_tip: pushed.observed.tip, push_error: redact(pushed.pushed.stderr || pushed.pushed.stdout) });
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
  let pendingResult;
  try {
    pendingResult = await readPending(pendingPath);
  } catch (error) {
    return fail('PENDING_PUSH_CORRUPT', redact(error.message ?? error), 2);
  }
  let pending = pendingResult.value;
  const recoveredFromBackup = pendingResult.recovered_from_backup;
  if (pending !== null && !validPending(pending)) return fail('PENDING_PUSH_INVALID', 'pending push state has an unsupported schema', 2, { pending });
  const isPendingRetry = pending !== null;
  if (pending !== null && (pending.repository_root !== before.repository_root || pending.branch !== before.branch || pending.task_id !== input.task_id || pending.remote_name !== remote))
    return fail('PENDING_PUSH_CONFLICT', 'a different pending push belongs to this repository', 2, { pending });
  if (!isPendingRetry && before.head !== input.baseline_head)
    return fail('BASELINE_CHANGED', 'current HEAD differs from baseline_head', 2, { baseline: before });
  if (input.fetch !== false) await fetchBranch(repo, remote, before.branch);
  const observedBefore = await remoteTip(repo, remote, before.branch);
  if (!observedBefore.known) return fail('REMOTE_UNKNOWN', redact(observedBefore.reason), 22);

  const implementationCommit = pending?.implementation_commit ?? null;
  const finalizationCommit = pending?.finalization_commit ?? null;
  if (pending?.phase === REPORT_FINALIZATION) {
    if (observedBefore.tip !== pending.expected_remote_tip && observedBefore.tip !== finalizationCommit)
      return fail('REMOTE_ADVANCED', 'remote tip differs from the expected implementation or finalization commit', 21, { expected_remote_tip: pending.expected_remote_tip, observed_remote_tip: observedBefore.tip });
    if (observedBefore.tip === finalizationCommit)
      return completeFinalization({ repo, input: { ...input, remote }, pending, implementationCommit, finalizationCommit, recoveredFromBackup });
    if (finalizationCommit && before.head !== finalizationCommit)
      return fail('PENDING_PUSH_HEAD_MISMATCH', 'local HEAD differs from pending finalization commit', 2, { pending, head: before.head });
    if (!finalizationCommit && before.head !== implementationCommit)
      return fail('PENDING_PUSH_HEAD_MISMATCH', 'local HEAD differs from pending implementation commit', 2, { pending, head: before.head });
    return completeFinalization({ repo, input: { ...input, remote }, pending, implementationCommit, finalizationCommit, recoveredFromBackup });
  }

  const expectedRemote = pending?.expected_remote_tip ?? input.baseline_remote_tip ?? null;
  if (observedBefore.tip !== expectedRemote) {
    if (pending?.phase === IMPLEMENTATION_PUSH && observedBefore.tip === implementationCommit && before.head !== implementationCommit) {
      const finalizedReport = await validateTaskReport({ repo, report_path: input.report_path, task_id: input.task_id, baseline: input.baseline_head, branch: before.branch, phase: 'final' });
      if (!finalizedReport.ok || !before.clean || finalizedReport.fields.implementation_commit !== implementationCommit || finalizedReport.fields.verified_remote_tip !== implementationCommit)
        return fail('PENDING_PUSH_HEAD_MISMATCH', 'local HEAD is ahead of the pending implementation without a recoverable finalized report', 2, { pending, head: before.head });
      pending = { ...pending, phase: REPORT_FINALIZATION, expected_remote_tip: implementationCommit, finalization_commit: before.head };
      await writePending(pendingPath, pending);
      return completeFinalization({ repo, input: { ...input, remote }, pending, implementationCommit, finalizationCommit: before.head, recoveredFromBackup });
    }
    if (pending?.phase === IMPLEMENTATION_PUSH && observedBefore.tip === implementationCommit)
      return completeFinalization({ repo, input: { ...input, remote }, pending, implementationCommit, finalizationCommit: null, recoveredFromBackup });
    return fail('REMOTE_ADVANCED', 'remote tip differs from expected baseline; no overwrite performed', 21, { expected_remote_tip: expectedRemote, observed_remote_tip: observedBefore.tip });
  }
  const report = await validateTaskReport({ repo, report_path: input.report_path, task_id: input.task_id, baseline: input.baseline_head, branch: before.branch, phase: 'pre-sync' });
  if (!report.ok) return fail(report.code, report.message, 2, { report });

  let changedPaths = before.worktree;
  if (!isPendingRetry) {
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
    const localCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    pending = {
      version: 2,
      phase: IMPLEMENTATION_PUSH,
      repository_root: before.repository_root,
      remote_name: remote,
      branch: before.branch,
      task_id: input.task_id,
      baseline_head: input.baseline_head,
      expected_remote_tip: expectedRemote,
      implementation_commit: localCommit,
      finalization_commit: null,
      report_path: input.report_path,
    };
    await writePending(pendingPath, pending);
  } else if (pending.phase !== IMPLEMENTATION_PUSH || before.head !== implementationCommit) {
    return fail('PENDING_PUSH_HEAD_MISMATCH', 'local HEAD differs from pending implementation commit', 2, { pending, head: before.head });
  }

  const pushed = await pushAndObserve(repo, remote, before.branch);
  if (!pushed.observed.known)
    return fail('REMOTE_UNKNOWN', redact(pushed.observed.reason), 22, { implementation_commit: pending.implementation_commit, push_error: redact(pushed.pushed.stderr || pushed.pushed.stdout) });
  const outcome = remoteOutcome(pushed.observed.tip, pending.expected_remote_tip, pending.implementation_commit);
  if (outcome === 'BASELINE')
    return fail('PUSH_NOT_CONFIRMED', 'remote remains at the baseline; implementation commit retained for safe retry', 20, { implementation_commit: pending.implementation_commit, baseline_remote_tip: pending.expected_remote_tip, remote_tip: pushed.observed.tip, recovered_from_pending_backup: recoveredFromBackup, push_error: redact(pushed.pushed.stderr || pushed.pushed.stdout) });
  if (outcome === 'REMOTE_CHANGED')
    return fail('REMOTE_CHANGED_DURING_PUSH', 'remote changed to a commit other than the baseline or implementation commit; overwrite refused', 21, { implementation_commit: pending.implementation_commit, baseline_remote_tip: pending.expected_remote_tip, remote_tip: pushed.observed.tip, push_error: redact(pushed.pushed.stderr || pushed.pushed.stdout) });

  pending = { ...pending, phase: REPORT_FINALIZATION, expected_remote_tip: pending.implementation_commit };
  await writePending(pendingPath, pending);
  return completeFinalization({ repo, input: { ...input, remote, branch: before.branch }, pending, implementationCommit: pending.implementation_commit, finalizationCommit: null, recoveredFromBackup });
});
