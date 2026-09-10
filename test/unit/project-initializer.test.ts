import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectInitializer, type ProjectInitializerExecFile } from '../../src/main/project/initializer.js';
import { GovernanceManifestStore } from '../../src/main/governance/manifest.js';

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
      ]),
    );
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
      expect.arrayContaining([
        'docs/governance/legacy.md',
        'docs/governance/nested/policy.txt',
        '.web-chat2codex/backups/governance/backup-run/legacy.md',
        '.web-chat2codex/backups/governance/backup-run/nested/policy.txt',
      ]),
    );

    const governanceFiles = await readdir(join(repository, 'docs', 'governance'));
    expect(governanceFiles.sort()).toEqual(
      [
        'README.md',
        'PROJECT_RULES.md',
        'DEVELOPMENT_WORKFLOW.md',
        'AGENT_ROLES.md',
        'GIT_POLICY.md',
        'governance-manifest.yaml',
      ].sort(),
    );
    const manifest = await new GovernanceManifestStore(repository).load();
    expect(manifest).toMatchObject({
      managed_by: 'web-chat2codex',
      template_version: 1,
      governance_entry_point: 'docs/governance',
    });
    expect(manifest?.documents).toHaveLength(5);
    expect(manifest?.documents.every((document) => document.status === 'active')).toBe(true);
    expect(manifest?.documents.every((document) => document.path.startsWith('docs/governance/'))).toBe(true);
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
      details: { paths: ['docs/governance/PROJECT_RULES.md'] },
    });
    expect(await readFile(rulesPath, 'utf8')).toBe('# locally changed\n');
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
