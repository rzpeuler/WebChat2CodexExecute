import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { LunaTaskBlock } from '../../shared/protocol/writing-block.js';
import {
  CodexRunnerError,
  type CodexCapabilities,
  type CodexExecFile,
  type CodexExecFileResult,
  type CodexExecutionConfig,
  type CodexOutput,
  type CodexProcess,
  type CodexProcessRunner,
  type CodexRunnerOptions,
  type CodexRunResult,
  type CodexSessionHandle,
  type CodexSessionRecord,
  type CodexSessionResult,
  type CodexSnapshots,
  type CodexTaskHandle,
  type CodexTaskInput,
  type GitStateCheckResult,
  type LunaProtocolResult,
  type LunaTestResult,
  type SessionHandoff,
} from './types.js';

const defaultExecFileCallback = promisify(execFileCallback);
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROTECTED_PATHS = ['docs/superpowers', 'docs/superpowers/'];

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/([?&](?:token|password|secret|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*=\s*[^\s]+/gi, (match) => `${match.split('=')[0]}=[REDACTED]`)
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .trim()
    .slice(0, 3000);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    if (typeof record[name] === 'string' && record[name].trim() !== '') return record[name].trim();
  }
  return null;
}

function statusValue(value: unknown): LunaProtocolResult['status'] | null {
  return value === 'COMPLETED' || value === 'BLOCKED_EXTERNAL_SETUP' || value === 'FAILED' ? value : null;
}

function parseTests(value: unknown): LunaTestResult[] | null {
  if (!Array.isArray(value)) return null;
  const tests: LunaTestResult[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.status !== 'PASSED' && item.status !== 'FAILED' && item.status !== 'NOT_RUN')) {
      return null;
    }
    tests.push({
      ...(typeof item.command === 'string' ? { command: item.command } : {}),
      status: item.status,
      ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'command' && key !== 'status')),
    });
  }
  return tests;
}

function protocolFromRecord(value: unknown): LunaProtocolResult | null {
  if (!isRecord(value)) return null;
  const nested = value.result ?? value.luna_result ?? value.lunaResult;
  if (nested !== undefined) {
    const result = protocolFromRecord(nested);
    if (result !== null) return result;
  }
  const status = statusValue(value.status);
  const reportPath = stringField(value, 'report_path', 'reportPath');
  const summary = stringField(value, 'summary');
  const tests = parseTests(value.tests);
  if (status === null || reportPath === null || summary === null || tests === null) return null;
  return {
    status,
    summary,
    reportPath,
    tests,
    ...(Array.isArray(value.assumptions) ? { assumptions: value.assumptions } : {}),
    ...(Array.isArray(value.changes) ? { changes: value.changes } : {}),
    ...(Array.isArray(value.governance_gaps) ? { governanceGaps: value.governance_gaps } : {}),
  };
}

function protocolFromText(text: string): LunaProtocolResult | null {
  const marker = text.indexOf('LUNA_RESULT');
  if (marker < 0) return null;
  const body = text.slice(marker);
  const statusMatch = /(?:^|\n)\s*status\s*:\s*(COMPLETED|BLOCKED_EXTERNAL_SETUP|FAILED)\b/i.exec(body);
  const reportMatch = /(?:^|\n)\s*report_path\s*:\s*([^\n\r]+)/i.exec(body);
  const summaryMatch = /(?:^|\n)\s*summary\s*:\s*([^\n\r]+)/i.exec(body);
  if (statusMatch === null || reportMatch === null || summaryMatch === null) return null;
  const tests: LunaTestResult[] = [];
  for (const match of body.matchAll(/status\s*:\s*(PASSED|FAILED|NOT_RUN)\b/gi)) {
    const status = match[1] as LunaTestResult['status'];
    tests.push({ status });
  }
  if (tests.length === 0) return null;
  return {
    status: statusMatch[1]!.toUpperCase() as LunaProtocolResult['status'],
    summary: summaryMatch[1]!.trim(),
    reportPath: reportMatch[1]!.trim(),
    tests,
  };
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // A diagnostic line is retained in the summary, but never treated as a result.
    }
  }
  return events;
}

