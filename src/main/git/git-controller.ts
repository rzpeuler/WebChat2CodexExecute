import { access, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { redactRemoteUrl } from '../project/config.js';
import {
  GitControllerError,
  type CaptureBaselineOptions,
  type CodeSyncInput,
  type GitBaseline,
  type GitCommandResult,
  type GitControllerOptions,
  type GitExecFile,
  type GitPendingPush,
  type GitPendingPushState,
  type GitSyncResult,
  type GovernanceSyncInput,
  type VerifyBaselineOptions,
} from './types.js';

const defaultExecFileCallback = promisify(execFileCallback);
const DEFAULT_PROTECTED_PATHS = ['docs/superpowers', 'docs/superpowers/**'];

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
  return [...new Set(normalized)];
}

function parseStatus(output: string): string[] {
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
  return [...new Set(paths)];
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
    this.pendingPushState = options.pendingPushState ?? new InMemoryGitPendingPushState();
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
      await this.run(['add', '--', ...allowedPaths], current.repositoryRoot);
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
    const key = pendingPushKey(baseline);
    const pendingPush = this.pendingPushState.read(key);
    const isPendingPush = pendingPush !== null && this.matchesPendingPush(pendingPush, baseline, commit);
    const remoteTip = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
    if (isPendingPush && remoteTip === commit) {
      this.pendingPushState.clear(key, commit);
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
      this.pendingPushState.clear(key, commit);
      return { kind, commit, pushed: true, remoteCommit: observed, pushRetried };
    } catch (error) {
      if (!(error instanceof GitControllerError) || error.code !== 'PUSH_FAILED') throw error;
      this.rememberPendingPush(key, baseline, commit);
      if (error.details.uncertain !== true) throw error;

      const observed = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
      if (observed === commit) {
        this.pendingPushState.clear(key, commit);
        return { kind, commit, pushed: true, remoteCommit: observed, pushRetried };
      }
      this.assertRemoteBaseline(baseline, observed);
      try {
        await this.pushOnce(repositoryRoot, baseline);
      } catch (retryError) {
        if (retryError instanceof GitControllerError && retryError.code === 'PUSH_FAILED') {
          this.rememberPendingPush(key, baseline, commit);
        }
        throw retryError;
      }
      const afterRetry = await this.queryRemoteAfterFetch(repositoryRoot, baseline);
      if (afterRetry !== commit) {
        this.rememberPendingPush(key, baseline, commit);
        throw new GitControllerError('PUSH_FAILED', 'Push response remained unconfirmed after retry', {
          localCommit: commit,
          remoteCommit: afterRetry,
          remoteName: baseline.remoteName,
          remoteUrl: baseline.remoteUrl,
          uncertain: true,
        });
      }
      this.pendingPushState.clear(key, commit);
      return { kind, commit, pushed: true, remoteCommit: afterRetry, pushRetried: true };
    }
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

  private rememberPendingPush(key: string, baseline: GitBaseline, commit: string): void {
    this.pendingPushState.write(key, {
      repositoryRoot: baseline.repositoryRoot,
      remoteName: baseline.remoteName,
      remoteUrl: baseline.remoteUrl,
      branch: baseline.branch,
      baselineRemoteTip: baseline.remoteTip,
      commit,
    });
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

  private async readSnapshot(repositoryPath: string): Promise<GitSnapshot> {
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
      worktree: parseStatus(status),
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

export { DEFAULT_PROTECTED_PATHS, matchesPath, normalizePath, parseStatus, redactOutput };
