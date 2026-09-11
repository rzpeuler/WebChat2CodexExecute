import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  compileGovernanceReconciliationPromptForRuntime,
  createAutomationRuntime,
  GovernanceReconciliationPreflightError,
  runGovernanceReconciliationAfterTemplatePreflight,
  validateGovernanceReconciliationTemplatesForRuntime,
} from '../../src/main/automation-runtime.js';
import { GovernanceManifestError, GovernanceManifestStore } from '../../src/main/governance/manifest.js';
import { EdgeProfileManager, CdpConversationController } from '../../src/main/edge/index.js';
import { GitController } from '../../src/main/git/index.js';
import { MainOrchestrator } from '../../src/main/orchestration/index.js';
import type { NotificationService } from '../../src/main/notify/index.js';
import { ProjectInitializer } from '../../src/main/project/initializer.js';
import { ProjectConfigService, ProjectConfigStore, scanGitProject } from '../../src/main/project/config.js';
import {
  WRITING_BLOCK_TEMPLATE_PATHS,
  WRITING_BLOCK_TEMPLATE_VERSION,
} from '../../src/shared/protocol/writing-block-templates.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'web-chat2codex-template-validation-'));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', cwd, ...args], { windowsHide: true });
  return result.stdout.trim();
}

async function initializedRepository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, 'init');
  await git(directory, 'config', 'user.email', 'test@example.invalid');
  await git(directory, 'config', 'user.name', 'Template Validation Test');
  await writeFile(join(directory, 'README.md'), '# test\n', 'utf8');
  await git(directory, 'add', 'README.md');
  await git(directory, 'commit', '-m', 'initial');
  await new ProjectInitializer({ runId: () => `template-validation-${directories.length}` }).initialize({
    mode: 'adopt',
    targetDirectory: directory,
  });
  return directory;
}

async function preview(repository: string) {
  const scan = await scanGitProject(repository);
  return new ProjectConfigService(
    new ProjectConfigStore(join(await temporaryDirectory(), 'projects.json')),
  ).previewSolPrompt({
    ...scan,
    reportDirectory: 'reports',
  });
}

