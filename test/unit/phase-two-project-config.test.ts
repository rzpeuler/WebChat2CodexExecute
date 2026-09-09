import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectConfigStore, normalizeProjectConfig, scanGitProject } from '../../src/main/project/config.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'web-chat2codex-phase-two-'));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', cwd, ...args], { windowsHide: true });
  return result.stdout.trim();
}

async function gitRepository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, 'init');
  await git(directory, 'config', 'user.email', 'test@example.invalid');
  await git(directory, 'config', 'user.name', 'Phase Two Test');
  await writeFile(join(directory, 'README.md'), '# test\n', 'utf8');
  await git(directory, 'add', 'README.md');
  await git(directory, 'commit', '-m', 'initial');
  return directory;
}

describe('phase two project configuration', () => {
  it('scans Git metadata and atomically saves/reloads a redacted configuration', async () => {
    const repository = await gitRepository();
    await git(
      repository,
      'remote',
      'add',
      'origin',
      'https://alice:super-secret@example.com/team/repo.git?token=do-not-log',
    );
    const scan = await scanGitProject(repository);
    const storePath = join(await temporaryDirectory(), 'state', 'projects.json');
    const store = new ProjectConfigStore(storePath);
    const saved = await store.save({
      ...scan,
      reportDirectory: 'docs/task-reports',
      targetBranch: scan.currentBranch,
    });

    expect(saved.localPath).toBe(await realpath(repository));
    expect(saved.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(saved.remoteUrl).toBe('https://example.com/team/repo.git');
    expect(await store.get(scan.projectId)).toEqual(saved);
    const persisted = await readFile(storePath, 'utf8');
    expect(persisted).not.toContain('super-secret');
  });

  it('rejects non-repositories and report paths outside the repository', async () => {
    const directory = await temporaryDirectory();
    await expect(scanGitProject(directory)).rejects.toMatchObject({ code: 'NOT_GIT_REPOSITORY' });
    expect(() =>
      normalizeProjectConfig({
        localPath: directory,
        reportDirectory: '../outside',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PATH_OUTSIDE_PROJECT' }));
  });

  it('does not persist forbidden credential fields', async () => {
    const repository = await gitRepository();
    const store = new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json'));
    await expect(
      store.save({
        localPath: repository,
        reportDirectory: 'reports',
        projectId: 'safe',
        password: 'must-not-save',
      } as never),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_FIELD_FORBIDDEN' });
  });
});
