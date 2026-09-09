import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectConfigService,
  ProjectConfigStore,
  normalizeProjectConfig,
  scanGitProject,
} from '../../src/main/project/config.js';

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
    expect(scan.governanceDocumentCandidates).toEqual([
      {
        id: 'discovered-governance:README.md',
        path: 'README.md',
        exists: true,
        audience: [],
        version: 1,
        status: 'candidate',
      },
    ]);
    expect(await store.get(scan.projectId)).toEqual(saved);
    const persisted = await readFile(storePath, 'utf8');
    expect(persisted).not.toContain('super-secret');
  });

  it('returns safe registered governance document candidates from a parseable manifest', async () => {
    const repository = await gitRepository();
    await mkdir(join(repository, 'docs', 'governance'), { recursive: true });
    await writeFile(join(repository, 'docs', 'governance', 'policy.md'), '# policy\n', 'utf8');
    await writeFile(
      join(repository, 'docs', 'governance', 'governance-manifest.yaml'),
      'version: 7\ndocuments:\n  - id: policy\n    path: docs/governance/policy.md\n    audience: [Sol]\n    version: 2\n    status: active\n    type: internal-policy\n',
      'utf8',
    );

    const scan = await scanGitProject(repository);
    expect(scan.governanceDocumentCandidates).toEqual([
      {
        id: 'policy',
        path: 'docs/governance/policy.md',
        exists: true,
        audience: ['Sol'],
        version: 2,
        status: 'active',
        type: 'internal-policy',
      },
      {
        id: 'discovered-governance:README.md',
        path: 'README.md',
        exists: true,
        audience: [],
        version: 1,
        status: 'candidate',
      },
    ]);
  });

  it('discovers only deterministic, allowlisted governance candidates without a manifest', async () => {
    const repository = await gitRepository();
    await writeFile(join(repository, 'AGENTS.md'), '# agents\n', 'utf8');
    await writeFile(join(repository, 'CONTRIBUTING.md'), '# contributing\n', 'utf8');
    await mkdir(join(repository, 'docs', 'architecture'), { recursive: true });
    await mkdir(join(repository, 'docs', 'random'), { recursive: true });
    await mkdir(join(repository, '.github'), { recursive: true });
    await writeFile(join(repository, 'docs', 'architecture', 'overview.md'), '# architecture\n', 'utf8');
    await writeFile(join(repository, 'docs', 'random', 'ignore.md'), '# ignore\n', 'utf8');
    await writeFile(join(repository, 'docs', 'security.md'), '# security\n', 'utf8');
    await writeFile(join(repository, '.github', 'SECURITY.md'), '# security\n', 'utf8');
    await writeFile(join(repository, '.github', 'notes.md'), '# ignore\n', 'utf8');

    const scan = await scanGitProject(repository);
    const paths = scan.governanceDocumentCandidates.map((candidate) => candidate.path);
    expect(paths).toEqual([...paths].sort((left, right) => left.localeCompare(right)));
    expect(paths).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'README.md',
        'CONTRIBUTING.md',
        'docs/architecture/overview.md',
        'docs/security.md',
        '.github/SECURITY.md',
      ]),
    );
    expect(paths).not.toEqual(expect.arrayContaining(['docs/random/ignore.md', '.github/notes.md']));
    const discovered = scan.governanceDocumentCandidates.filter((candidate) =>
      candidate.id.startsWith('discovered-governance:'),
    );
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered.every((candidate) => candidate.status === 'candidate' && candidate.exists)).toBe(true);
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

  it('re-scans Git before saving and rejects forged repository facts', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));

    await expect(
      service.save({
        ...scan,
        reportDirectory: 'reports',
        currentBranch: scan.currentBranch === 'HEAD' ? 'forged-branch' : 'forged-branch',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
    await expect(
      service.save({
        ...scan,
        reportDirectory: 'reports',
        headCommit: 'a'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
  });

  it('rejects report paths that resolve through a junction or symlink outside the repository', async () => {
    const repository = await gitRepository();
    const outside = await temporaryDirectory();
    const link = join(repository, 'reports-link');
    let linked = true;
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false;
    }

    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));
    if (linked) {
      await expect(service.save({ ...scan, reportDirectory: 'reports-link/new' })).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_PROJECT',
      });
    } else {
      await mkdir(join(repository, 'missing-parent'), { recursive: true });
      await expect(service.save({ ...scan, reportDirectory: 'missing-parent/new/reports' })).resolves.toMatchObject({
        reportDirectory: join(repository, 'missing-parent', 'new', 'reports'),
      });
    }
  });

  it('rejects dangling symlink path components when symlink creation is available', async () => {
    const repository = await gitRepository();
    const danglingLink = join(repository, 'dangling-reports');
    let linked = true;
    try {
      await symlink(join(repository, 'missing-target'), danglingLink, 'file');
    } catch {
      linked = false;
    }

    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));
    if (linked) {
      await expect(service.save({ ...scan, reportDirectory: 'dangling-reports/new' })).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_PROJECT',
      });
    } else {
      await expect(service.save({ ...scan, reportDirectory: 'missing-parent/new/reports' })).resolves.toMatchObject({
        reportDirectory: join(repository, 'missing-parent', 'new', 'reports'),
      });
    }
  });
});