describe('Writing Block template validation', () => {
  it('reports validated fixed templates and keeps their contents out of prompts', async () => {
    const repository = await initializedRepository();
    const scan = await scanGitProject(repository);

    expect(scan.writingBlockTemplates).toMatchObject({
      status: 'valid',
      directory: 'docs/governance/templates/writing-blocks',
      version: WRITING_BLOCK_TEMPLATE_VERSION,
    });
    expect(scan.writingBlockTemplates.files).toHaveLength(5);

    const prompt = await preview(repository);
    expect(prompt.initializationPrompt).toContain('docs/governance/templates/writing-blocks');
    expect(prompt.initializationPrompt).toContain('Use JSON only');
    expect(prompt.initializationPrompt).toContain('trailing commas');
    expect(prompt.initializationPrompt).toContain('luna-task.template.json');
    expect(prompt.initializationPrompt).toContain('ordinary implementation details');
    expect(prompt.initializationPrompt).not.toContain('<填写唯一任务 ID>');
    expect(prompt.dynamicContext).not.toContain('<填写唯一任务 ID>');
    expect(prompt.dynamicContext).not.toContain('Rule: use \\"quoted\\" text');
  });

  it.each([
    ['missing', async (path: string) => rm(path)],
    ['invalid JSON', async (path: string) => writeFile(path, '{"schema_version": 1,}', 'utf8')],
    ['unsupported version', async (path: string) => writeFile(path, '{"schema_version": 99}', 'utf8')],
  ])('fails closed for %s templates with a Chinese, locatable error', async (_label, mutate) => {
    const repository = await initializedRepository();
    const relativePath = WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED;
    const absolutePath = join(repository, ...relativePath.split('/'));
    await mutate(absolutePath);

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.status).not.toBe('valid');
    expect(scan.writingBlockTemplates.error?.message).toContain(relativePath);
    expect(scan.writingBlockTemplates.error?.manifestPath).toContain('governance-manifest.yaml');
    await expect(preview(repository)).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('模板'),
    });
  });

  it('strictly decodes template bytes and blocks invalid UTF-8 instead of using replacement characters', async () => {
    const repository = await initializedRepository();
    const relativePath = WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED;
    const absolutePath = join(repository, ...relativePath.split('/'));
    await writeFile(absolutePath, Buffer.from([0x7b, 0x22, 0x73, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]));

    const scan = await scanGitProject(repository);

    expect(scan.writingBlockTemplates.status).toBe('invalid');
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_INVALID_UTF8',
      path: relativePath,
    });
    expect(scan.writingBlockTemplates.error?.message).toContain('无法可靠读取或计算 canonical-text-v1');
    expect(scan.writingBlockTemplates.error?.message).toContain('BLOCKED');
    expect(scan.writingBlockTemplates.error?.message).not.toContain('�');
  });

  it('fails closed when a template is not registered with the required manifest metadata', async () => {
    const repository = await initializedRepository();
    const manifestPath = join(repository, 'docs', 'governance', 'governance-manifest.yaml');
    const manifest = parse(await readFile(manifestPath, 'utf8')) as {
      documents: Array<{ path: string; status: string }>;
    };
    const document = manifest.documents.find((candidate) => candidate.path === WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED);
    if (!document) throw new Error('test fixture did not register blocked template');
    document.status = 'candidate';
    await writeFile(manifestPath, stringify(manifest), 'utf8');

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.status).toBe('invalid');
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_NOT_REGISTERED',
      path: WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED,
    });
    await expect(preview(repository)).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
  });

  it('fails closed when a fixed template path resolves through an outside symlink', async () => {
    const repository = await initializedRepository();
    const outside = await temporaryDirectory();
    const relativePath = WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED;
    const templatePath = join(repository, ...relativePath.split('/'));
    const outsidePath = join(outside, 'blocked.json');
    await writeFile(outsidePath, '{"schema_version":1}', 'utf8');
    let linked = true;
    try {
      await rm(templatePath);
      await symlink(outsidePath, templatePath, 'file');
    } catch {
      linked = false;
    }
    if (!linked) return;

    await expect(scanGitProject(repository)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_PROJECT',
      message: expect.stringContaining(relativePath),
    });
    await expect(preview(repository)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_PROJECT',
      message: expect.stringContaining('模板路径不安全'),
    });
  });

  it('rejects the reserved closing marker in a disk template', async () => {
    const repository = await initializedRepository();
    const relativePath = WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED;
    const absolutePath = join(repository, ...relativePath.split('/'));
    await writeFile(
      absolutePath,
      '{"schema_version":1,"code":"BLOCKED","reason":"bad \\u005b/WRITING_BLOCK]"}',
      'utf8',
    );

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_RESERVED_MARKER',
      path: relativePath,
    });
    expect(scan.writingBlockTemplates.error?.message).toContain('[/WRITING_BLOCK]');
  });

  it.each([
    [
      'missing known field',
      (template: Record<string, unknown>) => {
        delete template.reason;
      },
      'reason',
    ],
    [
      'wrong known field type',
      (template: Record<string, unknown>) => {
        template.reason = false;
      },
      'reason',
    ],
  ])('validates %s with the template type and field in the error', async (_label, mutate, field) => {
    const repository = await initializedRepository();
    const relativePath = WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED;
    const absolutePath = join(repository, ...relativePath.split('/'));
    const template = JSON.parse(await readFile(absolutePath, 'utf8')) as Record<string, unknown>;
    mutate(template);
    await writeFile(absolutePath, JSON.stringify(template), 'utf8');

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_INVALID_STRUCTURE',
      path: relativePath,
    });
    expect(scan.writingBlockTemplates.error?.message).toContain('type=BLOCKED');
    expect(scan.writingBlockTemplates.error?.message).toContain(field);
  });

  it('validates reconciliation guide variants as per-status output structures', async () => {
    const repository = await initializedRepository();
    const relativePath = WRITING_BLOCK_TEMPLATE_PATHS.GOVERNANCE_RECONCILIATION;
    const absolutePath = join(repository, ...relativePath.split('/'));
    const template = JSON.parse(await readFile(absolutePath, 'utf8')) as {
      variants: {
        PASS: Record<string, unknown>;
        CHANGES_REQUIRED: { files: Array<Record<string, unknown>> };
        BLOCKED: Record<string, unknown>;
      };
    };
    delete template.variants.PASS.status;
    const file = template.variants.CHANGES_REQUIRED.files[0];
    if (!file) throw new Error('test fixture did not include a reconciliation file');
    file.content = false;
    await writeFile(absolutePath, JSON.stringify(template), 'utf8');

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_INVALID_STRUCTURE',
      path: relativePath,
    });
    expect(scan.writingBlockTemplates.error?.message).toContain('type=GOVERNANCE_RECONCILIATION');
    expect(scan.writingBlockTemplates.error?.message).toContain('variants.PASS.status');
  });

  it('requires the supported top-level manifest template_version', async () => {
    const repository = await initializedRepository();
    const manifestPath = join(repository, 'docs', 'governance', 'governance-manifest.yaml');
    const manifest = parse(await readFile(manifestPath, 'utf8')) as { template_version: number };
    manifest.template_version = 99;
    await writeFile(manifestPath, stringify(manifest), 'utf8');

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_UNSUPPORTED_VERSION',
      path: 'docs/governance/templates/writing-blocks',
      actualVersion: 99,
    });
    expect(scan.writingBlockTemplates.error?.message).toContain('template_version=99');
    await expect(preview(repository)).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
  });

  it('rejects duplicate fixed template paths in the manifest', async () => {
    const repository = await initializedRepository();
    const manifestPath = join(repository, 'docs', 'governance', 'governance-manifest.yaml');
    const manifest = parse(await readFile(manifestPath, 'utf8')) as {
      documents: Array<Record<string, unknown>>;
    };
    const registered = manifest.documents.find((document) => document.path === WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED);
    if (!registered) throw new Error('test fixture did not register blocked template');
    manifest.documents.push({
      ...registered,
      id: 'writing-block-template-duplicate',
      path: `./${String(registered.path).replaceAll('/', '\\')}`,
    });
    await writeFile(manifestPath, stringify(manifest), 'utf8');

    const scan = await scanGitProject(repository);
    expect(scan.writingBlockTemplates.error).toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_DUPLICATE_REGISTRATION',
      path: WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED,
    });
    await expect(preview(repository)).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
  });

  it('prevents the automation reconciliation entrypoint from compiling or sending on template failure', async () => {
    const repository = await initializedRepository();
    const scan = await scanGitProject(repository);
    const project = {
      schemaVersion: 1 as const,
      projectId: scan.projectId,
      localPath: scan.localPath,
      remoteUrl: scan.remoteUrl,
      targetBranch: scan.currentBranch,
      reportDirectory: join(repository, 'reports'),
      currentBranch: scan.currentBranch,
      headCommit: scan.headCommit,
      governanceManifestPath: scan.governanceManifestPath,
    };
    const compiler = { compileGovernanceReconciliationPrompt: vi.fn(() => 'prompt') };
    const manifestStore = new GovernanceManifestStore(scan.localPath, 'docs/governance/governance-manifest.yaml');
    await expect(
      compileGovernanceReconciliationPromptForRuntime(compiler, manifestStore, project, scan.headCommit),
    ).resolves.toBe('prompt');
    expect(compiler.compileGovernanceReconciliationPrompt).toHaveBeenCalledOnce();

    const blockedPath = join(repository, ...WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED.split('/'));
    await writeFile(blockedPath, '{"schema_version": 99}', 'utf8');
    compiler.compileGovernanceReconciliationPrompt.mockClear();
    await expect(
      compileGovernanceReconciliationPromptForRuntime(compiler, manifestStore, project, scan.headCommit),
    ).rejects.toMatchObject({
      code: 'WRITING_BLOCK_TEMPLATE_VALIDATION_FAILED',
      message: expect.stringContaining(WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED),
    });
    expect(compiler.compileGovernanceReconciliationPrompt).not.toHaveBeenCalled();
  });

  it('preserves the manifest error code and details through runtime preflight', async () => {
    const cause = new GovernanceManifestError('MANIFEST_INVALID', 'manifest invalid for test');
    const manifestStore = { load: vi.fn(async () => Promise.reject(cause)) };
    const manifestPath = 'C:\\project\\docs\\governance\\governance-manifest.yaml';
    const project = {
      localPath: 'C:\\project',
      governanceManifestPath: manifestPath,
    } as never;

    await expect(validateGovernanceReconciliationTemplatesForRuntime(manifestStore, project)).rejects.toBeInstanceOf(
      GovernanceReconciliationPreflightError,
    );
    try {
      await validateGovernanceReconciliationTemplatesForRuntime(manifestStore, project);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MANIFEST_INVALID',
        details: { manifestPath },
        cause,
      });
    }
  });

  it('fails runtime preflight with MANIFEST_NOT_FOUND when the fixed manifest is missing', async () => {
    const repository = await initializedRepository();
    const scan = await scanGitProject(repository);
    await rm(scan.governanceManifestPath);
    const manifestStore = new GovernanceManifestStore(scan.localPath, scan.governanceManifestPath);

    await expect(
      validateGovernanceReconciliationTemplatesForRuntime(manifestStore, {
        localPath: scan.localPath,
        governanceManifestPath: scan.governanceManifestPath,
      } as never),
    ).rejects.toMatchObject({
      code: 'MANIFEST_NOT_FOUND',
      details: { manifestPath: scan.governanceManifestPath },
      cause: expect.any(GovernanceManifestError),
    });
  });

  it('blocks the real runtime reconciliation callback before Edge, Git, pause, or send', async () => {
    const repository = await initializedRepository();
    const scan = await scanGitProject(repository);
    await writeFile(
      join(repository, ...WRITING_BLOCK_TEMPLATE_PATHS.BLOCKED.split('/')),
      '{"schema_version":99}',
      'utf8',
    );
    const userDataDirectory = await temporaryDirectory();
    const project = {
      schemaVersion: 1 as const,
      projectId: scan.projectId,
      localPath: scan.localPath,
      remoteUrl: scan.remoteUrl,
      targetBranch: scan.currentBranch,
      reportDirectory: join(repository, 'reports'),
      currentBranch: scan.currentBranch,
      headCommit: scan.headCommit,
      governanceManifestPath: scan.governanceManifestPath,
    };
    const notifier = { notify: vi.fn() } as unknown as NotificationService;
    const edgeStart = vi.spyOn(EdgeProfileManager.prototype, 'startOrReuse');
    const observeSend = vi.spyOn(CdpConversationController.prototype, 'sendMessage');
    const captureBaseline = vi.spyOn(GitController.prototype, 'captureBaseline');
    const pause = vi.spyOn(MainOrchestrator.prototype, 'pause');
    const runtime = await createAutomationRuntime(project, userDataDirectory, notifier);
    try {
      await runtime.orchestrator.executeCommand({ command: 'governance-consistency-check' });
      expect(edgeStart).not.toHaveBeenCalled();
      expect(captureBaseline).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(observeSend).not.toHaveBeenCalled();
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'WRITING_BLOCK_TEMPLATE_VALIDATION_FAILED' }),
        }),
      );
    } finally {
      runtime.stop();
      edgeStart.mockRestore();
      observeSend.mockRestore();
      captureBaseline.mockRestore();
      pause.mockRestore();
    }
  });

  it('does not execute reconciliation side effects when template preflight fails', async () => {
    const operation = vi.fn(async () => 'side effect');
    const preflight = vi.fn(async () => {
      throw new Error('模板文件缺失：docs/governance/templates/writing-blocks/blocked.template.json');
    });

    await expect(runGovernanceReconciliationAfterTemplatePreflight(preflight, operation)).rejects.toThrow(
      '模板文件缺失',
    );
    expect(preflight).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects a custom manifest path at the runtime creation boundary', async () => {
    const repository = await initializedRepository();
    const scan = await scanGitProject(repository);
    const userDataDirectory = await temporaryDirectory();
    const notifier = { notify: vi.fn() } as never;

    await expect(
      createAutomationRuntime(
        {
          schemaVersion: 1,
          projectId: scan.projectId,
          localPath: scan.localPath,
          remoteUrl: scan.remoteUrl,
          targetBranch: scan.currentBranch,
          reportDirectory: join(repository, 'reports'),
          currentBranch: scan.currentBranch,
          headCommit: scan.headCommit,
          governanceManifestPath: join(repository, 'custom-governance-manifest.yaml'),
        },
        userDataDirectory,
        notifier,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PROJECT_CONFIG',
      message: expect.stringContaining('治理 manifest 路径必须固定为'),
    });
  });
});