function findProtocol(
  stdout: string,
  lastMessage: string,
  events: Record<string, unknown>[],
): LunaProtocolResult | null {
  for (const event of [...events].reverse()) {
    const result = protocolFromRecord(event);
    if (result !== null) return result;
    const message = stringField(event, 'text', 'content', 'message', 'output');
    if (message !== null) {
      const parsed = protocolFromText(message);
      if (parsed !== null) return parsed;
    }
  }
  let parsedLastMessage: unknown = null;
  try {
    parsedLastMessage = JSON.parse(lastMessage);
  } catch {
    // The final message may be the documented text protocol instead of JSON.
  }
  return protocolFromRecord(parsedLastMessage) ?? protocolFromText(lastMessage) ?? protocolFromText(stdout);
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { cwd?: string; shell: false; windowsHide: boolean },
): Promise<CodexExecFileResult> {
  const result = await defaultExecFileCallback(file, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    shell: false,
    windowsHide: options.windowsHide,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function defaultProcessRunner(
  file: string,
  args: readonly string[],
  options: { cwd: string; shell: false; windowsHide: boolean },
): CodexProcess {
  const child: ChildProcess = spawn(file, [...args], {
    cwd: options.cwd,
    shell: false,
    windowsHide: options.windowsHide,
  });
  const wait = new Promise<number>((resolveWait, rejectWait) => {
    child.once('error', rejectWait);
    child.once('close', (code) => resolveWait(code ?? 1));
  });
  return {
    stdout: child.stdout === null ? '' : child.stdout,
    stderr: child.stderr === null ? '' : child.stderr,
    wait: () => wait,
    kill: () => child.kill(),
  };
}

async function collectOutput(output: CodexOutput): Promise<string> {
  if (typeof output === 'string') return output;
  const chunks: string[] = [];
  for await (const chunk of output)
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  return chunks.join('');
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalizePath(value);
  return normalized !== '' && !isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../');
}

function isProtectedPath(value: string): boolean {
  const normalized = normalizePath(value);
  return PROTECTED_PATHS.some((prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix));
}

function promptForTask(task: LunaTaskBlock, snapshots: CodexSnapshots): string {
  return JSON.stringify(
    {
      protocol: 'LUNA_TASK_EXECUTION',
      task: task.fields,
      governance_snapshot: snapshots.governance,
      architecture_snapshot: snapshots.architecture,
      instructions: {
        implementation: 'Decide implementation details inside scope without asking for ordinary confirmation.',
        blocking:
          'Emit BLOCKED_EXTERNAL_SETUP for external credentials, conflicts, scope expansion, or high-risk operations.',
        result: 'Write the required report and emit one machine-readable LUNA_RESULT.',
      },
    },
    null,
    2,
  );
}

function promptForHandoff(handoff: SessionHandoff, snapshots: CodexSnapshots): string {
  return JSON.stringify(
    {
      protocol: 'SESSION_HANDOFF',
      handoff,
      governance_snapshot: snapshots.governance,
      architecture_snapshot: snapshots.architecture,
    },
    null,
    2,
  );
}

export class CodexRunner {
  private readonly execFile: CodexExecFile;
  private readonly processRunner: CodexProcessRunner;
  private readonly repositoryValidator: ((repositoryPath: string) => Promise<boolean>) | undefined;
  private readonly gitStateCheck:
    ((repositoryPath: string, task: LunaTaskBlock) => Promise<GitStateCheckResult>) | undefined;
  private readonly persistSessionChain: ((chain: CodexSessionRecord[]) => Promise<void>) | undefined;
  private readonly logger: (event: string, details: Record<string, unknown>) => void;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly sessionChain: CodexSessionRecord[] = [];

  constructor(options: CodexRunnerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.repositoryValidator = options.repositoryValidator;
    this.gitStateCheck = options.gitStateCheck;
    this.persistSessionChain = options.persistSessionChain;
    this.logger = options.logger ?? (() => undefined);
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getSessionChain(): CodexSessionRecord[] {
    return this.sessionChain.map((record) => ({ ...record, handoff: { ...record.handoff } }));
  }

  async checkCapabilities(input: {
    repositoryPath: string;
    model?: string;
    executablePath?: string;
  }): Promise<CodexCapabilities> {
    const repositoryPath = await this.assertTargetRepository(input.repositoryPath);
    const executablePath = await this.resolveExecutable(input.executablePath);
    const version = await this.probe(executablePath, ['--version'], 'CLI_VERSION_UNAVAILABLE');
    await this.probe(executablePath, ['login', 'status'], 'CLI_AUTH_UNAVAILABLE');
    const model = input.model?.trim() || this.defaultModel;
    const modelProbe = await this.probe(executablePath, ['models', '--json'], 'CLI_MODEL_UNAVAILABLE');
    if (!this.modelsInclude(modelProbe.stdout, model)) {
      throw new CodexRunnerError('CLI_MODEL_UNAVAILABLE', `Codex model is unavailable: ${model}`, {
        model,
        stdout: redact(modelProbe.stdout),
      });
    }
    const execution: CodexExecutionConfig = { model, sandbox: 'danger-full-access', approvalPolicy: 'never' };
    const capabilities: CodexCapabilities = {
      executablePath,
      version: redact(version.stdout),
      authenticated: true,
      model,
      modelAvailable: true,
      targetRepository: repositoryPath,
      execution,
    };
    this.logger('codex-capabilities', {
      ...capabilities,
      executablePath: '<configured>',
      targetRepository: '<project>',
    });
    return capabilities;
  }

  async startTask(input: CodexTaskInput): Promise<CodexTaskHandle> {
    this.assertParsedTask(input.task);
    const capabilities = await this.checkCapabilities({
      repositoryPath: input.repositoryPath,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
    });
    const sessionId = randomUUID();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-luna-'));
    const lastMessagePath = join(outputDirectory, 'last-message.txt');
    const args = this.execArgs(capabilities.execution, lastMessagePath, promptForTask(input.task, input.snapshots));
    const process = await this.processRunner(capabilities.executablePath, args, {
      cwd: capabilities.targetRepository,
      shell: false,
      windowsHide: true,
    });
    const result = this.finishTask(process, {
      sessionId,
      task: input.task,
      repositoryPath: capabilities.targetRepository,
      lastMessagePath,
      outputDirectory,
      execution: capabilities.execution,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    });
    return { sessionId, status: 'RUNNING', result };
  }

  async runTask(input: CodexTaskInput): Promise<CodexRunResult> {
    const handle = await this.startTask(input);
    return handle.result;
  }

  async rotateSession(input: {
    repositoryPath: string;
    snapshots: CodexSnapshots;
    handoff: SessionHandoff;
    previousSessionId?: string;
    model?: string;
    executablePath?: string;
    timeoutMs?: number;
  }): Promise<CodexSessionHandle> {
    const capabilities = await this.checkCapabilities({
      repositoryPath: input.repositoryPath,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
    });
    const sessionId = randomUUID();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-handoff-'));
    const lastMessagePath = join(outputDirectory, 'last-message.txt');
    const process = await this.processRunner(
      capabilities.executablePath,
      this.execArgs(capabilities.execution, lastMessagePath, promptForHandoff(input.handoff, input.snapshots)),
      { cwd: capabilities.targetRepository, shell: false, windowsHide: true },
    );
    const record: CodexSessionRecord = {
      sessionId,
      parentSessionId: input.previousSessionId ?? null,
      handoff: {
        ...input.handoff,
        completedTasks: [...input.handoff.completedTasks],
        unresolvedIssues: [...input.handoff.unresolvedIssues],
      },
      createdAt: new Date().toISOString(),
    };
    this.sessionChain.push(record);
    await this.persistSessionChain?.(this.getSessionChain());
    const result = this.finishSession(
      process,
      sessionId,
      lastMessagePath,
      input.timeoutMs ?? this.defaultTimeoutMs,
    ).finally(() => rm(outputDirectory, { recursive: true, force: true }));
    return { sessionId, status: 'RUNNING', result };
  }

  private async finishTask(
    process: CodexProcess,
    input: {
      sessionId: string;
      task: LunaTaskBlock;
      repositoryPath: string;
      lastMessagePath: string;
      outputDirectory: string;
      execution: CodexExecutionConfig;
      timeoutMs: number;
    },
  ): Promise<CodexRunResult> {
    const sessionResult = await this.finishSession(process, input.sessionId, input.lastMessagePath, input.timeoutMs);
    let lastMessage = '';
    try {
      lastMessage = await readFile(input.lastMessagePath, 'utf8');
    } catch (error) {
      // The report/status result will be classified as INVALID_RESULT below.
      this.logger('codex-last-message-missing', { path: '<temporary>', error: String(error) });
    }
    await rm(input.outputDirectory, { recursive: true, force: true });
    const protocolResult = findProtocol(sessionResult.stdoutSummary, lastMessage, sessionResult.events);
    const base: CodexRunResult = {
      status: 'INVALID_RESULT',
      sessionId: input.sessionId,
      taskId: input.task.fields.task_id,
      exitCode: sessionResult.exitCode,
      ...(protocolResult === null ? {} : { protocolResult }),
      reportPath: input.task.fields.report_path,
      stdoutSummary: sessionResult.stdoutSummary,
      stderrSummary: sessionResult.stderrSummary,
      events: sessionResult.events,
      config: input.execution,
      diagnostics: [...sessionResult.diagnostics],
    };
    if (sessionResult.exitCode === null)
      return { ...base, status: 'TIMEOUT', diagnostics: [...base.diagnostics, 'Codex process exceeded the timeout'] };
    if (sessionResult.exitCode !== 0)
      return {
        ...base,
        status: 'FAILED',
        diagnostics: [...base.diagnostics, 'Codex process exited with a non-zero code'],
      };
    if (protocolResult === null)
      return { ...base, diagnostics: [...base.diagnostics, 'LUNA_RESULT protocol output is missing or invalid'] };
    if (protocolResult.status !== 'COMPLETED')
      return {
        ...base,
        status: 'FAILED',
        diagnostics: [...base.diagnostics, 'Luna reported a blocked or failed result'],
      };
    if (normalizePath(protocolResult.reportPath) !== normalizePath(input.task.fields.report_path)) {
      return { ...base, diagnostics: [...base.diagnostics, 'Luna report path does not match the task report path'] };
    }
    if (!protocolResult.tests.length || protocolResult.tests.some((test) => test.status !== 'PASSED')) {
      return {
        ...base,
        status: 'FAILED',
        diagnostics: [...base.diagnostics, 'Luna validation results are not all PASSED'],
      };
    }
    const reportStatus = await this.checkReport(input.repositoryPath, input.task.fields.report_path);
    if (!reportStatus.exists)
      return { ...base, status: 'REPORT_MISSING', diagnostics: [...base.diagnostics, reportStatus.reason] };
    const gitStatus = await this.checkGitState(input.repositoryPath, input.task);
    if (!gitStatus.valid)
      return {
        ...base,
        status: 'INVALID_RESULT',
        diagnostics: [...base.diagnostics, gitStatus.reason ?? 'Git state is invalid'],
      };
    return { ...base, status: 'COMPLETED' };
  }

  private async finishSession(
    process: CodexProcess,
    sessionId: string,
    lastMessagePath: string,
    timeoutMs: number,
  ): Promise<CodexSessionResult> {
    const stdoutPromise = collectOutput(process.stdout);
    const stderrPromise = collectOutput(process.stderr);
    const execution = Promise.all([process.wait(), stdoutPromise, stderrPromise]);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout(null), timeoutMs);
    });
    const completed = await Promise.race([execution, timeout]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (completed === null) {
      process.kill?.();
      return {
        sessionId,
        exitCode: null,
        stdoutSummary: redact(await Promise.race([stdoutPromise, Promise.resolve('')])),
        stderrSummary: redact(await Promise.race([stderrPromise, Promise.resolve('')])),
        events: [],
        diagnostics: [`Timed out after ${timeoutMs}ms; last message path: ${lastMessagePath}`],
      };
    }
    const [exitCode, stdout, stderr] = completed;
    const events = parseJsonLines(stdout);
    return {
      sessionId,
      exitCode,
      stdoutSummary: redact(stdout),
      stderrSummary: redact(stderr),
      events,
      diagnostics: [],
    };
  }

  private execArgs(execution: CodexExecutionConfig, outputPath: string, prompt: string): string[] {
    return [
      'exec',
      '--model',
      execution.model,
      '--sandbox',
      execution.sandbox,
      '--ask-for-approval',
      execution.approvalPolicy,
      '--json',
      '--output-last-message',
      outputPath,
      prompt,
    ];
  }

  private async resolveExecutable(configuredPath?: string): Promise<string> {
    if (configuredPath?.trim()) {
      try {
        const executable = resolve(configuredPath);
        const stats = await stat(executable);
        if (!stats.isFile()) throw new Error('not a file');
        return executable;
      } catch (error) {
        throw new CodexRunnerError(
          'CLI_NOT_FOUND',
          'Configured Codex executable is not available',
          {},
          { cause: error },
        );
      }
    }
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
      const result = await this.execFile(locator, ['codex'], { shell: false, windowsHide: true });
      const executable = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== '');
      if (executable === undefined) throw new Error('no executable path');
      return executable;
    } catch (error) {
      throw new CodexRunnerError('CLI_NOT_FOUND', 'Codex executable could not be located', {}, { cause: error });
    }
  }

  private async assertTargetRepository(repositoryPath: string): Promise<string> {
    const requested = resolve(repositoryPath);
    try {
      const stats = await stat(requested);
      if (!stats.isDirectory()) throw new Error('not a directory');
      if (this.repositoryValidator !== undefined) {
        if (!(await this.repositoryValidator(requested))) throw new Error('repository validator rejected path');
        return requested;
      }
      const result = await this.execFile('git', ['-C', requested, 'rev-parse', '--show-toplevel'], {
        shell: false,
        windowsHide: true,
      });
      const root = resolve(result.stdout.trim());
      if (root === '') throw new Error('git returned no root');
      return root;
    } catch (error) {
      throw new CodexRunnerError(
        'INVALID_TARGET_REPOSITORY',
        'Codex target path is not a valid Git repository',
        {},
        { cause: error },
      );
    }
  }

  private async probe(
    executablePath: string,
    args: string[],
    code: 'CLI_VERSION_UNAVAILABLE' | 'CLI_AUTH_UNAVAILABLE' | 'CLI_MODEL_UNAVAILABLE',
  ): Promise<CodexExecFileResult> {
    try {
      return await this.execFile(executablePath, args, { shell: false, windowsHide: true });
    } catch (error) {
      throw new CodexRunnerError(
        code,
        `Codex capability probe failed: ${args[0] ?? 'unknown'}`,
        {
          args,
          stderr: redact(String(error instanceof Error ? error.message : error)),
        },
        { cause: error },
      );
    }
  }

  private modelsInclude(stdout: string, requestedModel: string): boolean {
    try {
      const parsed: unknown = JSON.parse(stdout);
      const models =
        isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
      return models.some((item) => {
        if (typeof item === 'string') return item === requestedModel;
        if (isRecord(item))
          return item.id === requestedModel || item.name === requestedModel || item.slug === requestedModel;
        return false;
      });
    } catch {
      return stdout.split(/\r?\n/).some((line) => line.trim() === requestedModel || line.includes(requestedModel));
    }
  }

  private assertParsedTask(task: LunaTaskBlock): void {
    if (task.type !== 'LUNA_TASK' || task.fields.task_id.trim() === '' || task.fields.base_commit.trim() === '') {
      throw new CodexRunnerError(
        'INVALID_TARGET_REPOSITORY',
        'Codex runner requires a parsed LUNA_TASK with a base commit',
      );
    }
  }

  private async checkReport(repositoryPath: string, reportPath: string): Promise<{ exists: boolean; reason: string }> {
    const normalized = normalizePath(reportPath);
    if (!isSafeRelativePath(normalized) || isProtectedPath(normalized))
      return { exists: false, reason: 'Report path is unsafe or protected' };
    const absolute = resolve(repositoryPath, normalized);
    if (normalizePath(relative(repositoryPath, absolute)) !== normalized)
      return { exists: false, reason: 'Report path escapes the repository' };
    try {
      const stats = await stat(absolute);
      await access(absolute);
      return { exists: stats.isFile(), reason: stats.isFile() ? '' : 'Report path is not a file' };
    } catch {
      return { exists: false, reason: 'Required report file is missing' };
    }
  }

  private async checkGitState(repositoryPath: string, task: LunaTaskBlock): Promise<GitStateCheckResult> {
    if (this.gitStateCheck !== undefined) return this.gitStateCheck(repositoryPath, task);
    try {
      const [root, branch, head, status] = await Promise.all([
        this.execFile('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
          shell: false,
          windowsHide: true,
        }),
        this.execFile('git', ['-C', repositoryPath, 'branch', '--show-current'], { shell: false, windowsHide: true }),
        this.execFile('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { shell: false, windowsHide: true }),
        this.execFile('git', ['-C', repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all', '-z'], {
          shell: false,
          windowsHide: true,
        }),
      ]);
      if (resolve(root.stdout.trim()) !== resolve(repositoryPath))
        return { valid: false, reason: 'Git repository root changed' };
      if (branch.stdout.trim() === '') return { valid: false, reason: 'Git branch is detached' };
      if (head.stdout.trim() !== task.fields.base_commit.trim())
        return { valid: false, reason: 'Luna changed HEAD unexpectedly' };
      const paths = status.stdout
        .split('\0')
        .filter((entry) => entry.length > 0)
        .map((entry) => normalizePath(entry.slice(3)))
        .filter((path) => path !== '');
      if (paths.some(isProtectedPath)) return { valid: false, reason: 'Luna modified a protected path' };
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: `Git state check failed: ${redact(String(error))}` };
    }
  }
}

export { findProtocol, normalizePath, parseJsonLines, promptForHandoff, promptForTask, redact };
