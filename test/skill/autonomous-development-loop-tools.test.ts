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

function taskReport(taskId: string, baseline: string, overrides: Record<string, string> = {}): string {
  const fields = {
    task_id: taskId,
    status: 'READY_FOR_SOL_REVIEW',
    baseline,
    branch: 'main',
    implementation_commit: 'pending',
    verified_remote_tip: 'pending',
    sync_status: 'READY_TO_SYNC',
    summary: 'implementation complete',
    tests: 'passed',
    acceptance_criteria: 'satisfied',
    governance_status: 'unchanged',
    blockers: 'none',
    ...overrides,
  };
  return `${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`;
}

async function createPendingFixture(): Promise<{ parent: string; root: string; remote: string; baseline: string; implementation: string; pendingPath: string }> {
  const parent = await temporaryDirectory();
  const remote = join(parent, 'remote.git');
  const root = join(parent, 'project');
  await command(parent, ['git', 'init', '--bare', remote]);
  await mkdir(root, { recursive: true });
  await initializeRepository(root);
  await command(root, ['git', 'remote', 'add', 'origin', remote]);
  await command(root, ['git', 'push', '-u', 'origin', 'main']);
  const baseline = await command(root, ['git', 'rev-parse', 'HEAD']);
  const report = 'report.md';
  await writeFile(join(root, 'implementation.txt'), 'implementation\n', 'utf8');
  await writeFile(join(root, report), taskReport('TASK-PENDING', baseline), 'utf8');
  await command(root, ['git', 'add', '--', 'implementation.txt', report]);
  await command(root, ['git', 'commit', '-m', 'implementation']);
  const implementation = await command(root, ['git', 'rev-parse', 'HEAD']);
  const repositoryRoot = await command(root, ['git', 'rev-parse', '--show-toplevel']);
  const pendingPath = join(root, '.git', 'adl-pending-push.json');
  await writeFile(
    pendingPath,
    `${JSON.stringify({
      version: 2,
      phase: 'IMPLEMENTATION_PUSH',
      repository_root: repositoryRoot,
      remote_name: 'origin',
      branch: 'main',
      task_id: 'TASK-PENDING',
      baseline_head: baseline,
      expected_remote_tip: baseline,
      implementation_commit: implementation,
      finalization_commit: null,
      report_path: report,
    }, null, 2)}\n`,
    'utf8',
  );
  return { parent, root, remote, baseline, implementation, pendingPath };
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

  it('rejects semantically invalid report finalization fields and future time fields', async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    const baseline = await command(root, ['git', 'rev-parse', 'HEAD']);
    const report = 'report.md';
    const cases = [
      [taskReport('TASK-REPORT', baseline, { implementation_commit: 'not-a-sha', verified_remote_tip: 'not-a-sha', sync_status: 'SYNCED' }), 'REPORT_SYNC_STATE_INVALID'],
      [taskReport('TASK-REPORT', baseline), 'REPORT_TASK_MISMATCH'],
      [taskReport('TASK-REPORT', baseline), 'REPORT_BASELINE_MISMATCH'],
      [taskReport('TASK-REPORT', baseline, { sync_status: 'UNKNOWN' }), 'REPORT_SYNC_STATUS_INVALID'],
      [taskReport('TASK-REPORT', baseline) + 'ETA: tomorrow\n', 'REPORT_TIME_FIELD_FORBIDDEN'],
    ] as const;
    for (const [source, code] of cases) {
      await writeFile(join(root, report), source, 'utf8');
      const input = code === 'REPORT_TASK_MISMATCH'
        ? { repo: root, report_path: report, task_id: 'TASK-WRONG', baseline, branch: 'main' }
        : code === 'REPORT_BASELINE_MISMATCH'
          ? { repo: root, report_path: report, task_id: 'TASK-REPORT', baseline: '0'.repeat(40), branch: 'main' }
          : { repo: root, report_path: report, task_id: 'TASK-REPORT', baseline, branch: 'main' };
      const result = await runTool('validate-task-report', input);
      expect(result.code).toBe(code);
    }
  });

  it('rejects governance documents that assign predictive time to future work', async () => {
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
    await Promise.all(names.map((name) => writeFile(join(governance, name), name === 'PROJECT_EXECUTION_PLAN.md' ? 'ETA: tomorrow\n' : `# ${name}\n`, 'utf8')));
    const documents = names.map((name, index) => `  - id: doc-${index}\n    path: docs/governance/${name}\n    audience: [Luna]\n    version: 1\n    status: active`).join('\n');
    await writeFile(join(governance, 'governance-manifest.yaml'), `version: 1\ndocuments:\n${documents}\n`, 'utf8');
    const result = await runTool('validate-governance', { repo: root });
    expect(result.code).toBe('GOVERNANCE_TIME_FIELD_FORBIDDEN');
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
      `task_id: TASK-001\nstatus: READY_FOR_SOL_REVIEW\nbaseline: ${baselineRecord.head}\nbranch: main\nimplementation_commit: pending\nverified_remote_tip: pending\nsync_status: READY_TO_SYNC\nsummary: implementation complete\ntests: passed\nacceptance_criteria: satisfied\ngovernance_status: unchanged\nblockers: none\n`,
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
    expect(sync.implementation_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sync.verified_remote_tip).toBe(sync.implementation_commit);
    expect(sync.remote_tip).toMatch(/^[0-9a-f]{40}$/);
    const durableReport = await readFile(join(root, report), 'utf8');
    expect(durableReport).toContain(`implementation_commit: ${sync.implementation_commit}`);
    expect(durableReport).toContain(`verified_remote_tip: ${sync.implementation_commit}`);
    expect(durableReport).toContain('sync_status: SYNCED');
    expect(durableReport).not.toContain('implementation_commit: pending');
    expect(durableReport).not.toContain('verified_remote_tip: pending');
    expect(await command(root, ['git', 'status', '--porcelain'])).toBe('');
    expect(await command(root, ['git', 'ls-remote', 'origin', 'refs/heads/main'])).toContain(String(sync.remote_tip));
    const remoteReport = await command(root, ['git', 'show', `${sync.remote_tip}:${report}`]);
    expect(remoteReport).toContain(`implementation_commit: ${sync.implementation_commit}`);
    expect(remoteReport).toContain('sync_status: SYNCED');
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
      `task_id: TASK-REMOTE\nstatus: READY_FOR_SOL_REVIEW\nbaseline: ${baselineRecord.head}\nbranch: main\nimplementation_commit: pending\nverified_remote_tip: pending\nsync_status: READY_TO_SYNC\nsummary: remote guard\ntests: passed\nacceptance_criteria: satisfied\ngovernance_status: unchanged\nblockers: none\n`,
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

  it('recovers a pending push when remote already contains implementation commit C', async () => {
    const fixture = await createPendingFixture();
    await command(fixture.root, ['git', 'push', 'origin', 'main']);
    const result = await runTool('safe-git-sync', {
      repo: fixture.root,
      task_id: 'TASK-PENDING',
      baseline_head: fixture.baseline,
      remote: 'origin',
      branch: 'main',
      report_path: 'report.md',
    });
    expect(result.ok).toBe(true);
    expect(result.implementation_commit).toBe(fixture.implementation);
    expect(result.code).toBe('SYNCED');
  });

  it('retains pending state when remote remains at B and recovers a valid backup after interrupted write', async () => {
    const fixture = await createPendingFixture();
    await writeFile(`${fixture.pendingPath}.bak`, await readFile(fixture.pendingPath), 'utf8');
    await writeFile(fixture.pendingPath, '{"phase":', 'utf8');
    const blocked = join(fixture.parent, 'blocked');
    await command(fixture.parent, ['git', 'clone', '-b', 'main', fixture.remote, blocked]);
    await command(fixture.root, ['git', 'remote', 'set-url', 'origin', blocked]);
    const result = await runTool('safe-git-sync', {
      repo: fixture.root,
      task_id: 'TASK-PENDING',
      baseline_head: fixture.baseline,
      remote: 'origin',
      branch: 'main',
      report_path: 'report.md',
    });
    expect(result.code).toBe('PUSH_NOT_CONFIRMED');
    expect(result.recovered_from_pending_backup).toBe(true);
    expect(JSON.parse(await readFile(fixture.pendingPath, 'utf8')).implementation_commit).toBe(fixture.implementation);
  });

  it('classifies pending remote divergence and unknown state without overwrite', async () => {
    const divergent = await createPendingFixture();
    const other = join(divergent.parent, 'other');
    await command(divergent.parent, ['git', 'clone', '-b', 'main', divergent.remote, other]);
    await command(other, ['git', 'config', 'user.email', 'adl@example.invalid']);
    await command(other, ['git', 'config', 'user.name', 'ADL Other']);
    await writeFile(join(other, 'remote.txt'), 'advance\n', 'utf8');
    await command(other, ['git', 'add', '--', 'remote.txt']);
    await command(other, ['git', 'commit', '-m', 'remote advance']);
    await command(other, ['git', 'push', 'origin', 'main']);
    const divergentResult = await runTool('safe-git-sync', {
      repo: divergent.root,
      task_id: 'TASK-PENDING',
      baseline_head: divergent.baseline,
      remote: 'origin',
      branch: 'main',
      report_path: 'report.md',
    });
    expect(divergentResult.code).toBe('REMOTE_ADVANCED');

    const unknown = await createPendingFixture();
    await command(unknown.root, ['git', 'remote', 'set-url', 'origin', join(unknown.parent, 'missing-remote.git')]);
    const unknownResult = await runTool('safe-git-sync', {
      repo: unknown.root,
      task_id: 'TASK-PENDING',
      baseline_head: unknown.baseline,
      remote: 'origin',
      branch: 'main',
      report_path: 'report.md',
    });
    expect(unknownResult.code).toBe('REMOTE_UNKNOWN');
  });
});
