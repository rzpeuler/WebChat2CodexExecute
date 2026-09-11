import { access, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redactRemoteUrl } from '../project/config.js';
import { PersistentGitPendingPushState } from './pending-push-state.js';
import {
  GitControllerError,
  type CaptureBaselineOptions,
  type CodeSyncInput,
  type GitBaseline,
  type GitCommandResult,
  type GitControllerOptions,
  type GitExecFile,
  type GitManualCommitAndPushResult,
  type GitPendingPush,
  type GitPendingPushRecovery,
  type GitPendingPushRecord,
  type GitPendingPushState,
  type GitRepositoryStatus,
  type GitSyncResult,
  type GovernanceSyncInput,
  type InitializationSyncInput,
  type VerifyBaselineOptions,
} from './types.js';

const defaultExecFileCallback = promisify(execFileCallback);
const DEFAULT_PROTECTED_PATHS = ['docs/superpowers', 'docs/superpowers/**'];
const DEFAULT_EXCLUDED_PATHS = ['.web-chat2codex/backups', '.web-chat2codex/backups/**'];
const BACKUP_ROOT = '.web-chat2codex/backups';
const MANUAL_SYNC_COMMIT_MESSAGE = 'chore(web-chat2codex): sync project changes';

interface GitSnapshot extends Omit<GitBaseline, 'remoteTip'> {
  worktree: string[];
}

export class InMemoryGitPendingPushState implements GitPendingPushState {
  private readonly pendingPushes = new Map<string, GitPendingPush>();

  read(key: string): GitPendingPush | null {
    return this.pendingPushes.get(key) ?? null;
  }

  write(key: string, pendingPush: GitPendingPush): void {
    this.pendingPushes.set(key, pendingPush);
  }

  clear(key: string, commit: string): void {
    if (this.pendingPushes.get(key)?.commit === commit) this.pendingPushes.delete(key);
  }

  list(): GitPendingPushRecord[] {
    return [...this.pendingPushes].map(([key, pendingPush]) => ({ key, pendingPush: { ...pendingPush } }));
  }
}

function defaultPendingPushStatePath(): string {
  const base =
    process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? process.env.APPDATA) : process.env.XDG_STATE_HOME;
  const dataDirectory = base === undefined ? join(tmpdir(), 'web-chat2codex') : join(base, 'web-chat2codex');
  return join(dataDirectory, 'state', 'git-pending-push.json');
}

function pendingPushKey(baseline: Pick<GitBaseline, 'repositoryRoot' | 'remoteName' | 'branch'>): string {
  return JSON.stringify([baseline.repositoryRoot, baseline.remoteName, baseline.branch]);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function redactOutput(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/([?&](?:token|password|secret|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]')
    .trim()
    .slice(0, 2000);
}

function errorProperty(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

function isUncertainProcessFailure(error: unknown, stderr: string): boolean {
  if (errorProperty(error, 'uncertain') === true) return true;
  if (errorProperty(error, 'killed') === true || errorProperty(error, 'signal') !== undefined) return true;
  return /(timed? ?out|timeout|connection reset|early eof|remote end hung up|network is unreachable|broken pipe)/i.test(
    stderr,
  );
}

function isValidRelativePath(path: string): boolean {
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.includes('\0');
}

function isValidBranchName(branch: string): boolean {
  const components = branch.split('/');
  return (
    branch.trim() === branch &&
    branch !== '' &&
    branch !== 'HEAD' &&
    components.every(
      (component) =>
        component !== '' &&
        component !== '.' &&
        component !== '..' &&
        !component.startsWith('.') &&
        !component.startsWith('-') &&
        !component.endsWith('.lock'),
    ) &&
    !branch.includes('..') &&
    !branch.includes('~') &&
    !branch.includes('^') &&
    !branch.includes(':') &&
    !branch.includes('\\') &&
    !branch.includes(' ') &&
    !branch.includes('*') &&
    !branch.includes('?') &&
    !branch.includes('[') &&
    !branch.includes('//') &&
    !/[\u0000-\u001f\u007f]/.test(branch) &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.includes('@{')
  );
}

function matchesPath(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, '');
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2).replace(/\/$/, '');
    return normalizedPath.startsWith(`${prefix}/`) && !normalizedPath.slice(prefix.length + 1).includes('/');
  }
  return normalizedPath === normalizedPattern;
}

function assertSafePathList(paths: string[], label: string): string[] {
  const normalized = paths.map(normalizePath);
  const invalid = normalized.find((path) => !isValidRelativePath(path));
  if (invalid !== undefined) {
    throw new GitControllerError('UNAUTHORIZED_CHANGE', `${label} contains an unsafe path`, { paths: [invalid] });
  }
  const excluded = normalized.find(
    (path) => matchesPath(BACKUP_ROOT, path) || DEFAULT_EXCLUDED_PATHS.some((pattern) => matchesPath(path, pattern)),
  );
  if (excluded !== undefined) {
    throw new GitControllerError('PROTECTED_PATH', `${label} may not include local recovery backups`, {
      paths: [excluded],
    });
  }
  return [...new Set(normalized)];
}

