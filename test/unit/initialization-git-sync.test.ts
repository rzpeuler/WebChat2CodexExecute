import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitController } from '../../src/main/git/git-controller.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8' });
  return String(result.stdout).trim();
}

describe('initialization Git sync', () => {
  it('creates and pushes the first commit for an empty remote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-git-init-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const project = join(root, 'project');
    await mkdir(remote, { recursive: true });
    await git(remote, 'init', '--bare');
    await git(root, 'clone', remote, project);
    await writeFile(join(project, 'governance.md'), '# Governance\n', 'utf8');

    const result = await new GitController().syncInitialization({
      repositoryPath: project,
      changedPaths: ['governance.md'],
      targetBranch: 'main',
      expectedRemoteUrl: remote,
    });

    expect(result.pushed).toBe(true);
    expect(result.remoteCommit).toBe(result.commit);
    expect(await git(project, 'branch', '--show-current')).toBe('main');
    expect(await git(remote, 'rev-parse', 'refs/heads/main')).toBe(result.commit);

    const repeated = await new GitController().syncInitialization({
      repositoryPath: project,
      changedPaths: [],
      targetBranch: 'main',
      expectedRemoteUrl: remote,
    });
    expect(repeated).toMatchObject({
      commit: result.commit,
      remoteCommit: result.commit,
      pushed: true,
      pushRetried: false,
    });
  });
});
