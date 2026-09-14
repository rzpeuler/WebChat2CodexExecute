import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexRunner,
  codexExecutableCandidates,
  promptForTask,
  type CodexExecFile,
  type CodexProcess,
  type CodexTaskInput,
} from '../../src/main/codex/index.js';
import { parseWritingBlock, type LunaTaskBlock } from '../../src/shared/protocol/writing-block.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function task(reportPath = 'reports/task-1.md', taskKind: 'IMPLEMENTATION' | 'TEST' = 'IMPLEMENTATION'): LunaTaskBlock {
  return parseWritingBlock(
    `[WRITING_BLOCK type="LUNA_TASK"]
{"task_kind":"${taskKind}","task_id":"task-1","title":"Implement","objective":"Implement the task","base_commit":"BASE","scope":["${taskKind === 'TEST' ? 'tests/**' : 'src'}"],"out_of_scope":["docs/superpowers"],"deliverables":["code"],"validation_commands":["npm test"],"governance_revision":1,"architecture_revision_set":[1],"report_path":"${reportPath}","remote_sync_policy":"push"}
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
    if (args[0] === 'exec') {
      if (overrides.model === false) throw new Error('requested model is unavailable');
      return { stdout: 'Run Codex non-interactively\n  -m, --model <MODEL>', stderr: '' };
    }
    throw new Error(`unexpected probe: ${args.join(' ')}`);
  };
}

function input(root: string, codex: string, reportPath = 'reports/task-1.md'): CodexTaskInput {
  return {
    task: task(reportPath),
    snapshots: {
      governance: { revision: 1 },
      architecture: { revisions: [1] },
      git: { baseCommit: 'BASE', branch: 'main', remote: 'origin', cleanWorktree: true },
    },
    repositoryPath: root,
    executablePath: codex,
    repositorySnapshot: { baseCommit: 'BASE', branch: 'main', remote: 'origin', cleanWorktree: true },
  };
}

function runnerOptions(
  root: string,
  codex: string,
): {
  execFile: CodexExecFile;
  repositoryValidator: () => Promise<boolean>;
  captureRepositorySnapshot: () => Promise<{
    baseCommit: string;
    branch: string;
    remote: string;
    cleanWorktree: boolean;
  }>;
  sessionStorePath: string;
  streamLogDirectory: string;
} {
  return {
    execFile: fakeExecutor(codex),
    repositoryValidator: async () => true,
    captureRepositorySnapshot: async () => ({
      baseCommit: 'BASE',
      branch: 'main',
      remote: 'origin',
      cleanWorktree: true,
    }),
    sessionStorePath: join(root, 'session-chain.json'),
    streamLogDirectory: join(root, 'stream-logs'),
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
  it('lists the standalone Windows Codex installation fallback locations', () => {
    expect(
      codexExecutableCandidates(
        {
          LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\tester',
          APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
        },
        ['9.9.9', '1.0.0'],
        'win32',
      ),
    ).toEqual([
      'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\9.9.9\\codex.exe',
      'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\1.0.0\\codex.exe',
      'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
      'C:\\Users\\tester\\.local\\bin\\codex.exe',
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.exe',
    ]);
  });

  it('skips Windows shell launchers returned before the native executable', async () => {
    const { root } = await targetRepository();
    const extensionless = join(root, 'codex');
    const commandShim = join(root, 'codex.cmd');
    const nativeExecutable = join(root, 'codex.exe');
    await writeFile(extensionless, '#!/bin/sh\n', 'utf8');
    await writeFile(commandShim, '@echo off\n', 'utf8');

    const runner = new CodexRunner({
      execFile: async (file, args) => {
        if (file === 'where.exe') {
          return { stdout: `${extensionless}\r\n${commandShim}\r\n${nativeExecutable}\r\n`, stderr: '' };
        }
        if (file !== nativeExecutable) throw new Error(`unexpected executable: ${file}`);
        if (args[0] === '--version') return { stdout: 'codex-cli 0.154.0', stderr: '' };
        if (args[0] === 'login') return { stdout: 'Logged in', stderr: '' };
        if (args[0] === 'exec') return { stdout: 'Codex execution entrypoint available', stderr: '' };
        throw new Error(`unexpected probe: ${args.join(' ')}`);
      },
      repositoryValidator: async () => true,
    });

    await expect(runner.checkCapabilities({ repositoryPath: root })).resolves.toMatchObject({
      executablePath: nativeExecutable,
      version: 'codex-cli 0.154.0',
      authenticated: true,
      modelAvailable: true,
    });
  });

  it('adds an execution authorization contract before running Luna', () => {
    const prompt = JSON.parse(
      promptForTask(task(), {
        governance: { revision: 1 },
        architecture: { revisions: [1] },
      }),
    ) as { instructions: Record<string, string> };

    expect(prompt.instructions.authorization).toContain('already approved this task');
    expect(prompt.instructions.authorization).toContain('Do not ask the user or ORCHESTRATOR');
    expect(prompt.instructions.authorization).toContain('planning skill or workflow');
    expect(prompt.instructions.result).toContain('exactly one JSON object');
  });

  it('checks version, auth, execution entrypoint, and repository independently', async () => {
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
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path],
      }),
      processRunner: async (_file, args) => {
        processArgs = args;
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(
          outputPath,
          JSON.stringify({
            identifier: 'LUNA_RESULT',
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
    expect(result.config).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(processArgs.slice(0, 9)).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--model',
      'gpt-5.6-luna',
      '--config',
      'model_reasoning_effort=medium',
      '--sandbox',
      'danger-full-access',
    ]);
    expect(processArgs).toContain('--json');
    expect(processArgs).not.toContain('push');
    expect(result.stderrSummary).not.toContain('should-not-leak');
  });

  it('accepts an object-valued LUNA_RESULT carried inside a JSONL agent message', async () => {
    const { root, codex } = await targetRepository();
    const resultBlock = JSON.stringify({
      identifier: 'LUNA_RESULT',
      status: 'COMPLETED',
      summary: 'done',
      report_path: 'reports/task-1.md',
      tests_status: 'PASSED',
      tests: [{ command: 'npm test', status: 'PASSED' }],
    });
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path],
      }),
      processRunner: async (_file, args) => {
        await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(args[args.indexOf('--output-last-message') + 1]!, resultBlock, 'utf8');
        return processFor(
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: resultBlock } }),
        );
      },
    });
    await expect(runner.runTask(input(root, codex))).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it.each([
    ['string item', { tests: ['npm test'] }, 'tests[0] must be an object'],
    [
      'unknown field',
      { tests: [{ command: 'npm test', status: 'PASSED', note: 'extra' }] },
      'unsupported fields: note',
    ],
    [
      'invalid status',
      { tests: [{ command: 'npm test', status: 'GREEN' }] },
      'status must be one of PASSED, FAILED, NOT_RUN',
    ],
    [
      'aggregate mismatch',
      { tests_status: 'PASSED', tests: [{ command: 'npm test', status: 'FAILED' }] },
      'tests_status=PASSED',
    ],
  ])('rejects invalid LUNA_RESULT tests structure: %s', async (_name, resultFields, diagnostic) => {
    const { root, codex } = await targetRepository();
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      processRunner: async (_file, args) => {
        await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(
          args[args.indexOf('--output-last-message') + 1]!,
          JSON.stringify({
            identifier: 'LUNA_RESULT',
            status: 'COMPLETED',
            summary: 'done',
            report_path: 'reports/task-1.md',
            ...resultFields,
          }),
          'utf8',
        );
        return processFor('');
      },
    });
    const result = await runner.runTask(input(root, codex));
    expect(result.status).toBe('INVALID_RESULT');
    expect(result.diagnostics.join('\n')).toContain(diagnostic);
  });

  it('completes a TEST task with failed test evidence when the report is valid', async () => {
    const { root, codex } = await targetRepository();
    await mkdir(join(root, 'tests'), { recursive: true });
    const testTask = task('reports/test-task.md', 'TEST');
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      gitStateCheck: async () => ({
        valid: true,
        changedPaths: ['tests/gateway.test.ts', 'reports/test-task.md'],
      }),
      processRunner: async (_file, args) => {
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        await writeFile(join(root, 'reports', 'test-task.md'), '# Failed test evidence\n', 'utf8');
        await writeFile(join(root, 'tests', 'gateway.test.ts'), 'test evidence\n', 'utf8');
        await writeFile(
          outputPath,
          JSON.stringify({
            identifier: 'LUNA_RESULT',
            status: 'COMPLETED',
            summary: 'The regression test exposed a defect.',
            report_path: 'reports/test-task.md',
            tests_status: 'FAILED',
            tests: [{ command: 'npm test -- gateway', status: 'FAILED' }],
          }),
          'utf8',
        );
        return processFor(JSON.stringify({ type: 'progress', message: 'running' }));
      },
    });
    const result = await runner.runTask({ ...input(root, codex), task: testTask });
    expect(result.status).toBe('COMPLETED');
    expect(result.protocolResult).toMatchObject({ testsStatus: 'FAILED' });
  });

  it('completes an IMPLEMENTATION task with failed validation evidence', async () => {
    const { root, codex } = await targetRepository();
    const implementationTask = task('reports/implementation.md', 'IMPLEMENTATION');
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path],
      }),
      processRunner: async (_file, args) => {
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        await writeFile(join(root, 'reports', 'implementation.md'), '# Validation evidence\n', 'utf8');
        await writeFile(
          outputPath,
          JSON.stringify({
            identifier: 'LUNA_RESULT',
            status: 'COMPLETED',
            summary: 'Implementation is complete; validation found a defect.',
            report_path: 'reports/implementation.md',
            tests_status: 'FAILED',
            tests: [{ command: 'npm test', status: 'FAILED' }],
          }),
          'utf8',
        );
        return processFor(JSON.stringify({ type: 'progress', message: 'running' }));
      },
    });
    const result = await runner.runTask({ ...input(root, codex), task: implementationTask });
    expect(result.status).toBe('COMPLETED');
  });

  it('keeps a valid IMPLEMENTATION FAILED result available for orchestrator code sync', async () => {
    const { root, codex } = await targetRepository();
    const implementationTask = task('reports/implementation-blocked.md', 'IMPLEMENTATION');
    await mkdir(join(root, 'src'), { recursive: true });
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path, 'src/feature.ts'],
      }),
      processRunner: async (_file, args) => {
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        await writeFile(join(root, 'reports', 'implementation-blocked.md'), '# CTO review required\n', 'utf8');
        await writeFile(join(root, 'src', 'feature.ts'), 'implementation evidence\n', 'utf8');
        await writeFile(
          outputPath,
          JSON.stringify({
            identifier: 'LUNA_RESULT',
            status: 'FAILED',
            summary: 'Implementation evidence is ready; a real-model blocker remains.',
            report_path: 'reports/implementation-blocked.md',
            tests_status: 'PASSED',
            tests: [{ command: 'npm test', status: 'PASSED' }],
          }),
          'utf8',
        );
        return processFor(JSON.stringify({ type: 'progress', message: 'running' }));
      },
    });
    const result = await runner.runTask({ ...input(root, codex), task: implementationTask });
    expect(result.status).toBe('FAILED');
    expect(result.protocolResult).toMatchObject({ status: 'FAILED' });
    expect(result.error).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
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
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path],
      }),
      processRunner: async (_file, args) => {
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        if (options.report) await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(
          outputPath,
          options.invalid
            ? 'not a LUNA_RESULT'
            : JSON.stringify({
                identifier: 'LUNA_RESULT',
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
      ...runnerOptions(root, codex),
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
    await first.result;
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

  it('returns BASELINE_CHANGED and never spawns when the captured repository differs', async () => {
    const { root, codex } = await targetRepository();
    let processCount = 0;
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      captureRepositorySnapshot: async () => ({
        baseCommit: 'OTHER',
        branch: 'main',
        remote: 'origin',
        cleanWorktree: true,
      }),
      processRunner: async () => {
        processCount += 1;
        return processFor('');
      },
    });

    const result = await runner.runTask(input(root, codex));
    expect(result.status).toBe('BASELINE_CHANGED');
    expect(result.error?.code).toBe('BASELINE_CHANGED');
    expect(processCount).toBe(0);
  });

  it('rejects rotation while a task is active and records terminal state before another spawn', async () => {
    const { root, codex } = await targetRepository();
    let processCount = 0;
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      processRunner: async () => {
        processCount += 1;
        return processFor('', { never: true });
      },
      defaultTimeoutMs: 10,
    });
    const first = await runner.startTask(input(root, codex, 'reports/active.md'));
    const rejected = await runner.rotateSession({
      repositoryPath: root,
      executablePath: codex,
      snapshots: { governance: {}, architecture: {} },
      handoff: {
        productGoal: 'goal',
        phase: 'phase-6',
        completedTasks: [],
        commit: 'BASE',
        governanceRevision: 1,
        architectureRevisionSet: [],
        unresolvedIssues: [],
        nextStep: 'continue',
      },
    });
    expect(rejected.status).toBe('FAILED');
    await expect(rejected.result).resolves.toMatchObject({ status: 'FAILED', error: { code: 'SESSION_ACTIVE' } });
    await expect(first.result).resolves.toMatchObject({ status: 'TIMEOUT' });
    expect(processCount).toBe(1);
  });

  it('fails closed for duplicate or non-JSON LUNA_RESULT blocks', async () => {
    const { root, codex } = await targetRepository();
    const resultBlock = JSON.stringify({
      identifier: 'LUNA_RESULT',
      status: 'COMPLETED',
      summary: 'done',
      report_path: 'reports/task-1.md',
      tests: [{ status: 'PASSED' }],
    });
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path],
      }),
      processRunner: async (_file, args) => {
        await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(args[args.indexOf('--output-last-message') + 1]!, resultBlock, 'utf8');
        return processFor(`${resultBlock}\n`);
      },
    });
    await expect(runner.runTask(input(root, codex))).resolves.toMatchObject({ status: 'INVALID_RESULT' });

    const invalid = new CodexRunner({
      ...runnerOptions(root, codex),
      processRunner: async (_file, args) => {
        await writeFile(args[args.indexOf('--output-last-message') + 1]!, 'LUNA_RESULT status: COMPLETED', 'utf8');
        return processFor('');
      },
    });
    await expect(invalid.runTask(input(root, codex))).resolves.toMatchObject({ status: 'INVALID_RESULT' });
  });

  it('tees bounded, recursively redacted stream chunks to JSONL', async () => {
    const { root, codex } = await targetRepository();
    const runner = new CodexRunner({
      ...runnerOptions(root, codex),
      gitStateCheck: async (_repositoryPath, currentTask) => ({
        valid: true,
        changedPaths: [currentTask.fields.report_path],
      }),
      processRunner: async (_file, args) => {
        await writeFile(join(root, 'reports', 'task-1.md'), '# Report\n', 'utf8');
        await writeFile(
          args[args.indexOf('--output-last-message') + 1]!,
          JSON.stringify({
            identifier: 'LUNA_RESULT',
            status: 'COMPLETED',
            summary: 'done',
            report_path: 'reports/task-1.md',
            tests: [{ status: 'PASSED' }],
          }),
          'utf8',
        );
        return processFor(JSON.stringify({ type: 'progress', nested: { password: 'hidden-value' } }));
      },
    });
    const result = await runner.runTask(input(root, codex));
    expect(result.status).toBe('COMPLETED');
    const log = await readFile(result.stdoutLogPath!, 'utf8');
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain('hidden-value');
  });

  it('fails closed for empty versions, ambiguous auth, and non-JSON model output', async () => {
    const { root, codex } = await targetRepository();
    const base = fakeExecutor(codex);
    const withProbe =
      (change: (args: readonly string[]) => { stdout: string; stderr: string } | null) =>
      async (file: string, args: readonly string[], options: Parameters<CodexExecFile>[2]) => {
        if (file === codex) {
          const changed = change(args);
          if (changed !== null) return changed;
        }
        return base(file, args, options);
      };

    await expect(
      new CodexRunner({
        repositoryValidator: async () => true,
        execFile: withProbe((args) => (args[0] === '--version' ? { stdout: '', stderr: '' } : null)),
      }).checkCapabilities({ repositoryPath: root, executablePath: codex }),
    ).rejects.toMatchObject({ code: 'CLI_VERSION_UNAVAILABLE' });
    await expect(
      new CodexRunner({
        repositoryValidator: async () => true,
        execFile: withProbe((args) => (args[0] === 'login' ? { stdout: 'unknown', stderr: '' } : null)),
      }).checkCapabilities({ repositoryPath: root, executablePath: codex }),
    ).rejects.toMatchObject({ code: 'CLI_AUTH_UNAVAILABLE' });
    await expect(
      new CodexRunner({
        repositoryValidator: async () => true,
        execFile: withProbe((args) => {
          if (args[0] === 'exec') throw new Error('requested model is unavailable');
          return null;
        }),
      }).checkCapabilities({ repositoryPath: root, executablePath: codex }),
    ).rejects.toMatchObject({ code: 'CLI_MODEL_UNAVAILABLE' });
  });

  it('normalizes spawn, stream, wait, and kill failures without rejecting runTask', async () => {
    const { root, codex } = await targetRepository();
    const spawnFailure = new CodexRunner({
      ...runnerOptions(root, codex),
      processRunner: async () => {
        throw new Error('spawn failed');
      },
    });
    await expect(spawnFailure.runTask(input(root, codex))).resolves.toMatchObject({
      status: 'FAILED',
      error: { code: 'PROCESS_SPAWN_FAILED' },
    });

    async function* brokenOutput(): AsyncIterable<string> {
      yield 'partial';
      throw new Error('stream failed');
    }
    const streamFailure = new CodexRunner({
      ...runnerOptions(root, codex),
      processRunner: async () => ({ stdout: brokenOutput(), stderr: '', wait: async () => 0 }),
    });
    await expect(streamFailure.runTask(input(root, codex))).resolves.toMatchObject({ status: 'FAILED' });

    const waitFailure = new CodexRunner({
      ...runnerOptions(root, codex),
      processRunner: async () => ({
        stdout: '',
        stderr: '',
        wait: async () => {
          throw new Error('wait failed');
        },
      }),
    });
    await expect(waitFailure.runTask(input(root, codex))).resolves.toMatchObject({
      status: 'FAILED',
      error: { code: 'PROCESS_WAIT_FAILED' },
    });

    const killFailure = new CodexRunner({
      ...runnerOptions(root, codex),
      defaultTimeoutMs: 5,
      processRunner: async () => ({
        stdout: '',
        stderr: '',
        wait: () => new Promise<number>(() => undefined),
        kill: () => {
          throw new Error('kill failed');
        },
      }),
    });
    await expect(killFailure.runTask(input(root, codex))).resolves.toMatchObject({ status: 'TIMEOUT' });
  });
});