function parseStatus(output: string, excludedPaths: readonly string[] = []): string[] {
  const entries = output.split('\0').filter((entry) => entry.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const path = normalizePath(entry.slice(3));
    if (path !== '') paths.push(path);
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) {
      const renamedPath = normalizePath(entries[index + 1] ?? '');
      if (renamedPath !== '') paths.push(renamedPath);
      index += 1;
    }
  }
  return [...new Set(paths)].filter((path) => !excludedPaths.some((pattern) => matchesPath(path, pattern)));
}

function commitMessageForGovernance(changeId: string): string {
  if (!/^[a-zA-Z0-9._:/-]+$/.test(changeId)) {
    throw new GitControllerError('COMMAND_FAILED', 'Governance change id contains unsupported characters');
  }
  return `chore(governance): sync ${changeId}`;
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { cwd: string; shell: false; windowsHide: boolean },
): Promise<GitCommandResult> {
  const result = await defaultExecFileCallback(file, [...args], {
    cwd: options.cwd,
    shell: false,
    windowsHide: options.windowsHide,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export class GitController {
  private readonly execFile: GitExecFile;
  private readonly logger: (event: string, details: Record<string, unknown>) => void;
  private readonly pendingPushState: GitPendingPushState;

  constructor(options: GitControllerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.logger = options.logger ?? (() => undefined);
    this.pendingPushState =
      options.pendingPushState ??
      new PersistentGitPendingPushState(options.pendingPushStatePath ?? defaultPendingPushStatePath());
  }

  async recoverPendingPushes(): Promise<GitPendingPushRecovery[]> {
    await this.loadPendingPushState();
    const list = this.pendingPushState.list;
    if (list === undefined) return [];
    const records = await list.call(this.pendingPushState);
    const recovered: GitPendingPushRecovery[] = [];
    for (const record of records) {
      recovered.push(await this.recoverPendingPush(record));
    }
    return recovered;
  }

  async captureBaseline(repositoryPath: string, options: CaptureBaselineOptions = {}): Promise<GitBaseline> {
    const snapshot = await this.readSnapshot(repositoryPath);
    const remoteTip = await this.queryRemoteAfterFetch(snapshot.repositoryRoot, snapshot);
    const requireClean = options.requireClean ?? true;
    if (options.expectedBranch !== undefined && snapshot.branch !== options.expectedBranch) {
      throw new GitControllerError('BRANCH_MISMATCH', 'Repository branch does not match the expected branch', {
        branch: snapshot.branch,
        expected: options.expectedBranch,
      });
    }
    if (options.expectedRemoteUrl !== undefined && redactRemoteUrl(options.expectedRemoteUrl) !== snapshot.remoteUrl) {
      throw new GitControllerError('REMOTE_MISMATCH', 'Repository remote does not match the expected remote', {
        remoteUrl: snapshot.remoteUrl,
        expected: redactRemoteUrl(options.expectedRemoteUrl),
      });
    }
    if (requireClean && snapshot.worktree.length > 0) {
      throw new GitControllerError('WORKTREE_DIRTY', 'Repository has unapproved worktree changes', {
        paths: snapshot.worktree,
      });
    }
    const baseline = { ...snapshot, remoteTip };
    this.log('baseline-captured', { ...baseline });
    return baseline;
  }

  async verifyBaseline(baseline: GitBaseline, options: VerifyBaselineOptions = {}): Promise<GitBaseline> {
    const current = await this.readSnapshot(baseline.repositoryRoot);
    this.assertIdentity(baseline, current);
    const remoteTip = await this.queryRemoteAfterFetch(current.repositoryRoot, current);
    this.assertRemoteBaseline(baseline, remoteTip);
    if (!(options.allowWorktreeChanges ?? false) && current.worktree.length > 0) {
      throw new GitControllerError('BASELINE_CHANGED', 'Repository worktree changed after baseline capture', {
        paths: current.worktree,
      });
    }
    return { ...current, remoteTip };
  }

  async readRepositoryStatus(repositoryPath: string): Promise<GitRepositoryStatus> {
    const snapshot = await this.readSnapshot(repositoryPath, []);
    const remoteTrackingHead = await this.queryRemote(repositoryPath, snapshot);
    return {
      repositoryRoot: snapshot.repositoryRoot,
      branch: snapshot.branch,
      remoteName: snapshot.remoteName,
      remoteUrl: snapshot.remoteUrl,
      head: snapshot.head,
      remoteTrackingHead,
      worktree: snapshot.worktree,
      clean: snapshot.worktree.length === 0,
    };
  }

  async commitAndPushProject(repositoryPath: string): Promise<GitManualCommitAndPushResult> {
    const initial = await this.readRepositoryStatus(repositoryPath);
    const changedPaths = [...initial.worktree];
    await this.loadPendingPushState();
    const baseline: GitBaseline = {
      repositoryRoot: initial.repositoryRoot,
      remoteName: initial.remoteName,
      remoteUrl: initial.remoteUrl,
      branch: initial.branch,
      head: initial.head,
      remoteTip: initial.remoteTrackingHead,
      worktree: [],
    };
    const key = pendingPushKey(baseline);
    const pending = await this.pendingPushState.read(key);
    const pendingMatches =
      pending !== null &&
      pending.repositoryRoot === baseline.repositoryRoot &&
      pending.remoteName === baseline.remoteName &&
      pending.remoteUrl === baseline.remoteUrl &&
      pending.branch === baseline.branch;

    let localCommit = initial.head;
    let createdCommit = false;
    let expectedRemote = initial.remoteTrackingHead;

    if (pendingMatches && pending!.commit === initial.head) {
      localCommit = pending!.commit;
      expectedRemote = pending!.baselineRemoteTip;
    } else {
      if (pending !== null) {
        throw new GitControllerError('BASELINE_CHANGED', 'A different pending project commit exists', {
          head: initial.head,
          localCommit: pending.commit,
        });
      }
      if (initial.clean) throw new GitControllerError('NO_CHANGES', 'Project worktree has no changes');
      await this.run(['add', '-A'], initial.repositoryRoot);
      const staged = await this.readRepositoryStatus(initial.repositoryRoot);
      if (staged.clean) throw new GitControllerError('NO_CHANGES', 'Project worktree has no changes to commit');
      localCommit = await this.commit(MANUAL_SYNC_COMMIT_MESSAGE, initial.repositoryRoot);
      createdCommit = true;
    }

    const pushBaseline = { ...baseline, remoteTip: expectedRemote, head: localCommit };
    let remoteCommit: string | null;
    try {
      remoteCommit = await this.queryRemoteAfterFetch(initial.repositoryRoot, pushBaseline);
    } catch (error) {
      await this.rememberPendingPush(key, pushBaseline, localCommit);
      throw new GitControllerError(
        'PUSH_FAILED',
        'Project commit retained because remote state could not be verified',
        {
          localCommit,
          createdCommit,
          uncertain: true,
        },
        { cause: error },
      );
    }
    if (remoteCommit === localCommit) {
      await this.pendingPushState.clear(key, localCommit);
      const confirmed = await this.readRepositoryStatus(initial.repositoryRoot);
      if (confirmed.head !== localCommit || !confirmed.clean || confirmed.remoteTrackingHead !== localCommit) {
        throw new GitControllerError('PUSH_FAILED', 'Project sync could not confirm a clean synchronized state', {
          localCommit,
          remoteCommit: confirmed.remoteTrackingHead,
        });
      }
      return { phase: 'COMPLETED', localCommit, remoteCommit, createdCommit, pushed: true, changedPaths, clean: true };
    }
    if (remoteCommit !== expectedRemote) {
      throw new GitControllerError('BASELINE_CHANGED', 'Remote branch advanced or diverged; project push was refused', {
        expected: expectedRemote,
        remoteCommit,
        localCommit,
        createdCommit,
      });
    }

    try {
      await this.pushOnce(initial.repositoryRoot, pushBaseline);
      remoteCommit = await this.queryRemoteAfterFetch(initial.repositoryRoot, pushBaseline);
      if (remoteCommit !== localCommit)
        throw new GitControllerError('PUSH_FAILED', 'Project push could not be confirmed', {
          localCommit,
          remoteCommit,
          createdCommit,
          uncertain: true,
        });
      const confirmed = await this.readRepositoryStatus(initial.repositoryRoot);
      if (confirmed.head !== localCommit || !confirmed.clean || confirmed.remoteTrackingHead !== localCommit) {
        throw new GitControllerError('PUSH_FAILED', 'Project sync did not finish with a clean synchronized state', {
          localCommit,
          remoteCommit: confirmed.remoteTrackingHead,
        });
      }
      await this.pendingPushState.clear(key, localCommit);
      return { phase: 'COMPLETED', localCommit, remoteCommit, createdCommit, pushed: true, changedPaths, clean: true };
    } catch (error) {
      await this.rememberPendingPush(key, pushBaseline, localCommit);
      if (error instanceof GitControllerError) {
        if (error.details.createdCommit === undefined) {
          throw new GitControllerError(
            error.code,
            error.message,
            { ...error.details, createdCommit },
            { cause: error },
          );
        }
        throw error;
      }
      throw new GitControllerError(
        'PUSH_FAILED',
        'Project push failed; the local commit remains pending',
        {
          localCommit,
          createdCommit,
        },
        { cause: error },
      );
    }
  }

  async syncGovernance(input: GovernanceSyncInput): Promise<GitSyncResult> {
    const message = commitMessageForGovernance(input.changeId);
    const allowedPaths = assertSafePathList(input.changedPaths, 'Governance paths');
    if (allowedPaths.length === 0) throw new GitControllerError('NO_CHANGES', 'Governance sync has no changed paths');
    const current = await this.readSnapshot(input.baseline.repositoryRoot);
    this.assertIdentity(input.baseline, current, true);
    const existing = await this.findExistingCommit(input.baseline, current, message);
    let commit = existing;
    if (commit === null) {
      this.assertWorktreePaths(current.worktree, allowedPaths, []);
      const stagePaths = current.worktree;
      if (stagePaths.length === 0) throw new GitControllerError('NO_CHANGES', 'Governance sync has no staged changes');
      await this.run(['add', '--', ...stagePaths], current.repositoryRoot);
      commit = await this.commit(message, current.repositoryRoot);
    } else if (current.worktree.length > 0) {
      throw new GitControllerError(
        'BASELINE_CHANGED',
        'Existing governance commit is followed by new worktree changes',
        {
          paths: current.worktree,
        },
      );
    }
    return this.pushAndReturn('governance', commit, input.baseline, current.repositoryRoot);
  }

  async syncInitialization(input: InitializationSyncInput): Promise<GitSyncResult> {
    const allowedPaths = assertSafePathList(input.changedPaths, 'Initialization paths');
    const repositoryRoot = resolve(
      (await this.run(['rev-parse', '--show-toplevel'], resolve(input.repositoryPath))).trim(),
    );
    const remoteName = 'origin';
    const remoteUrl = redactRemoteUrl(await this.run(['remote', 'get-url', remoteName], repositoryRoot));
    if (remoteUrl === null) throw new GitControllerError('REMOTE_MISSING', 'Git repository has no origin remote');
    if (input.expectedRemoteUrl !== undefined && remoteUrl !== redactRemoteUrl(input.expectedRemoteUrl)) {
      throw new GitControllerError('REMOTE_MISMATCH', 'Repository remote does not match the expected remote', {
        remoteUrl,
        expected: redactRemoteUrl(input.expectedRemoteUrl),
      });
    }
    const branchOutput = await this.run(['branch', '--show-current'], repositoryRoot).catch(() => '');
    const branch = (input.targetBranch ?? (branchOutput.trim() || 'master')).trim();
    if (!isValidBranchName(branch))
      throw new GitControllerError('BRANCH_MISMATCH', 'Initialization target branch is invalid');
    const status = parseStatus(
      await this.run(['status', '--porcelain=v1', '--untracked-files=all', '-z'], repositoryRoot),
      DEFAULT_EXCLUDED_PATHS,
    );
    this.assertWorktreePaths(status, allowedPaths, DEFAULT_PROTECTED_PATHS);
    await this.loadPendingPushState();
    const pendingKey = JSON.stringify([repositoryRoot, remoteName, branch]);
    const pending = await this.pendingPushState.read(pendingKey);
    const currentHead = await this.run(['rev-parse', 'HEAD'], repositoryRoot).catch(() => null);
    const matchingPending =
      currentHead !== null &&
      pending !== null &&
      pending.repositoryRoot === repositoryRoot &&
      pending.remoteName === remoteName &&
      pending.branch === branch &&
      pending.commit === currentHead;
    const remoteBefore = await this.queryRemoteBranch(repositoryRoot, remoteName, branch);

    // A repeated initialization may be a retry after a failed push. If the
    // remote already points at the local HEAD, the operation is idempotently
    // complete. Otherwise only the exact persisted pending-push baseline may
    // be used; never overwrite a branch that advanced independently.
    if (currentHead !== null && remoteBefore === currentHead) {
      await this.pendingPushState.clear(pendingKey, currentHead);
      return { kind: 'governance', commit: currentHead, pushed: true, remoteCommit: currentHead, pushRetried: false };
    }
    const expectedRemoteTip = matchingPending ? pending!.baselineRemoteTip : null;
    if (remoteBefore !== expectedRemoteTip) {
      throw new GitControllerError('BASELINE_CHANGED', 'Initialization remote branch is not at the expected baseline', {
        expected: expectedRemoteTip,
        remoteCommit: remoteBefore,
        remoteName,
        remoteUrl,
      });
    }

    let commit: string;
    if (allowedPaths.length === 0) {
      if (currentHead === null) throw new GitControllerError('NO_HEAD', 'Git repository has no readable HEAD commit');
      if (!matchingPending) {
        const subject = await this.run(['log', '-1', '--format=%s'], repositoryRoot);
        if (!['chore(governance): initialize', 'chore(governance): sync initialize'].includes(subject)) {
          throw new GitControllerError('NO_CHANGES', 'Initialization has no retryable pending commit');
        }
      }
      commit = currentHead;
    } else {
      const stagePaths = status;
      if (stagePaths.length === 0) throw new GitControllerError('NO_CHANGES', 'Initialization has no staged changes');
      if (branchOutput.trim() !== branch) await this.run(['branch', '-M', branch], repositoryRoot);
      await this.run(['add', '--', ...stagePaths], repositoryRoot);
      commit = await this.commit('chore(governance): initialize', repositoryRoot);
    }

    const baseline: GitBaseline = {
      repositoryRoot,
      remoteName,
      remoteUrl,
      branch,
      head: commit,
      remoteTip: expectedRemoteTip,
      worktree: [],
    };
    const pushRetried = matchingPending;
    try {
      await this.run(['push', remoteName, `HEAD:refs/heads/${branch}`], repositoryRoot);
    } catch (error) {
      await this.rememberPendingPush(pendingKey, baseline, commit);
      throw new GitControllerError(
        'PUSH_FAILED',
        'Initialization push failed; the local commit was retained for retry',
        { remoteName, remoteUrl, localCommit: commit },
        { cause: error },
      );
    }
    let remoteCommit: string | null;
    try {
      remoteCommit = await this.queryRemoteBranch(repositoryRoot, remoteName, branch);
    } catch (error) {
      await this.rememberPendingPush(pendingKey, baseline, commit);
      throw new GitControllerError(
        'PUSH_FAILED',
        'Initialization push completed but the remote commit could not be confirmed',
        { localCommit: commit, remoteName, remoteUrl, uncertain: true },
        { cause: error },
      );
    }
    if (remoteCommit !== commit) {
      await this.rememberPendingPush(pendingKey, baseline, commit);
      throw new GitControllerError('PUSH_FAILED', 'Initialization push completed without the expected remote commit', {
        localCommit: commit,
        remoteCommit,
        remoteName,
        remoteUrl,
        uncertain: true,
      });
    }
    await this.pendingPushState.clear(pendingKey, commit);
    return { kind: 'governance', commit, pushed: true, remoteCommit, pushRetried };
  }

  async syncCode(input: CodeSyncInput): Promise<GitSyncResult> {
    if (!input.testsPassed) throw new GitControllerError('TESTS_NOT_PASSED', 'Code sync requires passing tests');
    const allowedPaths = assertSafePathList(input.allowedPaths, 'Code paths');
    const protectedPaths = assertSafePathList(
      [...DEFAULT_PROTECTED_PATHS, ...(input.protectedPaths ?? [])],
      'Protected paths',
    );
    const reportPath = normalizePath(input.reportPath);
    if (!isValidRelativePath(reportPath)) {
      throw new GitControllerError('REPORT_MISSING', 'Report path is outside the repository', { paths: [reportPath] });
    }
    if (!allowedPaths.some((pattern) => matchesPath(reportPath, pattern))) {
      throw new GitControllerError('UNAUTHORIZED_CHANGE', 'Report path is outside the approved code scope', {
        paths: [reportPath],
      });
    }
    const reportAbsolutePath = resolve(input.baseline.repositoryRoot, reportPath);
    const reportRelativePath = normalizePath(relative(input.baseline.repositoryRoot, reportAbsolutePath));
    try {
      const reportStats = await stat(reportAbsolutePath);
      if (!reportStats.isFile()) throw new Error('report is not a file');
      await access(reportAbsolutePath);
    } catch (error) {
      throw new GitControllerError(
        'REPORT_MISSING',
        'Required Luna report is missing',
        { paths: [reportPath] },
        { cause: error },
      );
    }
    const current = await this.readSnapshot(input.baseline.repositoryRoot);
    this.assertIdentity(input.baseline, current, true);
    const message = `feat(luna): complete ${input.taskId}`;
    const existing = await this.findExistingCommit(input.baseline, current, message);
    let commit = existing;
    if (commit === null) {
      this.assertWorktreePaths(current.worktree, allowedPaths, protectedPaths);
      if (!current.worktree.some((path) => path === reportRelativePath)) {
        throw new GitControllerError('REPORT_MISSING', 'Luna report exists but was not produced in this run', {
          paths: [reportRelativePath],
        });
      }
      if (current.worktree.length === 0) throw new GitControllerError('NO_CHANGES', 'Code sync has no changes');
      await this.run(['add', '--', ...current.worktree], current.repositoryRoot);
      commit = await this.commit(message, current.repositoryRoot);
    } else if (current.worktree.length > 0) {
      throw new GitControllerError('BASELINE_CHANGED', 'Existing code commit is followed by new worktree changes', {
        paths: current.worktree,
      });
    }
    return this.pushAndReturn('code', commit, input.baseline, current.repositoryRoot);
  }

  private async pushAndReturn(
    kind: GitSyncResult['kind'],
    commit: string,
    baseline: GitBaseline,
    repositoryRoot: string,
  ): Promise<GitSyncResult> {
    await this.loadPendingPushState();
    const key = pendingPushKey(baseline);
    const pendingPush = await this.pendingPushState.read(key);
    const isPendingPush = pendingPush !== null && this.matchesPendingPush(pendingPush, baseline, commit);
    let remoteTip: string | null;
    try {
      remoteTip = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
    } catch (error) {
      await this.rememberPendingPush(key, baseline, commit);
      throw new GitControllerError(
        'PUSH_FAILED',
        'The local commit was retained because the remote baseline could not be verified',
        {
          localCommit: commit,
          remoteName: baseline.remoteName,
          remoteUrl: baseline.remoteUrl,
          uncertain: true,
        },
        { cause: error },
      );
    }
    if (remoteTip === commit) {
      await this.pendingPushState.clear(key, commit);
      return { kind, commit, pushed: true, remoteCommit: commit, pushRetried: false };
    }
    this.assertRemoteBaseline(baseline, remoteTip);

    const pushRetried = isPendingPush;
    try {
      await this.pushOnce(repositoryRoot, baseline);
      let observed: string | null;
      try {
        observed = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
      } catch (error) {
        throw new GitControllerError(
          'PUSH_FAILED',
          'Push completed but the remote commit could not be confirmed',
          {
            localCommit: commit,
            remoteName: baseline.remoteName,
            remoteUrl: baseline.remoteUrl,
            uncertain: true,
          },
          { cause: error },
        );
      }
      if (observed !== commit) {
        throw new GitControllerError('PUSH_FAILED', 'Push completed without the expected remote commit', {
          localCommit: commit,
          remoteCommit: observed,
          remoteName: baseline.remoteName,
          remoteUrl: baseline.remoteUrl,
        });
      }
      await this.pendingPushState.clear(key, commit);
      return { kind, commit, pushed: true, remoteCommit: observed, pushRetried };
    } catch (error) {
      if (!(error instanceof GitControllerError) || error.code !== 'PUSH_FAILED') throw error;
      await this.rememberPendingPush(key, baseline, commit);
      if (error.details.uncertain !== true) throw error;

      let observed: string | null;
      try {
        observed = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
      } catch (error) {
        throw new GitControllerError(
          'PUSH_FAILED',
          'The push result could not be confirmed; the local commit remains pending',
          {
            localCommit: commit,
            remoteName: baseline.remoteName,
            remoteUrl: baseline.remoteUrl,
            uncertain: true,
          },
          { cause: error },
        );
      }
      if (observed === commit) {
        await this.pendingPushState.clear(key, commit);
        return { kind, commit, pushed: true, remoteCommit: observed, pushRetried };
      }
      this.assertRemoteBaseline(baseline, observed);
      try {
        await this.pushOnce(repositoryRoot, baseline);
      } catch (retryError) {
        if (retryError instanceof GitControllerError && retryError.code === 'PUSH_FAILED') {
          await this.rememberPendingPush(key, baseline, commit);
        }
        throw retryError;
      }
      let afterRetry: string | null;
      try {
        afterRetry = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
      } catch (error) {
        await this.rememberPendingPush(key, baseline, commit);
        throw new GitControllerError(
          'PUSH_FAILED',
          'The retry push result could not be confirmed; the local commit remains pending',
          {
            localCommit: commit,
            remoteName: baseline.remoteName,
            remoteUrl: baseline.remoteUrl,
            uncertain: true,
          },
          { cause: error },
        );
      }
      if (afterRetry !== commit) {
        await this.rememberPendingPush(key, baseline, commit);
        throw new GitControllerError('PUSH_FAILED', 'Push response remained unconfirmed after retry', {
          localCommit: commit,
          remoteCommit: afterRetry,
          remoteName: baseline.remoteName,
          remoteUrl: baseline.remoteUrl,
          uncertain: true,
        });
      }
      await this.pendingPushState.clear(key, commit);
      return { kind, commit, pushed: true, remoteCommit: afterRetry, pushRetried: true };
    }
  }

  private async queryRemoteBranch(repositoryRoot: string, remoteName: string, branch: string): Promise<string | null> {
    const output = await this.run(['ls-remote', remoteName, `refs/heads/${branch}`], repositoryRoot);
    const hash = output.trim().split(/\s+/)[0] ?? '';
    return /^[a-f0-9]{40}$/i.test(hash) ? hash : null;
  }

  private matchesPendingPush(pendingPush: GitPendingPush, baseline: GitBaseline, commit: string): boolean {
    return (
      pendingPush.repositoryRoot === baseline.repositoryRoot &&
      pendingPush.remoteName === baseline.remoteName &&
      pendingPush.remoteUrl === baseline.remoteUrl &&
      pendingPush.branch === baseline.branch &&
      pendingPush.baselineRemoteTip === baseline.remoteTip &&
      pendingPush.commit === commit
    );
  }

  private async rememberPendingPush(key: string, baseline: GitBaseline, commit: string): Promise<void> {
    await this.pendingPushState.write(key, {
      repositoryRoot: baseline.repositoryRoot,
      remoteName: baseline.remoteName,
      remoteUrl: baseline.remoteUrl,
      branch: baseline.branch,
      baselineRemoteTip: baseline.remoteTip,
      commit,
    });
  }

  private async loadPendingPushState(): Promise<void> {
    await this.pendingPushState.load?.();
  }

  private async recoverPendingPush(record: GitPendingPushRecord): Promise<GitPendingPushRecovery> {
    try {
      const remoteCommit = await this.queryRemoteAfterFetch(record.pendingPush.repositoryRoot, record.pendingPush);
      if (remoteCommit === record.pendingPush.commit) {
        await this.pendingPushState.clear(record.key, record.pendingPush.commit);
        return { pendingPush: record.pendingPush, remoteCommit, status: 'confirmed' };
      }
      if (remoteCommit === record.pendingPush.baselineRemoteTip) {
        return { pendingPush: record.pendingPush, remoteCommit, status: 'pending' };
      }
      this.log('pending-push-remote-advanced', {
        branch: record.pendingPush.branch,
        remoteName: record.pendingPush.remoteName,
        remoteCommit,
        expected: record.pendingPush.baselineRemoteTip,
      });
      return { pendingPush: record.pendingPush, remoteCommit, status: 'remote-advanced' };
    } catch (error) {
      this.log('pending-push-recovery-unknown', {
        branch: record.pendingPush.branch,
        remoteName: record.pendingPush.remoteName,
        error: error instanceof Error ? error.name : 'unknown-error',
      });
      return { pendingPush: record.pendingPush, remoteCommit: null, status: 'unknown' };
    }
  }

  private async pushOnce(repositoryRoot: string, baseline: GitBaseline): Promise<void> {
    try {
      await this.run(['push', baseline.remoteName, baseline.branch], repositoryRoot);
    } catch (error) {
      if (error instanceof GitControllerError) {
        throw new GitControllerError(
          'PUSH_FAILED',
          'Git push failed; the local commit was retained',
          { ...error.details, remoteName: baseline.remoteName, remoteUrl: baseline.remoteUrl },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async queryRemoteAfterFetch(
    repositoryRoot: string,
    baseline: Pick<GitBaseline, 'remoteName' | 'branch'>,
  ): Promise<string | null> {
    await this.run(['fetch', '--no-tags', baseline.remoteName, baseline.branch], repositoryRoot);
    return this.queryRemote(repositoryRoot, baseline);
  }

  private async queryRemote(
    repositoryRoot: string,
    baseline: Pick<GitBaseline, 'remoteName' | 'branch'>,
  ): Promise<string | null> {
    try {
      return (
        await this.run(['rev-parse', `refs/remotes/${baseline.remoteName}/${baseline.branch}`], repositoryRoot)
      ).trim();
    } catch (error) {
      if (error instanceof GitControllerError && error.details.stderr?.includes('unknown revision')) return null;
      throw error;
    }
  }

  private assertRemoteBaseline(baseline: GitBaseline, remoteTip: string | null): void {
    if (remoteTip !== baseline.remoteTip) {
      throw new GitControllerError('BASELINE_CHANGED', 'Remote branch changed after baseline capture', {
        expected: baseline.remoteTip,
        remoteCommit: remoteTip,
        remoteName: baseline.remoteName,
        remoteUrl: baseline.remoteUrl,
      });
    }
  }

  private async findExistingCommit(
    baseline: GitBaseline,
    current: GitSnapshot,
    expectedMessage: string,
  ): Promise<string | null> {
    if (current.head === baseline.head) return null;
    const subject = await this.run(['log', '-1', '--format=%s'], current.repositoryRoot);
    let parent: string;
    try {
      parent = await this.run(['rev-parse', 'HEAD^'], current.repositoryRoot);
    } catch {
      throw new GitControllerError('BASELINE_CHANGED', 'Repository HEAD changed after baseline capture');
    }
    if (subject === expectedMessage && parent === baseline.head) return current.head;
    throw new GitControllerError('BASELINE_CHANGED', 'Repository HEAD changed outside the expected sync commit', {
      expected: baseline.head,
      head: current.head,
    });
  }

  private async commit(message: string, repositoryRoot: string): Promise<string> {
    try {
      await this.run(['commit', '-m', message], repositoryRoot);
      return await this.run(['rev-parse', 'HEAD'], repositoryRoot);
    } catch (error) {
      if (error instanceof GitControllerError) {
        throw new GitControllerError(
          'COMMIT_FAILED',
          'Git commit failed; no automatic cleanup was attempted',
          error.details,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private assertIdentity(baseline: GitBaseline, current: GitSnapshot, allowHeadChange = false): void {
    if (current.repositoryRoot !== baseline.repositoryRoot) {
      throw new GitControllerError('BASELINE_CHANGED', 'Repository root changed after baseline capture');
    }
    if (current.branch !== baseline.branch) {
      throw new GitControllerError('BASELINE_CHANGED', 'Repository branch changed after baseline capture', {
        expected: baseline.branch,
        branch: current.branch,
      });
    }
    if (!allowHeadChange && current.head !== baseline.head) {
      throw new GitControllerError('BASELINE_CHANGED', 'Repository HEAD changed after baseline capture', {
        expected: baseline.head,
        head: current.head,
      });
    }
    if (current.remoteUrl !== baseline.remoteUrl) {
      throw new GitControllerError('BASELINE_CHANGED', 'Repository remote changed after baseline capture', {
        expected: baseline.remoteUrl,
        remoteUrl: current.remoteUrl,
      });
    }
  }

  private assertWorktreePaths(paths: string[], allowed: string[], protectedPaths: string[]): void {
    const protectedPath = paths.find((path) => protectedPaths.some((pattern) => matchesPath(path, pattern)));
    if (protectedPath !== undefined) {
      throw new GitControllerError('PROTECTED_PATH', 'A protected path was modified', { paths: [protectedPath] });
    }
    const unauthorized = paths.filter((path) => !allowed.some((pattern) => matchesPath(path, pattern)));
    if (unauthorized.length > 0) {
      throw new GitControllerError('UNAUTHORIZED_CHANGE', 'Worktree contains files outside the approved scope', {
        paths: unauthorized,
      });
    }
  }

  private async readSnapshot(
    repositoryPath: string,
    excludedPaths: readonly string[] = DEFAULT_EXCLUDED_PATHS,
  ): Promise<GitSnapshot> {
    const requestedPath = resolve(repositoryPath);
    try {
      const stats = await stat(requestedPath);
      if (!stats.isDirectory()) throw new Error('repository path is not a directory');
    } catch (error) {
      throw new GitControllerError(
        'INVALID_REPOSITORY',
        'Target path is not a readable directory',
        {},
        { cause: error },
      );
    }
    const repositoryRoot = resolve((await this.run(['rev-parse', '--show-toplevel'], requestedPath)).trim());
    if (repositoryRoot === '')
      throw new GitControllerError('INVALID_REPOSITORY', 'Git did not return a repository root');
    const insideWorkTree = await this.run(['rev-parse', '--is-inside-work-tree'], repositoryRoot);
    if (insideWorkTree !== 'true') throw new GitControllerError('INVALID_REPOSITORY', 'Target is not a Git worktree');
    const [branch, head, remoteUrl, status] = await Promise.all([
      this.run(['branch', '--show-current'], repositoryRoot),
      this.run(['rev-parse', 'HEAD'], repositoryRoot),
      this.run(['remote', 'get-url', 'origin'], repositoryRoot),
      this.run(['status', '--porcelain=v1', '--untracked-files=all', '-z'], repositoryRoot),
    ]);
    if (head.trim() === '') throw new GitControllerError('NO_HEAD', 'Git repository has no readable HEAD commit');
    if (branch.trim() === '')
      throw new GitControllerError('BRANCH_MISMATCH', 'Git repository is detached; a named branch is required');
    const normalizedRemote = redactRemoteUrl(remoteUrl);
    if (normalizedRemote === null)
      throw new GitControllerError('REMOTE_MISSING', 'Git repository has no origin remote');
    return {
      repositoryRoot,
      remoteName: 'origin',
      remoteUrl: normalizedRemote,
      branch: branch.trim(),
      head: head.trim(),
      worktree: parseStatus(status, excludedPaths),
    };
  }

  private async run(args: readonly string[], cwd: string): Promise<string> {
    this.logger('git-command', { command: 'git', args: [...args], cwd });
    try {
      const result = await this.execFile('git', args, { cwd, shell: false, windowsHide: true });
      return result.stdout.trimEnd();
    } catch (error) {
      const stderr = redactOutput(String(errorProperty(error, 'stderr') ?? errorProperty(error, 'message') ?? ''));
      const details = {
        args: [...args],
        stderr,
        uncertain: isUncertainProcessFailure(error, stderr),
      } satisfies Record<string, unknown>;
      throw new GitControllerError('COMMAND_FAILED', `Git command failed: ${args[0] ?? 'unknown'}`, details, {
        cause: error,
      });
    }
  }

  private log(event: string, details: Record<string, unknown>): void {
    const safeDetails = {
      ...details,
      remoteUrl: typeof details.remoteUrl === 'string' ? redactRemoteUrl(details.remoteUrl) : details.remoteUrl,
    };
    this.logger(event, safeDetails);
  }
}

export { DEFAULT_EXCLUDED_PATHS, DEFAULT_PROTECTED_PATHS, matchesPath, normalizePath, parseStatus, redactOutput };
