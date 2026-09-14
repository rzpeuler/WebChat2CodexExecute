import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from './cli.mjs';

const execFile = promisify(execFileCallback);

export async function git(repo, args, { allowFailure = false } = {}) {
  try {
    const result = await execFile('git', ['-C', repo, ...args], {
      cwd: repo,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (error) {
    const failure = {
      ok: false,
      stdout: redact(String(error?.stdout ?? '')),
      stderr: redact(String(error?.stderr ?? '')),
      code: typeof error?.code === 'number' ? error.code : 1,
    };
    if (allowFailure) return failure;
    const wrapped = new Error(failure.stderr || failure.stdout || `git ${args.join(' ')} failed`);
    wrapped.code = 'GIT_COMMAND_FAILED';
    wrapped.details = { command: args[0], exit_code: failure.code };
    throw wrapped;
  }
}

export function normalizeBranch(value) {
  return String(value ?? '').trim();
}

export function parseStatusPaths(output) {
  const entries = output.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const path = entry.slice(3).trim();
    if (path) paths.push(path);
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) {
      const original = entries[i + 1]?.trim();
      if (original) paths.push(original);
      i += 1;
    }
  }
  return [...new Set(paths)];
}

export async function remoteTip(repo, remote, branch) {
  if (!remote || !branch) return { known: false, tip: null, reason: 'remote or branch is missing' };
  const result = await git(repo, ['ls-remote', remote, `refs/heads/${branch}`], { allowFailure: true });
  if (!result.ok) return { known: false, tip: null, reason: result.stderr || result.stdout || 'remote query failed' };
  const line = result.stdout.trim().split(/\r?\n/).find(Boolean);
  return { known: true, tip: line ? line.split(/\s+/)[0] : null, reason: null };
}

export async function fetchBranch(repo, remote, branch) {
  if (!remote || !branch) return { ok: false, reason: 'remote or branch is missing' };
  const result = await git(repo, ['fetch', '--no-tags', remote, `refs/heads/${branch}`], { allowFailure: true });
  return result.ok ? { ok: true } : { ok: false, reason: result.stderr || result.stdout || 'fetch failed' };
}

export async function snapshot(repo, input = {}) {
  const root = (await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = normalizeBranch((await git(root, ['branch', '--show-current'])).stdout);
  const remote = normalizeBranch(input.remote ?? 'origin');
  const remoteUrlResult = await git(root, ['remote', 'get-url', remote], { allowFailure: true });
  const remoteUrl = remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : null;
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']);
  const worktree = parseStatusPaths(status.stdout);
  const remoteState = await remoteTip(root, remoteUrl ? remote : null, branch);
  return {
    repository_root: root,
    branch,
    head,
    remote_name: remoteUrl ? remote : null,
    remote_url_present: remoteUrl !== null,
    remote_tip: remoteState.known ? remoteState.tip : null,
    remote_tip_known: remoteState.known,
    worktree,
    clean: worktree.length === 0,
  };
}
