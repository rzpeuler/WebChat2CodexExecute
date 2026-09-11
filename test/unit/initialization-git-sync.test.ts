import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitController } from '../../src/main/git/git-controller.js';
import { ProjectInitializer } from '../../src/main/project/initializer.js';
import { WRITING_BLOCK_TEMPLATE_PATHS } from '../../src/shared/protocol/writing-block-templates.js';

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

  it('pushes a clone initialization only after the manifest and all five templates are committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-git-clone-init-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    await mkdir(remote, { recursive: true });
    await git(remote, 'init', '--bare');

    const project = join(root, 'project');
    await git(root, 'clone', remote, project);
    await git(project, 'config', 'user.email', 'initializer@example.invalid');
    await git(project, 'config', 'user.name', 'Initializer Test');
    const initialized = await new ProjectInitializer({ runId: () => 'clone-init-run' }).initialize({
      mode: 'adopt',
      targetDirectory: project,
    });

    const result = await new GitController().syncInitialization({
      repositoryPath: project,
      changedPaths: initialized.changedPaths,
      targetBranch: 'main',
      expectedRemoteUrl: remote,
    });
    const committedPaths = (await git(project, 'ls-tree', '-r', '--name-only', result.commit)).split('\n');
    const requiredPaths = ['docs/governance/governance-manifest.yaml', ...Object.values(WRITING_BLOCK_TEMPLATE_PATHS)];

    expect(result).toMatchObject({ pushed: true, remoteCommit: result.commit });
    expect(committedPaths).toEqual(expect.arrayContaining(requiredPaths));
    expect(await git(remote, 'ls-tree', '-r', '--name-only', result.commit)).toEqual(
      expect.stringContaining('docs/governance/governance-manifest.yaml'),
    );
    for (const path of Object.values(WRITING_BLOCK_TEMPLATE_PATHS)) {
      expect(await readFile(join(project, path), 'utf8')).not.toContain('Cookie');
    }
  });

  it('keeps initialization pending when push is rejected and confirms only after remote verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-git-pending-init-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const project = join(root, 'project');
    await mkdir(remote, { recursive: true });
    await git(remote, 'init', '--bare');
    await git(root, 'clone', remote, project);
    await git(project, 'config', 'user.email', 'initializer@example.invalid');
    await git(project, 'config', 'user.name', 'Initializer Test');
    await writeFile(join(project, 'governance.md'), '# Governance\n', 'utf8');

    let failPush = true;
    const controller = new GitController({
      execFile: async (file, args, options) => {
        if (file === 'git' && args[0] === 'push' && failPush) {
          failPush = false;
          throw Object.assign(new Error('remote rejected'), { stderr: 'remote rejected', uncertain: false });
        }
        const result = await execFile(file, [...args], { ...options, encoding: 'utf8' });
        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      },
    });

    await expect(
      controller.syncInitialization({
        repositoryPath: project,
        changedPaths: ['governance.md'],
        targetBranch: 'main',
        expectedRemoteUrl: remote,
      }),
    ).rejects.toMatchObject({ code: 'PUSH_FAILED' });

    const retried = await controller.syncInitialization({
      repositoryPath: project,
      changedPaths: [],
      targetBranch: 'main',
      expectedRemoteUrl: remote,
    });
    expect(retried).toMatchObject({ pushed: true, remoteCommit: retried.commit, pushRetried: true });
    expect(await git(remote, 'rev-parse', 'refs/heads/main')).toBe(retried.commit);
  });

  it('keeps adoption backups local and excludes them from status, commit, and push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-git-backup-exclude-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const project = join(root, 'project');
    await mkdir(remote, { recursive: true });
    await git(remote, 'init', '--bare');
    await git(root, 'clone', remote, project);
    await git(project, 'config', 'user.email', 'initializer@example.invalid');
    await git(project, 'config', 'user.name', 'Initializer Test');
    await mkdir(join(project, 'docs', 'governance'), { recursive: true });
    await writeFile(join(project, 'docs', 'governance', 'legacy.md'), '# legacy\n', 'utf8');

    const initialized = await new ProjectInitializer({ runId: () => 'local-backup-run' }).initialize({
      mode: 'adopt',
      targetDirectory: project,
    });
    expect(initialized.changedPaths.some((path) => path.startsWith('.web-chat2codex/backups/'))).toBe(false);

    const result = await new GitController().syncInitialization({
      repositoryPath: project,
      changedPaths: initialized.changedPaths,
      targetBranch: 'main',
      expectedRemoteUrl: remote,
    });
    const committedPaths = (await git(project, 'ls-tree', '-r', '--name-only', result.commit)).split('\n');
    expect(committedPaths.some((path) => path.startsWith('.web-chat2codex/backups/'))).toBe(false);
    expect(await git(remote, 'ls-tree', '-r', '--name-only', result.commit)).not.toContain('.web-chat2codex/backups');
    expect(await git(project, 'status', '--porcelain', '--untracked-files=all')).toContain('.web-chat2codex/backups');
  });
});
