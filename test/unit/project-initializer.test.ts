import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectInitializer, type ProjectInitializerExecFile } from '../../src/main/project/initializer.js';
import { GovernanceManifestStore } from '../../src/main/governance/manifest.js';
import {
  stringifyWritingBlockTemplate,
  WRITING_BLOCK_TEMPLATE_FILENAMES,
  WRITING_BLOCK_TEMPLATE_PATHS,
  WRITING_BLOCK_TEMPLATES,
} from '../../src/shared/protocol/writing-block-templates.js';
import { parse, stringify } from 'yaml';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'web-chat2codex-initializer-'));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', cwd, ...args], {
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
  });
  return String(result.stdout).trim();
}

async function gitRepository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, 'init');
  await git(directory, 'config', 'user.email', 'initializer@example.invalid');
  await git(directory, 'config', 'user.name', 'Initializer Test');
  await writeFile(join(directory, 'README.md'), '# repository\n', 'utf8');
  await git(directory, 'add', 'README.md');
  await git(directory, 'commit', '-m', 'initial');
  return directory;
}

async function downgradeToLegacyManagedGovernance(repository: string): Promise<void> {
  const manifestPath = join(repository, 'docs', 'governance', 'governance-manifest.yaml');
  const manifest = parse(await readFile(manifestPath, 'utf8')) as { template_version: number; documents: unknown[] };
  manifest.template_version = 1;
  manifest.documents = manifest.documents.slice(0, 5);
  await writeFile(manifestPath, stringify(manifest), 'utf8');
  await rm(join(repository, 'docs', 'governance', 'templates'), { recursive: true, force: true });
}

