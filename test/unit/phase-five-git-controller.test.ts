import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitController,
  PersistentGitPendingPushState,
  type GitCommandResult,
  type GitExecFile,
  type GitPendingPush,
} from '../../src/main/git/index.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function command(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd, shell: false, windowsHide: true, encoding: 'utf8' });
  return String(result.stdout).trim();
}

async function repository(): Promise<{ root: string; remote: string }> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'web-chat2codex-git-'));
  const remote = join(root, 'remote.git');
  await mkdir(remote);
  directories.push(root);
  await command(root, ['init', '--bare', remote]);
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  await command(worktree, ['init', '-b', 'main']);
  await command(worktree, ['config', 'user.email', 'test@example.invalid']);
  await command(worktree, ['config', 'user.name', 'Test User']);
  await writeFile(join(worktree, 'README.md'), '# Test\n', 'utf8');
  await command(worktree, ['add', '--', 'README.md']);
  await command(worktree, ['commit', '-m', 'initial']);
  await command(worktree, ['remote', 'add', 'origin', remote]);
  await command(worktree, ['push', 'origin', 'main']);
  return { root: worktree, remote };
}

function realExecutor(): GitExecFile {
  return async (file, args, options): Promise<GitCommandResult> => {
    const result = await execFile(file, [...args], { ...options, encoding: 'utf8' });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
}

describe('GitController', () => {
  it('captures a clean baseline and rejects dirty, branch, HEAD, and remote changes', async () => {
    const { root, remote } = await repository();
    const controller = new GitController();
    const baseline = await controller.captureBaseline(root);

    await writeFile(join(root, 'unapproved.txt'), 'external\n', 'utf8');
    await expect(controller.verifyBaseline(baseline)).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    await rm(join(root, 'unapproved.txt'));

    await command(root, ['switch', '-c', 'other']);
    await expect(controller.verifyBaseline(baseline)).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    await command(root, ['switch', 'main']);

    await writeFile(join(root, 'README.md'), '# Changed externally\n', 'utf8');
    await command(root, ['add', '--', 'README.md']);
    await command(root, ['commit', '-m', 'external']);
    await expect(controller.verifyBaseline(baseline, { allowWorktreeChanges: true })).rejects.toMatchObject({
      code: 'BASELINE_CHANGED',
    });

    await command(root, ['remote', 'set-url', 'origin', `${remote}-changed`]);
    await expect(controller.verifyBaseline(baseline, { allowWorktreeChanges: true })).rejects.toMatchObject({
      code: 'BASELINE_CHANGED',
    });
  });

  it('commits governance changes, pushes them, and never emits a force option', async () => {
    const { root } = await repository();
    const calls: string[][] = [];
    const executor = async (file: string, args: readonly string[], options: Parameters<GitExecFile>[2]) => {
      calls.push([file, ...args]);
      return realExecutor()(file, args, options);
    };
    const controller = new GitController({ execFile: executor });
    const baseline = await controller.captureBaseline(root);
    await mkdir(join(root, 'docs', 'governance'), { recursive: true });
    await writeFile(join(root, 'docs', 'governance', 'policy.md'), '# Policy\n', 'utf8');

    const result = await controller.syncGovernance({
      baseline,
      changeId: 'change-1',
      changedPaths: ['docs/governance/policy.md'],
    });

    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await command(root, ['log', '-1', '--format=%s'])).toBe('chore(governance): sync change-1');
    expect(calls.filter((args) => args[1] === 'push').flat()).not.toContain('--force');
  });

  it('keeps a local commit after known push failure and retries idempotently without a second commit', async () => {
    const { root } = await repository();
    let failPush = true;
    const executor: GitExecFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push' && failPush) {
        failPush = false;
        throw Object.assign(new Error('remote rejected'), { stderr: 'remote rejected', uncertain: false });
      }
      return realExecutor()(file, args, options);
    };
    const controller = new GitController({ execFile: executor });
    const baseline = await controller.captureBaseline(root);
    await writeFile(join(root, 'governance.md'), '# Governance\n', 'utf8');
    const input = { baseline, changeId: 'retry-1', changedPaths: ['governance.md'] };

    await expect(controller.syncGovernance(input)).rejects.toMatchObject({ code: 'PUSH_FAILED' });
    const localCommit = await command(root, ['rev-parse', 'HEAD']);
    expect(await command(root, ['log', '--format=%s', '-2'])).toBe('chore(governance): sync retry-1\ninitial');
    const retried = await controller.syncGovernance(input);

    expect(retried.commit).toBe(localCommit);
    expect(await command(root, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await command(root, ['rev-parse', 'refs/remotes/origin/main'])).toBe(localCommit);
  });

  it('confirms a pending push after fetch when the remote already has the local commit', async () => {
    const { root } = await repository();
    const calls: string[][] = [];
    let pushCount = 0;
    const executor: GitExecFile = async (file, args, options) => {
      calls.push([file, ...args]);
      if (file === 'git' && args[0] === 'push' && pushCount++ === 0) {
        await realExecutor()(file, args, options);
        throw Object.assign(new Error('push response lost'), { stderr: 'remote rejected', uncertain: false });
      }
      return realExecutor()(file, args, options);
    };
    const controller = new GitController({ execFile: executor });
    const baseline = await controller.captureBaseline(root);
    await writeFile(join(root, 'confirmed.md'), '# Confirmed\n', 'utf8');
    const input = { baseline, changeId: 'confirmed-1', changedPaths: ['confirmed.md'] };

    await expect(controller.syncGovernance(input)).rejects.toMatchObject({ code: 'PUSH_FAILED' });
    const callsBeforeRecovery = calls.length;
    const result = await controller.syncGovernance(input);
    const recoveryCalls = calls.slice(callsBeforeRecovery);

    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.remoteCommit).toBe(result.commit);
    expect(result.pushRetried).toBe(false);
    expect(pushCount).toBe(1);
    expect(recoveryCalls.some((args) => args[1] === 'fetch')).toBe(true);
    expect(recoveryCalls.some((args) => args[1] === 'push')).toBe(false);
  });

  it('persists a pending push across controller instances and clears it after confirmation', async () => {
    const { root } = await repository();
    const statePath = join(dirname(root), 'pending-push-state', 'state.json');
    let failPush = true;
    const firstExecutor: GitExecFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push' && failPush) {
        failPush = false;
        throw Object.assign(new Error('remote rejected'), { stderr: 'remote rejected', uncertain: false });
      }
      return realExecutor()(file, args, options);
    };
    const baseline = await new GitController({
      execFile: firstExecutor,
      pendingPushStatePath: statePath,
    }).captureBaseline(root);
    await writeFile(join(root, 'restart.md'), '# Restart\n', 'utf8');
    const input = { baseline, changeId: 'restart-1', changedPaths: ['restart.md'] };

    await expect(
      new GitController({ execFile: firstExecutor, pendingPushStatePath: statePath }).syncGovernance(input),
    ).rejects.toMatchObject({ code: 'PUSH_FAILED' });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      version: 1,
      pendingPushes: expect.any(Object),
    });

    const result = await new GitController({ pendingPushStatePath: statePath }).syncGovernance(input);

    expect(result.pushRetried).toBe(true);
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads pending pushes at startup, queries the remote OID, and preserves an advanced remote', async () => {
    const { root, remote } = await repository();
    const statePath = join(dirname(root), 'pending-push-state', 'advanced.json');
    let failPush = true;
    const failingExecutor: GitExecFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push' && failPush) {
        failPush = false;
        throw Object.assign(new Error('remote rejected'), { stderr: 'remote rejected', uncertain: false });
      }
      return realExecutor()(file, args, options);
    };
    const firstController = new GitController({ execFile: failingExecutor, pendingPushStatePath: statePath });
    const baseline = await firstController.captureBaseline(root);
    await writeFile(join(root, 'advanced.md'), '# Advanced\n', 'utf8');
    const input = { baseline, changeId: 'advanced-1', changedPaths: ['advanced.md'] };
    await expect(firstController.syncGovernance(input)).rejects.toMatchObject({ code: 'PUSH_FAILED' });

    const external = join(dirname(root), 'external-startup');
    await command(root, ['clone', remote, external]);
    await command(external, ['switch', '-c', 'main', '--track', 'origin/main']);
    await command(external, ['config', 'user.email', 'external@example.invalid']);
    await command(external, ['config', 'user.name', 'External User']);
    await writeFile(join(external, 'external-startup.md'), '# External startup\n', 'utf8');
    await command(external, ['add', '--', 'external-startup.md']);
    await command(external, ['commit', '-m', 'external startup']);
    await command(external, ['push', 'origin', 'main']);

    let pushCount = 0;
    const recoveryController = new GitController({
      pendingPushStatePath: statePath,
      execFile: async (file, args, options) => {
        if (file === 'git' && args[0] === 'push') pushCount += 1;
        return realExecutor()(file, args, options);
      },
    });
    const recovery = await recoveryController.recoverPendingPushes();

    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ status: 'remote-advanced', pendingPush: { commit: expect.any(String) } });
    expect(recovery[0]?.remoteCommit).not.toBe(baseline.remoteTip);
    expect(pushCount).toBe(0);
    expect(JSON.parse(await readFile(statePath, 'utf8')).pendingPushes).not.toEqual({});
    await expect(recoveryController.syncGovernance(input)).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    expect(pushCount).toBe(0);
  });

  it('retains pending state when startup remote inspection is unknown', async () => {
    const { root } = await repository();
    const statePath = join(dirname(root), 'pending-push-state', 'unknown.json');
    let failPush = true;
    const firstExecutor: GitExecFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push' && failPush) {
        failPush = false;
        throw Object.assign(new Error('remote rejected'), { stderr: 'remote rejected', uncertain: false });
      }
      return realExecutor()(file, args, options);
    };
    const controller = new GitController({ execFile: firstExecutor, pendingPushStatePath: statePath });
    const baseline = await controller.captureBaseline(root);
    await writeFile(join(root, 'unknown.md'), '# Unknown\n', 'utf8');
    await expect(
      controller.syncGovernance({ baseline, changeId: 'unknown-1', changedPaths: ['unknown.md'] }),
    ).rejects.toMatchObject({ code: 'PUSH_FAILED' });

    const recovery = await new GitController({
      pendingPushStatePath: statePath,
      execFile: async (file, args, options) => {
        if (file === 'git' && args[0] === 'fetch') {
          throw Object.assign(new Error('network timeout'), { stderr: 'network timeout', uncertain: true });
        }
        return realExecutor()(file, args, options);
      },
    }).recoverPendingPushes();

    expect(recovery).toMatchObject([{ status: 'unknown', remoteCommit: null }]);
    expect(JSON.parse(await readFile(statePath, 'utf8')).pendingPushes).not.toEqual({});
  });

  it('serializes concurrent persistent updates without losing entries', async () => {
    const { root } = await repository();
    const statePath = join(dirname(root), 'pending-push-state', 'concurrent.json');
    const first: GitPendingPush = {
      repositoryRoot: root,
      remoteName: 'origin',
      remoteUrl: 'remote-a',
      branch: 'main',
      baselineRemoteTip: null,
      commit: 'commit-a',
    };
    const second = { ...first, remoteUrl: 'remote-b', commit: 'commit-b' };
    const firstState = new PersistentGitPendingPushState(statePath);
    const secondState = new PersistentGitPendingPushState(statePath);

    await Promise.all([firstState.write('first', first), secondState.write('second', second)]);

    await expect(new PersistentGitPendingPushState(statePath).list()).resolves.toEqual(
      expect.arrayContaining([
        { key: 'first', pendingPush: first },
        { key: 'second', pendingPush: second },
      ]),
    );
  });

  it('rejects an external remote tip advance before attempting a push', async () => {
    const { root, remote } = await repository();
    let pushCount = 0;
    const executor: GitExecFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push') pushCount += 1;
      return realExecutor()(file, args, options);
    };
    const controller = new GitController({ execFile: executor });
    const baseline = await controller.captureBaseline(root, { requireClean: true });

    const external = join(dirname(root), 'external');
    await command(root, ['clone', remote, external]);
    await command(external, ['switch', '-c', 'main', '--track', 'origin/main']);
    await command(external, ['config', 'user.email', 'external@example.invalid']);
    await command(external, ['config', 'user.name', 'External User']);
    await writeFile(join(external, 'external.md'), '# External\n', 'utf8');
    await command(external, ['add', '--', 'external.md']);
    await command(external, ['commit', '-m', 'external']);
    await command(external, ['push', 'origin', 'main']);

    await writeFile(join(root, 'blocked.md'), '# Blocked\n', 'utf8');

    await expect(
      controller.syncGovernance({
        baseline,
        changeId: 'stale-remote-1',
        changedPaths: ['blocked.md'],
      }),
    ).rejects.toMatchObject({
      code: 'BASELINE_CHANGED',
      details: { expected: baseline.remoteTip },
    });
    expect(pushCount).toBe(0);
  });

  it('uses fetch/query before retrying an uncertain push response', async () => {
    const { root } = await repository();
    let pushCount = 0;
    const executor: GitExecFile = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push' && pushCount++ === 0) {
        throw Object.assign(new Error('network timeout'), { stderr: 'network timeout', uncertain: true });
      }
      return realExecutor()(file, args, options);
    };
    const controller = new GitController({ execFile: executor });
    const baseline = await controller.captureBaseline(root);
    await writeFile(join(root, 'docs.md'), '# Docs\n', 'utf8');
    const result = await controller.syncGovernance({ baseline, changeId: 'uncertain-1', changedPaths: ['docs.md'] });

    expect(result.pushRetried).toBe(true);
    expect(pushCount).toBe(2);
  });

  it('requires a report, passing tests, and an approved non-protected change set for code sync', async () => {
    const { root } = await repository();
    const controller = new GitController();
    const baseline = await controller.captureBaseline(root);
    await mkdir(join(root, 'reports'), { recursive: true });
    await writeFile(join(root, 'reports', 'task.md'), '# Report\n', 'utf8');
    await writeFile(join(root, 'change.ts'), 'export const value = 1;\n', 'utf8');

    const result = await controller.syncCode({
      baseline,
      taskId: 'task-1',
      reportPath: 'reports/task.md',
      testsPassed: true,
      allowedPaths: ['change.ts', 'reports/**'],
    });
    expect(result.kind).toBe('code');

    const nextBaseline = await controller.captureBaseline(root);
    await mkdir(join(root, 'docs', 'superpowers'), { recursive: true });
    await writeFile(join(root, 'docs', 'superpowers', 'blocked.md'), 'blocked\n', 'utf8');
    await expect(
      controller.syncCode({
        baseline: nextBaseline,
        taskId: 'task-2',
        reportPath: 'reports/task-2.md',
        testsPassed: true,
        allowedPaths: ['reports/**', 'docs/superpowers/**'],
      }),
    ).rejects.toMatchObject({ code: 'REPORT_MISSING' });
    await expect(
      controller.syncCode({
        baseline: nextBaseline,
        taskId: 'task-2',
        reportPath: 'reports/task.md',
        testsPassed: false,
        allowedPaths: ['reports/**'],
      }),
    ).rejects.toMatchObject({ code: 'TESTS_NOT_PASSED' });
    expect(await readFile(join(root, 'change.ts'), 'utf8')).toContain('value');
  });
});
