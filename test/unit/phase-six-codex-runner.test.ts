import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRunner, type CodexExecFile, type CodexProcess, type CodexTaskInput } from '../../src/main/codex/index.js';
import { parseWritingBlock, type LunaTaskBlock } from '../../src/shared/protocol/writing-block.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function task(reportPath = 'reports/task-1.md'): LunaTaskBlock {
  return parseWritingBlock(
    `[WRITING_BLOCK type="LUNA_TASK"]
{"task_id":"task-1","title":"Implement","objective":"Implement the task","base_commit":"BASE","scope":["src"],"out_of_scope":["docs/superpowers"],"deliverables":["code"],"validation_commands":["npm test"],"governance_revision":1,"architecture_revision_set":[1],"report_path":"${reportPath}","remote_sync_policy":"push"}
[/WRITING_BLOCK]`,
  ) as LunaTaskBlock;
}

async function targetRepository(): Promise<{ root: string; codex: string }> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'web-chat2codex-codex-'));
  directories.push(root);
  await mkdir(join(root, 'reports'), { recursive: true });
  const codex = join(root, 'codex.exe');
  await writeFile(codex, 'fake cli', 'utf8');
  return { root, codex };
}

function fakeExecutor(codexPath: string, overrides: { auth?: boolean; model?: boolean } = {}): CodexExecFile {
  return async (file, args, options) => {
    if (file === 'git') {
      const result = await execFile(file, [...args], { ...options, encoding: 'utf8' });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    }
    if (file !== codexPath) throw new Error(`unexpected executable: ${file}`);
    if (args[0] === '--version') return { stdout: 'codex-cli 0.152.1', stderr: '' };
    if (args[0] === 'login') {
      if (overrides.auth === false) throw new Error('not logged in');
      return { stdout: 'Logged in', stderr: '' };
    }
    if (args[0] === 'models') {
      if (overrides.model === false) return { stdout: JSON.stringify({ models: ['gpt-5.5'] }), stderr: '' };
      return { stdout: JSON.stringify({ models: ['gpt-5.6-luna'] }), stderr: '' };
    }
    throw new Error(`unexpected probe: ${args.join(' ')}`);
  };
}

function input(root: string, codex: string, reportPath = 'reports/task-1.md'): CodexTaskInput {
  return {
    task: task(reportPath),
    snapshots: { governance: { revision: 1 }, architecture: { revisions: [1] } },
    repositoryPath: root,
    executablePath: codex,
  };
}

function processFor(output: string, options: { exitCode?: number; never?: boolean } = {}): CodexProcess {
  return {
    stdout: output,
    stderr: 'stderr password=should-not-leak',
    wait: () => {
      if (options.never) return new Promise<number>(() => undefined);
      return Promise.resolve(options.exitCode ?? 0);
    },
    kill: () => undefined,
  };
}