describe('project initializer', () => {
  it('provides a non-interactive Git remote authorization check without persisting credentials', async () => {
    const directory = await temporaryDirectory();
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const executor: ProjectInitializerExecFile = async (_file, args, options) => {
      calls.push({ args: [...args], ...(options.env === undefined ? {} : { env: options.env }) });
      return { stdout: 'HEAD\t0123456789012345678901234567890123456789\n', stderr: '' };
    };

    const result = await new ProjectInitializer({ execFile: executor }).checkRemoteAccess({
      directory,
      remoteUrl: 'https://github.com/example/project.git',
    });

    expect(result).toMatchObject({ accessible: true, code: 'OK' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ['ls-remote', '--', 'https://github.com/example/project.git', 'HEAD'],
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  });

  it('clones with positional execFile arguments, no shell, and no commit or push', async () => {
    const parentDirectory = await temporaryDirectory();
    const canonicalParent = await realpath(parentDirectory);
    const targetDirectory = join(canonicalParent, 'cloned-project');
    const calls: Array<{ file: string; args: readonly string[]; options: { cwd: string; shell: false } }> = [];
    const executor: ProjectInitializerExecFile = async (file, args, options) => {
      calls.push({ file, args: [...args], options });
      if (args[0] === 'clone') {
        await mkdir(join(targetDirectory, '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse' && options.cwd !== canonicalParent) {
        return { stdout: `${options.cwd}\n`, stderr: '' };
      }
      throw new Error('not a repository');
    };

    const result = await new ProjectInitializer({ execFile: executor, runId: () => 'clone-run' }).initialize({
      mode: 'clone',
      parentDirectory,
      directoryName: 'cloned-project',
      remoteUrl: 'https://example.com/team/project.git',
    });

    expect(calls).toContainEqual({
      file: 'git',
      args: ['clone', '--', 'https://example.com/team/project.git', targetDirectory],
      options: { cwd: canonicalParent, shell: false, windowsHide: true },
    });
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    expect(calls.some((call) => ['commit', 'push'].includes(call.args[0] ?? ''))).toBe(false);
    expect(result).toMatchObject({
      mode: 'clone',
      projectRoot: await realpath(targetDirectory),
      backupPath: null,
      idempotent: false,
      governanceManifestPath: 'docs/governance/governance-manifest.yaml',
    });
    expect(result.changedPaths).toEqual(
      expect.arrayContaining([
        'docs/governance/README.md',
        'docs/governance/PROJECT_RULES.md',
        'docs/governance/DEVELOPMENT_WORKFLOW.md',
        'docs/governance/AGENT_ROLES.md',
        'docs/governance/GIT_POLICY.md',
        'docs/governance/governance-manifest.yaml',
        ...Object.values(WRITING_BLOCK_TEMPLATE_PATHS),
      ]),
    );
  });

  it('passes a non-empty target branch to clone and rejects unsafe branch names', async () => {
    const parentDirectory = await temporaryDirectory();
    const canonicalParent = await realpath(parentDirectory);
    const targetDirectory = join(canonicalParent, 'branched-project');
    const calls: Array<readonly string[]> = [];
    const executor: ProjectInitializerExecFile = async (_file, args, options) => {
      calls.push([...args]);
      if (args[0] === 'clone') {
        await mkdir(join(targetDirectory, '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse' && options.cwd !== canonicalParent) return { stdout: `${options.cwd}\n`, stderr: '' };
      throw new Error('not a repository');
    };

    await new ProjectInitializer({ execFile: executor, runId: () => 'branch-run' }).initialize({
      mode: 'clone',
      parentDirectory,
      directoryName: 'branched-project',
      remoteUrl: 'https://example.com/team/project.git',
      targetBranch: 'release/2026',
    });
    expect(calls.find((args) => args[0] === 'clone')).toEqual([
      'clone',
      '--branch',
      'release/2026',
      '--',
      'https://example.com/team/project.git',
      targetDirectory,
    ]);

    await expect(
      new ProjectInitializer().initialize({
        mode: 'clone',
        parentDirectory,
        directoryName: 'invalid-branch-project',
        remoteUrl: 'https://example.com/team/project.git',
        targetBranch: 'bad..branch',
      }),
    ).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
  });

  it('backs up an existing governance tree before replacing it with the standard active manifest', async () => {
    const repository = await gitRepository();
    await mkdir(join(repository, 'docs', 'governance', 'nested'), { recursive: true });
    await writeFile(join(repository, 'docs', 'governance', 'legacy.md'), '# legacy\n', 'utf8');
    await writeFile(join(repository, 'docs', 'governance', 'nested', 'policy.txt'), 'legacy policy\n', 'utf8');

    const result = await new ProjectInitializer({ runId: () => 'backup-run' }).initialize({
      mode: 'adopt',
      targetDirectory: repository,
    });

    expect(result.backupPath).toBe('.web-chat2codex/backups/governance/backup-run');
    expect(
      await readFile(join(repository, '.web-chat2codex', 'backups', 'governance', 'backup-run', 'legacy.md'), 'utf8'),
    ).toBe('# legacy\n');
    expect(
      await readFile(
        join(repository, '.web-chat2codex', 'backups', 'governance', 'backup-run', 'nested', 'policy.txt'),
        'utf8',
      ),
    ).toBe('legacy policy\n');
    expect(result.changedPaths).toEqual(
      expect.arrayContaining(['docs/governance/legacy.md', 'docs/governance/nested/policy.txt']),
    );
    expect(result.changedPaths.some((path) => path.startsWith('.web-chat2codex/backups/'))).toBe(false);

    const governanceFiles = await readdir(join(repository, 'docs', 'governance'));
    expect(governanceFiles.sort()).toEqual(
      [
        'README.md',
        'PROJECT_RULES.md',
        'DEVELOPMENT_WORKFLOW.md',
        'AGENT_ROLES.md',
        'GIT_POLICY.md',
        'governance-manifest.yaml',
        'templates',
      ].sort(),
    );
    const templateDirectory = join(repository, 'docs', 'governance', 'templates', 'writing-blocks');
    expect((await readdir(templateDirectory)).sort()).toEqual(Object.values(WRITING_BLOCK_TEMPLATE_FILENAMES).sort());
    for (const [type, fileName] of Object.entries(WRITING_BLOCK_TEMPLATE_FILENAMES)) {
      const source = await readFile(join(templateDirectory, fileName), 'utf8');
      expect(JSON.parse(source)).toEqual(WRITING_BLOCK_TEMPLATES[type as keyof typeof WRITING_BLOCK_TEMPLATES]);
      expect(source).toBe(`${stringifyWritingBlockTemplate(type as keyof typeof WRITING_BLOCK_TEMPLATES)}\n`);
    }
    const manifest = await new GovernanceManifestStore(repository).load();
    expect(manifest).toMatchObject({
      managed_by: 'web-chat2codex',
      template_version: 2,
      governance_entry_point: 'docs/governance',
    });
    expect(manifest?.documents).toHaveLength(10);
    expect(manifest?.documents.every((document) => document.status === 'active')).toBe(true);
    expect(manifest?.documents.every((document) => document.path.startsWith('docs/governance/'))).toBe(true);
    expect(manifest?.documents.slice(5)).toEqual(
      expect.arrayContaining(
        Object.entries(WRITING_BLOCK_TEMPLATE_PATHS).map(([type, path]) =>
          expect.objectContaining({
            id: `writing-block-template-${type.toLowerCase().replaceAll('_', '-')}`,
            path,
            audience: expect.arrayContaining(['Sol', 'Codex']),
            version: 1,
            status: 'active',
            type: 'writing-block-template',
          }),
        ),
      ),
    );
    expect(await readFile(join(repository, 'docs', 'governance', 'README.md'), 'utf8')).toContain(
      "project's only governance entry point",
    );
  });

  it('is a no-op for an unchanged managed tree and rejects drift without overwriting it', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'idempotent-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });

    const repeated = await initializer.initialize({ mode: 'adopt', targetDirectory: repository });
    expect(repeated).toMatchObject({ changedPaths: [], backupPath: null, idempotent: true });

    const rulesPath = join(repository, 'docs', 'governance', 'PROJECT_RULES.md');
    await writeFile(rulesPath, '# locally changed\n', 'utf8');
    await expect(initializer.initialize({ mode: 'adopt', targetDirectory: repository })).rejects.toMatchObject({
      code: 'INITIALIZATION_DRIFT',
      message: expect.stringContaining('请先检查 details.paths，再手动处理或从备份恢复'),
      details: { paths: ['docs/governance/PROJECT_RULES.md'] },
    });
    expect(await readFile(rulesPath, 'utf8')).toBe('# locally changed\n');
    await expect(access(join(repository, '.web-chat2codex', 'backups', 'governance'))).rejects.toThrow();
  });

  it('recursively detects modified templates without overwriting or backing them up', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'template-drift-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });

    const templatePath = join(repository, 'docs', 'governance', 'templates', 'writing-blocks', 'blocked.template.json');
    await writeFile(templatePath, '{"code":"locally changed"}\n', 'utf8');

    await expect(initializer.initialize({ mode: 'adopt', targetDirectory: repository })).rejects.toMatchObject({
      code: 'INITIALIZATION_DRIFT',
      message: expect.stringContaining('托管治理文件或 Writing Block 模板已被修改'),
      details: { paths: ['docs/governance/templates/writing-blocks/blocked.template.json'] },
    });
    expect(await readFile(templatePath, 'utf8')).toBe('{"code":"locally changed"}\n');
    await expect(access(join(repository, '.web-chat2codex', 'backups', 'governance'))).rejects.toThrow();
  });

  it('reports missing standard templates and extra paths in recursive drift diagnostics', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'template-shape-drift-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });

    const templateDirectory = join(repository, 'docs', 'governance', 'templates', 'writing-blocks');
    await rm(join(templateDirectory, 'blocked.template.json'));
    await writeFile(join(templateDirectory, 'unexpected.json'), '{}\n', 'utf8');

    await expect(initializer.initialize({ mode: 'adopt', targetDirectory: repository })).rejects.toMatchObject({
      code: 'INITIALIZATION_DRIFT',
      message: expect.stringContaining('请先检查 details.paths，再手动处理或从备份恢复'),
      details: {
        paths: expect.arrayContaining([
          'docs/governance/templates/writing-blocks/blocked.template.json',
          'docs/governance/templates/writing-blocks/unexpected.json',
        ]),
      },
    });
  });

  it('reports a missing template directory and its standard files clearly', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'template-directory-drift-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });

    const templateDirectory = join(repository, 'docs', 'governance', 'templates', 'writing-blocks');
    await rm(templateDirectory, { recursive: true, force: true });

    await expect(initializer.initialize({ mode: 'adopt', targetDirectory: repository })).rejects.toMatchObject({
      code: 'INITIALIZATION_DRIFT',
      message: expect.stringContaining('治理目录结构已发生漂移'),
      details: {
        paths: expect.arrayContaining([
          'docs/governance/templates/writing-blocks',
          'docs/governance/templates/writing-blocks/blocked.template.json',
        ]),
      },
    });
  });

  it('reports a template version conflict without replacing the managed tree', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'version-conflict-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });
    const manifestPath = join(repository, 'docs', 'governance', 'governance-manifest.yaml');
    const conflictingManifest = (await readFile(manifestPath, 'utf8')).replace(
      'template_version: 2',
      'template_version: 99',
    );
    await writeFile(manifestPath, conflictingManifest, 'utf8');

    await expect(initializer.initialize({ mode: 'adopt', targetDirectory: repository })).rejects.toMatchObject({
      code: 'INITIALIZATION_DRIFT',
      message: expect.stringContaining('托管治理文件或 Writing Block 模板已被修改'),
      details: { paths: ['docs/governance/governance-manifest.yaml'] },
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(conflictingManifest);
    await expect(access(join(repository, '.web-chat2codex', 'backups', 'governance'))).rejects.toThrow();
  });

  it('reports a recoverable backup path when installation and rollback both fail', async () => {
    const repository = await gitRepository();
    await mkdir(join(repository, 'docs', 'governance'), { recursive: true });
    await writeFile(join(repository, 'docs', 'governance', 'legacy.md'), '# legacy\n', 'utf8');
    let renameCalls = 0;
    const rename = async (sourcePath: string, targetPath: string): Promise<void> => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('simulated installation rename failure');
      if (renameCalls === 3) throw new Error('simulated rollback rename failure');
      await fsRename(sourcePath, targetPath);
    };

    await expect(
      new ProjectInitializer({ runId: () => 'rename-failure-run', rename }).initialize({
        mode: 'adopt',
        targetDirectory: repository,
      }),
    ).rejects.toMatchObject({
      code: 'INITIALIZATION_FAILED',
      message: '治理模板安装失败且原目录回滚失败。',
      details: {
        backupPath: '.web-chat2codex/backups/governance/rename-failure-run',
        recovery: expect.stringContaining('恢复'),
      },
    });
    expect(
      await readFile(
        join(repository, '.web-chat2codex', 'backups', 'governance', 'rename-failure-run', 'legacy.md'),
        'utf8',
      ),
    ).toBe('# legacy\n');
    await expect(access(join(repository, 'docs', 'governance'))).rejects.toThrow();
  });

  it('reports an existing staging path without touching the governance tree', async () => {
    const repository = await gitRepository();
    const stagingPath = join(repository, '.web-chat2codex', 'staging', 'existing-run');
    await mkdir(stagingPath, { recursive: true });

    await expect(
      new ProjectInitializer({ runId: () => 'existing-run' }).initialize({
        mode: 'adopt',
        targetDirectory: repository,
      }),
    ).rejects.toMatchObject({
      code: 'INITIALIZATION_FAILED',
      details: {
        backupPath: null,
        recovery: expect.stringContaining('重试'),
      },
    });
    await expect(access(join(repository, 'docs', 'governance'))).rejects.toThrow();
  });

  it('upgrades an unchanged v1 managed tree atomically and backs up the old tree', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'v1-upgrade-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });
    await downgradeToLegacyManagedGovernance(repository);

    const result = await initializer.initialize({ mode: 'adopt', targetDirectory: repository });

    expect(result).toMatchObject({
      idempotent: false,
      backupPath: '.web-chat2codex/backups/governance/v1-upgrade-run',
    });
    expect(await readFile(join(repository, 'docs', 'governance', 'governance-manifest.yaml'), 'utf8')).toContain(
      'template_version: 2',
    );
    expect(
      await readFile(
        join(repository, '.web-chat2codex', 'backups', 'governance', 'v1-upgrade-run', 'governance-manifest.yaml'),
        'utf8',
      ),
    ).toContain('template_version: 1');
    expect(result.changedPaths).toEqual(expect.arrayContaining([...Object.values(WRITING_BLOCK_TEMPLATE_PATHS)]));
    expect(result.changedPaths.some((path) => path.startsWith('.web-chat2codex/backups/'))).toBe(false);
  });

  it('refuses to upgrade a modified v1 managed tree and preserves the user change', async () => {
    const repository = await gitRepository();
    const initializer = new ProjectInitializer({ runId: () => 'v1-drift-run' });
    await initializer.initialize({ mode: 'adopt', targetDirectory: repository });
    await downgradeToLegacyManagedGovernance(repository);
    const rulesPath = join(repository, 'docs', 'governance', 'PROJECT_RULES.md');
    await writeFile(rulesPath, '# locally changed legacy rules\n', 'utf8');

    await expect(initializer.initialize({ mode: 'adopt', targetDirectory: repository })).rejects.toMatchObject({
      code: 'INITIALIZATION_DRIFT',
      message: expect.stringContaining('托管治理 v1 文件已被修改'),
      details: { paths: ['docs/governance/PROJECT_RULES.md'] },
    });
    expect(await readFile(rulesPath, 'utf8')).toBe('# locally changed legacy rules\n');
    await expect(access(join(repository, '.web-chat2codex', 'backups', 'governance'))).rejects.toThrow();
  });

  it('rejects traversal, non-empty non-Git targets, and nested Git selections', async () => {
    const parentDirectory = await temporaryDirectory();
    await expect(
      new ProjectInitializer().initialize({
        mode: 'clone',
        parentDirectory,
        directoryName: '../escape',
        remoteUrl: 'https://example.com/team/project.git',
      }),
    ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });

    const conflict = await temporaryDirectory();
    await writeFile(join(conflict, 'not-git.txt'), 'content\n', 'utf8');
    await expect(
      new ProjectInitializer().initialize({ mode: 'adopt', targetDirectory: conflict }),
    ).rejects.toMatchObject({ code: 'TARGET_CONFLICT' });

    const repository = await gitRepository();
    const nested = join(repository, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    await expect(new ProjectInitializer().initialize({ mode: 'adopt', targetDirectory: nested })).rejects.toMatchObject(
      { code: 'NESTED_GIT_REPOSITORY' },
    );
    await expect(
      new ProjectInitializer().initialize({
        mode: 'clone',
        parentDirectory: repository,
        directoryName: 'nested-clone',
        remoteUrl: 'https://example.com/team/project.git',
      }),
    ).rejects.toMatchObject({ code: 'NESTED_GIT_REPOSITORY' });
  });

  it.each([
    'https://alice:secret@example.com/team/project.git',
    'https://ghp_secret@example.com/team/project.git',
    'https://example.com/team/project.git?token=secret',
    'ssh://git:secret@example.com/team/project.git',
  ])('rejects credential-bearing remotes without cloning or writing them to disk: %s', async (remoteUrl) => {
    const parentDirectory = await temporaryDirectory();
    const targetDirectory = join(parentDirectory, 'credential-test');
    const calls: Parameters<ProjectInitializerExecFile>[] = [];
    const executor: ProjectInitializerExecFile = async (...args) => {
      calls.push(args);
      throw new Error('not a repository');
    };
    let thrown: unknown;
    try {
      await new ProjectInitializer({ execFile: executor }).initialize({
        mode: 'clone',
        parentDirectory,
        directoryName: 'credential-test',
        remoteUrl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'REMOTE_CREDENTIALS_FORBIDDEN' });
    expect(JSON.stringify(thrown)).not.toContain('secret');
    expect(calls.some(([, args]) => args[0] === 'clone')).toBe(false);
    await expect(access(targetDirectory)).rejects.toThrow();
  });
});
