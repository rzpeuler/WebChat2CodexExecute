import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertProjectConfigMatchesScan,
  ProjectConfigService,
  ProjectConfigStore,
  normalizeProjectConfig,
  scanGitProject,
} from '../../src/main/project/config.js';
import { parseProjectConfig } from '../../src/shared/contracts/project-config.js';
import { ProjectInitializer } from '../../src/main/project/initializer.js';

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
    expect(scan.governanceManifestStatus).toBe('missing');
    expect(scan.governanceDocumentCandidates).toEqual([]);
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
    expect(scan.governanceManifestStatus).toBe('valid');
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
    ]);
  });

  it('does not infer external governance candidates from names without a manifest', async () => {
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
    expect(scan.governanceDocumentCandidates).toEqual([]);
  });

  it('reports a damaged manifest without inventing external governance candidates', async () => {
    const repository = await gitRepository();
    const manifestDirectory = join(repository, 'docs', 'governance');
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, 'governance-manifest.yaml'), 'documents: [', 'utf8');

    const scan = await scanGitProject(repository);
    expect(scan.governanceManifestStatus).toBe('invalid');
    expect(scan.governanceManifestError).toMatchObject({ code: 'MANIFEST_INVALID_YAML' });
    expect(scan.governanceDocumentCandidates).toEqual([]);
  });

  it('rejects saving when the scanned governance manifest is invalid', async () => {
    const repository = await gitRepository();
    const manifestDirectory = join(repository, 'docs', 'governance');
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, 'governance-manifest.yaml'), 'documents: [', 'utf8');
    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));

    await expect(service.save({ ...scan, reportDirectory: 'reports' })).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('治理 manifest 无效'),
    });
    await expect(service.loadAll()).resolves.toEqual([]);
  });

  it('fails closed when saving without a governance manifest even if templates remain', async () => {
    const repository = await gitRepository();
    await new ProjectInitializer({ runId: () => `missing-manifest-${directories.length}` }).initialize({
      mode: 'adopt',
      targetDirectory: repository,
    });
    await rm(join(repository, 'docs', 'governance', 'governance-manifest.yaml'));
    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));

    expect(scan.governanceManifestStatus).toBe('missing');
    expect(scan.governanceDocumentCandidates).toEqual([]);
    await expect(service.save({ ...scan, reportDirectory: 'reports' })).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('治理 manifest 缺失'),
    });
    await expect(service.loadAll()).resolves.toEqual([]);
  });

  it('rejects a custom governance manifest path before saving configuration', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));

    await expect(
      service.save({
        ...scan,
        reportDirectory: 'reports',
        governanceManifestPath: 'custom/governance-manifest.yaml',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('治理 manifest 路径必须固定为 docs/governance/governance-manifest.yaml'),
    });
    await expect(service.loadAll()).resolves.toEqual([]);
  });

  it('rejects custom governance manifest paths at normalization and store boundaries', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const invalidInput = {
      ...scan,
      reportDirectory: 'reports',
      governanceManifestPath: 'custom/governance-manifest.yaml',
    };

    expect(() => normalizeProjectConfig(invalidInput)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_PROJECT_CONFIG',
        message: expect.stringContaining('治理 manifest 路径必须固定为 docs/governance/governance-manifest.yaml'),
      }),
    );

    const storePath = join(await temporaryDirectory(), 'projects.json');
    const store = new ProjectConfigStore(storePath);
    await expect(store.save(invalidInput)).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
    await writeFile(
      storePath,
      JSON.stringify([
        {
          schemaVersion: 1,
          projectId: 'persisted-invalid',
          localPath: repository,
          remoteUrl: null,
          targetBranch: scan.currentBranch,
          reportDirectory: join(repository, 'reports'),
          currentBranch: scan.currentBranch,
          headCommit: scan.headCommit,
          governanceManifestPath: 'custom/governance-manifest.yaml',
        },
      ]),
      'utf8',
    );
    await expect(store.loadAll()).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('治理 manifest 路径必须固定为'),
    });

    expect(() =>
      parseProjectConfig({
        ...scan,
        schemaVersion: 1,
        targetBranch: scan.currentBranch,
        reportDirectory: join(repository, 'reports'),
        remoteUrl: 'https://alice:secret@example.com/repo.git?token=secret-token',
      } as never),
    ).toThrowError('项目配置 remoteUrl 必须已脱敏，不能包含用户密码或 token 查询参数');
  });

  it('rejects persisted project facts that drift from a fresh Git scan', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const config = normalizeProjectConfig({ ...scan, reportDirectory: 'reports' });

    expect(() =>
      assertProjectConfigMatchesScan(config, {
        ...scan,
        currentBranch: `${scan.currentBranch}-drifted`,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_PROJECT_CONFIG',
        message: expect.stringContaining('当前分支与最新 Git 扫描不一致'),
      }),
    );
  });

  it('rejects a tampered projects.json containing a credential-bearing remote URL', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const storePath = join(await temporaryDirectory(), 'projects.json');
    await writeFile(
      storePath,
      JSON.stringify([
        {
          schemaVersion: 1,
          projectId: 'tampered-remote',
          localPath: repository,
          remoteUrl: 'https://alice:password-secret@example.com/repo.git?token=token-secret',
          targetBranch: scan.currentBranch,
          reportDirectory: join(repository, 'reports'),
          currentBranch: scan.currentBranch,
          headCommit: scan.headCommit,
          governanceManifestPath: scan.governanceManifestPath,
        },
      ]),
      'utf8',
    );
    await expect(new ProjectConfigStore(storePath).loadAll()).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('remoteUrl'),
    });
    try {
      await new ProjectConfigStore(storePath).loadAll();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('password-secret');
      expect((error as Error).message).not.toContain('token-secret');
    }
  });

  it('returns normalized redacted configs and rejects both corrupted project snapshots with a stable code', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const storePath = join(await temporaryDirectory(), 'projects.json');
    const store = new ProjectConfigStore(storePath);
    const saved = await store.save({ ...scan, reportDirectory: 'reports' });
    expect((await store.loadAll())[0]).toEqual(saved);

    await writeFile(storePath, '{not-json', 'utf8');
    await writeFile(`${storePath}.bak`, '[also-not-json', 'utf8');
    await expect(store.loadAll()).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: '项目配置主快照和备份快照均无效，未加载任何项目配置。',
    });
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

  it('re-scans Git before preview and rejects a stale HEAD baseline', async () => {
    const repository = await gitRepository();
    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));
    await writeFile(join(repository, 'changed.txt'), 'changed\n', 'utf8');
    await git(repository, 'add', 'changed.txt');
    await git(repository, 'commit', '-m', 'changed');

    await expect(service.previewSolPrompt({ ...scan, reportDirectory: 'reports' })).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
    });
  });

  it('re-scans Git before preview and rejects a stale remote baseline', async () => {
    const repository = await gitRepository();
    await git(repository, 'remote', 'add', 'origin', 'https://example.com/team/old.git');
    const scan = await scanGitProject(repository);
    const service = new ProjectConfigService(new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')));
    await git(repository, 'remote', 'set-url', 'origin', 'https://example.com/team/new.git');

    await expect(service.previewSolPrompt({ ...scan, reportDirectory: 'reports' })).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
    });
  });

  it('rejects a symlinked config persistence target before filesystem access', async () => {
    const repository = await gitRepository();
    const outside = await temporaryDirectory();
    const storePath = join(await temporaryDirectory(), 'projects.json');
    let linked = true;
    try {
      await symlink(join(outside, 'projects.json'), storePath, 'file');
    } catch {
      linked = false;
    }
    if (linked) {
      const scan = await scanGitProject(repository);
      await expect(
        new ProjectConfigStore(storePath).save({ ...scan, reportDirectory: 'reports' }),
      ).rejects.toMatchObject({ code: 'PROJECT_PATH_UNSAFE' });
    }
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