describe('CodexRunner', () => {
  it('checks version, auth, model, and repository independently', async () => {
    const { root, codex } = await targetRepository();
    const runner = new CodexRunner({ execFile: fakeExecutor(codex), repositoryValidator: async () => true });
    const capabilities = await runner.checkCapabilities({ repositoryPath: root, executablePath: codex });
    expect(capabilities).toMatchObject({ version: 'codex-cli 0.152.1', authenticated: true, modelAvailable: true });
    await expect(
      new CodexRunner({
        execFile: fakeExecutor(codex, { auth: false }),
        repositoryValidator: async () => true,
      }).checkCapabilities({
        repositoryPath: root,
        executablePath: codex,
      }),
    ).rejects.toMatchObject({ code: 'CLI_AUTH_UNAVAILABLE' });
    await expect(
      new CodexRunner({
        execFile: fakeExecutor(codex, { model: false }),
        repositoryValidator: async () => true,
      }).checkCapabilities({
        repositoryPath: root,
        executablePath: codex,
      }),
    ).rejects.toMatchObject({ code: 'CLI_MODEL_UNAVAILABLE' });
  });

  it('runs a successful fake task with JSONL output and full-access configuration', async () => {
    const { root, codex } = await targetRepository();
    let processArgs: readonly string[] = [];
    const runner = new CodexRunner({
      execFile: fakeExecutor(codex),
      repositoryValidator: async () => true,
      gitStateCheck: async () => ({ valid: true }),
      processRunner: async (_file, args) => {
        processArgs = args;
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(
          outputPath,
          JSON.stringify({
            status: 'COMPLETED',
            summary: 'done',
            report_path: 'reports/task-1.md',
            tests: [{ status: 'PASSED' }],
          }),
          'utf8',
        );
        return processFor(JSON.stringify({ type: 'progress', message: 'running' }));
      },
    });
    const result = await runner.runTask(input(root, codex));
    expect(result.status).toBe('COMPLETED');
    expect(result.config).toEqual({ model: 'gpt-5.6-luna', sandbox: 'danger-full-access', approvalPolicy: 'never' });
    expect(processArgs.slice(0, 5)).toEqual(['exec', '--model', 'gpt-5.6-luna', '--sandbox', 'danger-full-access']);
    expect(processArgs).toContain('--json');
    expect(processArgs).not.toContain('push');
    expect(result.stderrSummary).not.toContain('should-not-leak');
  });

  const classifications: Array<
    [string, { exitCode?: number; report?: boolean; invalid?: boolean }, 'FAILED' | 'REPORT_MISSING' | 'INVALID_RESULT']
  > = [
    ['failure', { exitCode: 1 }, 'FAILED'],
    ['report missing', {}, 'REPORT_MISSING'],
    ['invalid output', { report: true, invalid: true }, 'INVALID_RESULT'],
  ];

  it.each(classifications)('classifies %s without enabling a push', async (_name, options, expected) => {
    const { root, codex } = await targetRepository();
    const runner = new CodexRunner({
      execFile: fakeExecutor(codex),
      repositoryValidator: async () => true,
      gitStateCheck: async () => ({ valid: true }),
      processRunner: async (_file, args) => {
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        if (options.report) await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(
          outputPath,
          options.invalid
            ? 'not a LUNA_RESULT'
            : JSON.stringify({
                status: 'COMPLETED',
                summary: 'done',
                report_path: 'reports/task-1.md',
                tests: [{ status: 'PASSED' }],
              }),
          'utf8',
        );
        return processFor('', options.exitCode === undefined ? {} : { exitCode: options.exitCode });
      },
    });
    const result = await runner.runTask(input(root, codex));
    expect(result.status).toBe(expected);
  });

  it('times out and rotates to a self-contained session without interrupting the prior process', async () => {
    const { root, codex } = await targetRepository();
    let processCount = 0;
    const runner = new CodexRunner({
      execFile: fakeExecutor(codex),
      repositoryValidator: async () => true,
      processRunner: async () => {
        processCount += 1;
        return {
          stdout: '',
          stderr: '',
          wait: () => new Promise<number>(() => undefined),
          kill: () => undefined,
        };
      },
      defaultTimeoutMs: 10,
      persistSessionChain: async () => undefined,
    });
    const timedOut = await runner.runTask(input(root, codex, 'reports/timeout.md'));
    expect(timedOut.status).toBe('TIMEOUT');
    const first = await runner.rotateSession({
      repositoryPath: root,
      executablePath: codex,
      snapshots: { governance: { revision: 2 }, architecture: { revisions: [2] } },
      handoff: {
        productGoal: 'goal',
        phase: 'phase-6',
        completedTasks: ['task-1'],
        commit: 'abc',
        governanceRevision: 2,
        architectureRevisionSet: [2],
        unresolvedIssues: [],
        nextStep: 'continue',
      },
    });
    const second = await runner.rotateSession({
      repositoryPath: root,
      executablePath: codex,
      previousSessionId: first.sessionId,
      snapshots: { governance: { revision: 3 }, architecture: { revisions: [3] } },
      handoff: {
        productGoal: 'goal',
        phase: 'phase-6',
        completedTasks: ['task-1'],
        commit: 'def',
        governanceRevision: 3,
        architectureRevisionSet: [3],
        unresolvedIssues: [],
        nextStep: 'continue',
      },
    });
    expect(processCount).toBe(3);
    expect(runner.getSessionChain()).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, parentSessionId: null }),
      expect.objectContaining({ sessionId: second.sessionId, parentSessionId: first.sessionId }),
    ]);
  });
});
