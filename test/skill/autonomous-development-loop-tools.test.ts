import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const workspace = resolve(import.meta.dirname, '..', '..');
const tools = join(workspace, 'skills', 'autonomous-development-loop', 'scripts');
const temporaryDirectories: string[] = [];

async function command(cwd: string, args: string[]): Promise<string> {
  const result = await execFile(args[0]!, args.slice(1), { cwd, shell: false, windowsHide: true, encoding: 'utf8' });
  return String(result.stdout).trim();
}

async function runTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const inputPath = join(tmpdir(), `adl-tool-${randomUUID()}.json`);
  await writeFile(inputPath, `${JSON.stringify(input)}\n`, 'utf8');
  try {
    const result = await execFile('node', [join(tools, `${name}.mjs`), '--input', inputPath], {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    return JSON.parse(String(result.stdout)) as Record<string, unknown>;
  } catch (error) {
    const failure = error as { stdout?: unknown };
    const output = String(failure.stdout ?? '{}');
    return JSON.parse(output) as Record<string, unknown>;
  } finally {
    await unlink(inputPath).catch(() => undefined);
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'adl-v1-'));
  temporaryDirectories.push(path);
  return path;
}

async function initializeRepository(root: string): Promise<void> {
  await command(root, ['git', 'init', '-b', 'main']);
  await command(root, ['git', 'config', 'user.email', 'adl@example.invalid']);
  await command(root, ['git', 'config', 'user.name', 'ADL Test']);
  await writeFile(join(root, 'README.md'), '# test\n', 'utf8');
  await command(root, ['git', 'add', '--', 'README.md']);
  await command(root, ['git', 'commit', '-m', 'initial']);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('autonomous development loop deterministic tools', () => {
  it('rejects protected and sensitive paths while allowing ordinary paths', async () => {
    await temporaryDirectory();
    const result = await runTool('check-protected-paths', { paths: ['src/app.ts', '.git/config', '.env.local'] });
    expect(result.ok).toBe(false);
    expect(result.protected_paths).toEqual(['.git/config']);
    expect(result.sensitive_paths).toEqual(['.env.local']);
  });

  it('validates a generic governance manifest and required ledger documents', async () => {
    const root = await temporaryDirectory();
    const governance = join(root, 'docs', 'governance');
    await mkdir(governance, { recursive: true });
    const names = [
      'CURRENT_STATUS.md',
      'PROJECT_EXECUTION_PLAN.md',
      'IMPLEMENTATION_HISTORY.md',
      'GOVERNANCE_CHANGELOG.md',
      'SOL_PROJECT_PROMPT_CANONICAL.md',
    ];
    await Promise.all(names.map((name) => writeFile(join(governance, name), `# ${name}\n`, 'utf8')));
    const documents = names.map((name, index) => `  - id: doc-${index}\n    path: docs/governance/${name}\n    audience: [Luna]\n    version: 1\n    status: active`).join('\n');
    await writeFile(
      join(governance, 'governance-manifest.yaml'),
      `version: 1\ngovernance_revision: 1\nsol_prompt_revision: 1\ndocuments:\n${documents}\n`,
      'utf8',
    );
    const result = await runTool('validate-governance', { repo: root });
    expect(result.ok).toBe(true);
    expect(result.document_count).toBe(5);
  });

  it('captures a baseline and safely commits and pushes a generic project', async () => {
    const parent = await temporaryDirectory();
    const remote = join(parent, 'remote.git');
    const root = join(parent, 'project');
    await command(parent, ['git', 'init', '--bare', remote]);
    await mkdir(root, { recursive: true });
    await initializeRepository(root);
    await command(root, ['git', 'remote', 'add', 'origin', remote]);
    await command(root, ['git', 'push', '-u', 'origin', 'main']);
    const baseline = await runTool('inspect-baseline', { repo: root, remote: 'origin' });
    const baselineRecord = baseline.baseline as Record<string, unknown>;
    const report = 'docs/task-reports/TASK-001.md';
    await mkdir(join(root, 'docs', 'task-reports'), { recursive: true });
    await writeFile(join(root, 'src.txt'), 'implemented\n', 'utf8');
    await writeFile(
      join(root, report),
      `task_id: TASK-001\nstatus: READY_FOR_SOL_REVIEW\nbaseline: ${baselineRecord.head}\nbranch: main\nfinal_commit: pending\nremote_verified: false\nsummary: implementation complete\ntests: passed\nacceptance_criteria: satisfied\ngovernance_status: unchanged\nblockers: none\n`,
      'utf8',
    );
    const sync = await runTool(
      'safe-git-sync',
      {
        repo: root,
        task_id: 'TASK-001',
        baseline_head: baselineRecord.head,
        baseline_remote_tip: baselineRecord.remote_tip,
        remote: 'origin',
        branch: 'main',
        report_path: report,
        allowed_paths: ['src.txt', 'docs/task-reports/**'],
        required_paths: [report],
        commit_message: 'feat: complete TASK-001',
      },
    );
    expect(sync.ok, JSON.stringify(sync)).toBe(true);
    expect(sync.code).toBe('SYNCED');
    expect(await command(root, ['git', 'status', '--porcelain'])).toBe('');
    expect(await command(root, ['git', 'ls-remote', 'origin', 'refs/heads/main'])).toContain(String(sync.commit));
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('implemented\n');
  });

  it('refuses to overwrite a remote branch that advanced after baseline capture', async () => {
    const parent = await temporaryDirectory();
    const remote = join(parent, 'remote.git');
    const root = join(parent, 'project');
    const other = join(parent, 'other');
    await command(parent, ['git', 'init', '--bare', remote]);
    await mkdir(root, { recursive: true });
    await initializeRepository(root);
    await command(root, ['git', 'remote', 'add', 'origin', remote]);
    await command(root, ['git', 'push', '-u', 'origin', 'main']);
    const baseline = await runTool('inspect-baseline', { repo: root, remote: 'origin' });
    const baselineRecord = baseline.baseline as Record<string, unknown>;
    await command(parent, ['git', 'clone', '-b', 'main', remote, other]);
    await command(other, ['git', 'config', 'user.email', 'adl@example.invalid']);
    await command(other, ['git', 'config', 'user.name', 'ADL Other']);
    await writeFile(join(other, 'remote.txt'), 'advanced\n', 'utf8');
    await command(other, ['git', 'add', '--', 'remote.txt']);
    await command(other, ['git', 'commit', '-m', 'remote advance']);
    await command(other, ['git', 'push', 'origin', 'main']);
    await writeFile(join(root, 'local.txt'), 'local\n', 'utf8');
    const report = 'report.md';
    await writeFile(
      join(root, report),
      `task_id: TASK-REMOTE\nstatus: READY_FOR_SOL_REVIEW\nbaseline: ${baselineRecord.head}\nbranch: main\nfinal_commit: pending\nremote_verified: false\nsummary: remote guard\ntests: passed\nacceptance_criteria: satisfied\ngovernance_status: unchanged\nblockers: none\n`,
      'utf8',
    );
    const sync = await runTool(
      'safe-git-sync',
      {
        repo: root,
        task_id: 'TASK-REMOTE',
        baseline_head: baselineRecord.head,
        baseline_remote_tip: baselineRecord.remote_tip,
        remote: 'origin',
        branch: 'main',
        report_path: report,
        allowed_paths: ['local.txt', report],
        commit_message: 'feat: complete TASK-REMOTE',
      },
    );
    expect(sync.code).toBe('REMOTE_ADVANCED');
    expect(await command(root, ['git', 'log', '-1', '--format=%s'])).toBe('initial');
  });
});
