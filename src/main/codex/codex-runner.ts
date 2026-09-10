import { appendFile, access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { LunaTaskBlock } from '../../shared/protocol/writing-block.js';
import { assertSafeProjectPath, realProjectRoot } from '../security/path-safety.js';
import { AtomicJsonFileStore } from '../state/persistence.js';
import { redactRemoteUrl } from '../project/config.js';
import {
  CodexRunnerError,
  type CodexCapabilities,
  type CodexExecFile,
  type CodexExecFileResult,
  type CodexExecutionConfig,
  type CodexOutput,
  type CodexProcess,
  type CodexProcessRunner,
  type CodexRepositorySnapshot,
  type CodexRunnerOptions,
  type CodexRunResult,
  type CodexSessionHandle,
  type CodexSessionRecord,
  type CodexSessionResult,
  type CodexSessionState,
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
const DEFAULT_STREAM_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const PROTECTED_PATHS = ['docs/superpowers', 'docs/superpowers/'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/([?&](?:token|password|secret|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*=\s*[^\s]+/gi, (match) => `${match.split('=')[0]}=[REDACTED]`)
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .trim()
    .slice(0, 3000);
}

function isSecretKey(key: string): boolean {
  return /(?:token|password|secret|api[_-]?key|authorization|credential)/i.test(key);
}

function redactUnknown(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '[REDACTED_DEPTH]';
  if (isSecretKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, '', depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactUnknown(child, childKey, depth + 1)]),
    );
  }
  return value;
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
  if (!Array.isArray(value) || value.length === 0) return null;
  const tests: LunaTestResult[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.status !== 'PASSED' && item.status !== 'FAILED' && item.status !== 'NOT_RUN')) {
      return null;
    }
    if (item.command !== undefined && (typeof item.command !== 'string' || item.command.trim() === '')) return null;
    tests.push({
      ...(item.command === undefined ? {} : { command: item.command }),
      status: item.status,
      ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'command' && key !== 'status')),
    });
  }
  return tests;
}

function protocolFromRecord(value: unknown): LunaProtocolResult | null {
  if (!isRecord(value) || value.identifier !== 'LUNA_RESULT') return null;
  const status = statusValue(value.status);
  const reportPath = stringField(value, 'report_path');
  const summary = stringField(value, 'summary');
  const tests = parseTests(value.tests);
  if (status === null || reportPath === null || summary === null || tests === null) return null;
  if (value.assumptions !== undefined && !Array.isArray(value.assumptions)) return null;
  if (value.changes !== undefined && !Array.isArray(value.changes)) return null;
  if (value.governance_gaps !== undefined && !Array.isArray(value.governance_gaps)) return null;
  return {
    identifier: 'LUNA_RESULT',
    status,
    summary,
    reportPath,
    tests,
    ...(Array.isArray(value.assumptions) ? { assumptions: value.assumptions } : {}),
    ...(Array.isArray(value.changes) ? { changes: value.changes } : {}),
    ...(Array.isArray(value.governance_gaps) ? { governanceGaps: value.governance_gaps } : {}),
  };
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(redactUnknown(parsed) as Record<string, unknown>);
    } catch {
      // Non-JSON diagnostics remain in the bounded stream summary only.
    }
  }
  return events;
}

function findProtocol(
  stdout: string,
  lastMessage: string,
  events: Record<string, unknown>[],
): LunaProtocolResult | null {
  const eventCandidates = events.map(protocolFromRecord).filter((value): value is LunaProtocolResult => value !== null);
  const hasTextMarker = /\bLUNA_RESULT\b/.test(stdout);
  const candidates = [...eventCandidates];
  let lastCandidate: LunaProtocolResult | null = null;
  try {
    const parsed: unknown = JSON.parse(lastMessage);
    const result = protocolFromRecord(parsed);
    if (result !== null) {
      lastCandidate = result;
      candidates.push(result);
    }
  } catch {
    // Free-form marker text is deliberately rejected.
  }
  if (hasTextMarker && eventCandidates.length === 0 && lastCandidate !== null) return null;
  return candidates.length === 1 ? candidates[0]! : null;
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
        implementation:
          'Decide implementation details inside the approved scope without asking for ordinary confirmation.',
        blocking:
          'Emit BLOCKED_EXTERNAL_SETUP for external credentials, conflicts, scope expansion, or high-risk operations.',
        result:
          'Write the required report and emit exactly one JSON object with identifier LUNA_RESULT, status, summary, report_path, and a non-empty tests array.',
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

function validateSessionState(value: unknown): CodexSessionState {
  if (!isRecord(value) || !Array.isArray(value.chain)) throw new Error('Invalid Codex session state');
  if (value.activeSessionId !== null && typeof value.activeSessionId !== 'string')
    throw new Error('Invalid active Codex session id');
  if (!['STARTUP', 'CREATE_STARTED', 'CREATE_COMPLETED', 'TERMINAL'].includes(String(value.lastEvent)))
    throw new Error('Invalid Codex session event');
  if (typeof value.updatedAt !== 'string' || value.updatedAt.trim() === '')
    throw new Error('Invalid session timestamp');
  return {
    chain: value.chain as CodexSessionRecord[],
    activeSessionId: value.activeSessionId,
    lastEvent: value.lastEvent as CodexSessionState['lastEvent'],
    updatedAt: value.updatedAt,
  };
}

function normalizeSnapshot(value: CodexRepositorySnapshot): {
  repositoryRoot: string | null;
  baseCommit: string | null;
  branch: string | null;
  remote: string | null;
  cleanWorktree: boolean | null;
  worktree: string[];
} {
  const record = value as Record<string, unknown>;
  const worktree = Array.isArray(value.worktree) ? value.worktree.map((path) => normalizePath(path)) : [];
  return {
    repositoryRoot: stringField(record, 'repositoryRoot')?.trim() ?? null,
    baseCommit: stringField(record, 'baseCommit', 'base_commit', 'head'),
    branch: stringField(record, 'branch'),
    remote: stringField(record, 'remote', 'remoteUrl', 'remote_url'),
    cleanWorktree:
      typeof value.cleanWorktree === 'boolean'
        ? value.cleanWorktree
        : typeof value.clean_worktree === 'boolean'
          ? value.clean_worktree
          : Array.isArray(value.worktree)
            ? worktree.length === 0
            : null,
    worktree,
  };
}

function snapshotRemote(value: string | null): string | null {
  return value === null ? null : redactRemoteUrl(value);
}

function defaultDataDirectory(): string {
  const base =
    process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? process.env.APPDATA) : process.env.XDG_STATE_HOME;
  return resolve(base === undefined ? join(tmpdir(), 'web-chat2codex') : join(base, 'web-chat2codex'));
}

function snapshotMismatch(
  expected: ReturnType<typeof normalizeSnapshot>,
  actual: ReturnType<typeof normalizeSnapshot>,
): string | null {
  if (expected.repositoryRoot !== null && resolve(expected.repositoryRoot) !== resolve(actual.repositoryRoot ?? ''))
    return 'Repository root differs from the input snapshot';
  if (expected.baseCommit === null || actual.baseCommit !== expected.baseCommit)
    return 'Repository base commit differs from the input snapshot';
  if (expected.branch === null || actual.branch !== expected.branch)
    return 'Repository branch differs from the input snapshot';
  if (expected.remote === null || snapshotRemote(actual.remote) !== snapshotRemote(expected.remote))
    return 'Repository remote differs from the input snapshot';
  if (expected.cleanWorktree !== true || actual.cleanWorktree !== true) return 'Repository worktree is not clean';
  return null;
}

interface OutputCapture {
  value: string;
  error: unknown | null;
  truncated: boolean;
}

async function captureOutput(
  output: CodexOutput,
  logPath: string,
  sessionId: string,
  stream: 'stdout' | 'stderr',
  maxLogBytes: number,
): Promise<OutputCapture> {
  let value = '';
  let capturedBytes = 0;
  let logBytes = 0;
  let truncated = false;
  let error: unknown | null = null;
  const consume = async (chunk: string): Promise<void> => {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (capturedBytes < MAX_CAPTURE_BYTES) {
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      value += chunkBytes <= remaining ? chunk : Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8');
      capturedBytes += Math.min(chunkBytes, remaining);
      if (chunkBytes > remaining) truncated = true;
    } else truncated = true;
    if (logBytes >= maxLogBytes) {
      truncated = true;
      return;
    }
    const record = `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId, stream, chunk: redact(chunk) })}\n`;
    const recordBytes = Buffer.byteLength(record, 'utf8');
    if (logBytes + recordBytes > maxLogBytes) {
      truncated = true;
      return;
    }
    try {
      await appendFile(logPath, record, { encoding: 'utf8' });
      logBytes += recordBytes;
    } catch (appendError) {
      error ??= appendError;
    }
  };
  try {
    if (typeof output === 'string') await consume(output);
    else
      for await (const chunk of output)
        await consume(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  } catch (streamError) {
    error = streamError;
  }
  return { value, error, truncated };
}

export class CodexRunner {
  private readonly execFile: CodexExecFile;
  private readonly processRunner: CodexProcessRunner;
  private readonly repositoryValidator: ((repositoryPath: string) => Promise<boolean>) | undefined;
  private readonly gitStateCheck:
    ((repositoryPath: string, task: LunaTaskBlock) => Promise<GitStateCheckResult>) | undefined;
  private readonly persistSessionChain: ((chain: CodexSessionRecord[]) => Promise<void>) | undefined;
  private readonly sessionStore:
    AtomicJsonFileStore<CodexSessionState> | NonNullable<CodexRunnerOptions['sessionStore']>;
  private readonly captureRepositorySnapshot:
    ((repositoryPath: string) => Promise<CodexRepositorySnapshot>) | undefined;
  private readonly logger: (event: string, details: Record<string, unknown>) => void;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly streamLogDirectory: string;
  private readonly maxStreamLogBytes: number;
  private readonly sessionChain: CodexSessionRecord[] = [];
  private activeSession: { sessionId: string; process: CodexProcess | null } | null = null;
  private sessionStateLoaded = false;
  private sessionStateLoad: Promise<void> | null = null;

  constructor(options: CodexRunnerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.repositoryValidator = options.repositoryValidator;
    this.gitStateCheck = options.gitStateCheck;
    this.persistSessionChain = options.persistSessionChain;
    this.captureRepositorySnapshot = options.captureRepositorySnapshot;
    this.logger = options.logger ?? (() => undefined);
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dataDirectory = defaultDataDirectory();
    this.streamLogDirectory = resolve(options.streamLogDirectory ?? join(dataDirectory, 'streams'));
    this.maxStreamLogBytes = Math.max(1, options.maxStreamLogBytes ?? DEFAULT_STREAM_LOG_BYTES);
    this.sessionStore =
      options.sessionStore ??
      new AtomicJsonFileStore<CodexSessionState>(
        resolve(options.sessionStorePath ?? join(dataDirectory, 'session-chain.json')),
        { validate: validateSessionState },
      );
  }

  getSessionChain(): CodexSessionRecord[] {
    return this.sessionChain.map((record) => ({
      ...record,
      handoff: {
        ...record.handoff,
        completedTasks: [...record.handoff.completedTasks],
        unresolvedIssues: [...record.handoff.unresolvedIssues],
      },
    }));
  }

  async checkCapabilities(input: {
    repositoryPath: string;
    model?: string;
    executablePath?: string;
  }): Promise<CodexCapabilities> {
    const repositoryPath = await this.assertTargetRepository(input.repositoryPath);
    const executablePath = await this.resolveExecutable(input.executablePath);
    const version = await this.probe(executablePath, ['--version'], 'CLI_VERSION_UNAVAILABLE');
    if (version.stdout.trim() === '')
      throw new CodexRunnerError('CLI_VERSION_UNAVAILABLE', 'Codex CLI returned an empty version');
    const authProbe = await this.probe(executablePath, ['login', 'status'], 'CLI_AUTH_UNAVAILABLE');
    if (!this.isAuthenticated(authProbe))
      throw new CodexRunnerError('CLI_AUTH_UNAVAILABLE', 'Codex CLI did not report an authenticated status', {
        stdout: redact(authProbe.stdout),
        stderr: redact(authProbe.stderr),
      });
    const model = input.model?.trim() || this.defaultModel;
    if (!MODEL_ID_PATTERN.test(model))
      throw new CodexRunnerError('CLI_MODEL_UNAVAILABLE', 'Codex model id is invalid', { model });
    const modelProbe = await this.probe(executablePath, ['models', '--json'], 'CLI_MODEL_UNAVAILABLE');
    if (!this.modelsInclude(modelProbe.stdout, model))
      throw new CodexRunnerError('CLI_MODEL_UNAVAILABLE', `Codex model is unavailable: ${model}`, {
        model,
        stdout: redact(modelProbe.stdout),
      });
    const execution: CodexExecutionConfig = { model, sandbox: 'danger-full-access', approvalPolicy: 'never' };
    const capabilities: CodexCapabilities = {
      executablePath,
      version: redact(version.stdout),
      authenticated: true,
      authStatus: 'AUTHENTICATED',
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
    const sessionId = randomUUID();
    let reserved = false;
    let outputDirectory: string | undefined;
    try {
      this.assertParsedTask(input.task);
      await this.beginSession(sessionId);
      reserved = true;
      const expected = await this.verifyTaskBaseline(input);
      const capabilities = await this.checkCapabilities({
        repositoryPath: input.repositoryPath,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
      });
      outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-luna-'));
      await mkdir(this.streamLogDirectory, { recursive: true });
      const lastMessagePath = join(outputDirectory, 'last-message.txt');
      const stdoutLogPath = join(this.streamLogDirectory, `${sessionId}.stdout.jsonl`);
      const stderrLogPath = join(this.streamLogDirectory, `${sessionId}.stderr.jsonl`);
      const args = this.execArgs(capabilities.execution, lastMessagePath, promptForTask(input.task, input.snapshots));
      let process: CodexProcess;
      try {
        process = await this.processRunner(capabilities.executablePath, args, {
          cwd: capabilities.targetRepository,
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        throw new CodexRunnerError('PROCESS_SPAWN_FAILED', 'Codex process could not be started', {}, { cause: error });
      }
      this.activeSession = { sessionId, process };
      try {
        await this.persistSessionState('CREATE_COMPLETED', sessionId);
      } catch (error) {
        try {
          process.kill?.();
        } catch (killError) {
          this.logger('codex-process-kill-failed', { error: redact(String(killError)) });
        }
        throw new CodexRunnerError(
          'SESSION_PERSISTENCE_UNAVAILABLE',
          'Could not persist Codex session startup',
          {},
          { cause: error },
        );
      }
      const result = this.finishTask(process, {
        sessionId,
        task: input.task,
        repositoryPath: capabilities.targetRepository,
        expectedSnapshot: expected,
        lastMessagePath,
        outputDirectory,
        execution: capabilities.execution,
        timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
        stdoutLogPath,
        stderrLogPath,
      });
      return { sessionId, status: 'RUNNING', result };
    } catch (error) {
      if (outputDirectory !== undefined)
        await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (reserved) await this.endSession(sessionId);
      return { sessionId, status: 'FAILED', result: Promise.resolve(this.taskFailureResult(input, sessionId, error)) };
    }
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
    const sessionId = randomUUID();
    let reserved = false;
    let outputDirectory: string | undefined;
    try {
      await this.beginSession(sessionId);
      reserved = true;
      const capabilities = await this.checkCapabilities({
        repositoryPath: input.repositoryPath,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
      });
      outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-handoff-'));
      await mkdir(this.streamLogDirectory, { recursive: true });
      const lastMessagePath = join(outputDirectory, 'last-message.txt');
      const stdoutLogPath = join(this.streamLogDirectory, `${sessionId}.stdout.jsonl`);
      const stderrLogPath = join(this.streamLogDirectory, `${sessionId}.stderr.jsonl`);
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
      await this.persistSessionState('CREATE_STARTED', sessionId);
      let process: CodexProcess;
      try {
        process = await this.processRunner(
          capabilities.executablePath,
          this.execArgs(capabilities.execution, lastMessagePath, promptForHandoff(input.handoff, input.snapshots)),
          { cwd: capabilities.targetRepository, shell: false, windowsHide: true },
        );
      } catch (error) {
        throw new CodexRunnerError(
          'PROCESS_SPAWN_FAILED',
          'Codex handoff process could not be started',
          {},
          { cause: error },
        );
      }
      this.activeSession = { sessionId, process };
      try {
        await this.persistSessionState('CREATE_COMPLETED', sessionId);
      } catch (error) {
        try {
          process.kill?.();
        } catch (killError) {
          this.logger('codex-process-kill-failed', { error: redact(String(killError)) });
        }
        throw new CodexRunnerError(
          'SESSION_PERSISTENCE_UNAVAILABLE',
          'Could not persist Codex handoff startup',
          {},
          { cause: error },
        );
      }
      const result = this.finishSession(
        process,
        sessionId,
        lastMessagePath,
        input.timeoutMs ?? this.defaultTimeoutMs,
        stdoutLogPath,
        stderrLogPath,
      )
        .catch((error) => this.sessionFailureResult(sessionId, error, stdoutLogPath, stderrLogPath))
        .finally(async () => {
          await rm(outputDirectory!, { recursive: true, force: true }).catch(() => undefined);
          await this.endSession(sessionId);
        });
      return { sessionId, status: 'RUNNING', result };
    } catch (error) {
      if (outputDirectory !== undefined)
        await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (reserved) await this.endSession(sessionId);
      return { sessionId, status: 'FAILED', result: Promise.resolve(this.sessionFailureResult(sessionId, error)) };
    }
  }

  private async beginSession(sessionId: string): Promise<void> {
    await this.ensureSessionState();
    if (this.activeSession !== null)
      throw new CodexRunnerError('SESSION_ACTIVE', 'A Codex session is already running', {
        activeSessionId: this.activeSession.sessionId,
      });
    this.activeSession = { sessionId, process: null };
    try {
      await this.persistSessionState('CREATE_STARTED', sessionId);
    } catch (error) {
      this.activeSession = null;
      throw new CodexRunnerError(
        'SESSION_PERSISTENCE_UNAVAILABLE',
        'Could not persist Codex session creation',
        {},
        { cause: error },
      );
    }
  }

  private async endSession(sessionId: string): Promise<void> {
    if (this.activeSession?.sessionId === sessionId) this.activeSession = null;
    try {
      await this.persistSessionState('TERMINAL', null);
    } catch (error) {
      this.logger('codex-session-persistence-failed', { error: redact(String(error)) });
    }
  }

  private async ensureSessionState(): Promise<void> {
    if (this.sessionStateLoaded) return;
    if (this.sessionStateLoad !== null) return this.sessionStateLoad;
    this.sessionStateLoad = (async () => {
      try {
        const stored = await this.sessionStore.load();
        if (stored !== null) this.sessionChain.push(...stored.chain);
        this.activeSession = null;
        await this.persistSessionState('STARTUP', null);
        this.sessionStateLoaded = true;
      } catch (error) {
        throw new CodexRunnerError(
          'SESSION_PERSISTENCE_UNAVAILABLE',
          'Could not load Codex session state',
          {},
          { cause: error },
        );
      } finally {
        this.sessionStateLoad = null;
      }
    })();
    return this.sessionStateLoad;
  }

  private async persistSessionState(
    lastEvent: CodexSessionState['lastEvent'],
    activeSessionId: string | null,
  ): Promise<void> {
    const state: CodexSessionState = {
      chain: this.getSessionChain(),
      activeSessionId,
      lastEvent,
      updatedAt: new Date().toISOString(),
    };
    await this.sessionStore.save(state);
    await this.persistSessionChain?.(this.getSessionChain());
    this.logger('codex-session-state', { lastEvent, activeSessionId: activeSessionId ?? '<none>' });
  }

  private taskFailureResult(input: CodexTaskInput, sessionId: string, error: unknown): CodexRunResult {
    const task = isRecord(input) && isRecord(input.task) ? input.task : null;
    const fields: Record<string, unknown> = task !== null && isRecord(task.fields) ? task.fields : {};
    const code = error instanceof CodexRunnerError ? error.code : 'RUNNER_FAILED';
    return {
      status: code === 'BASELINE_CHANGED' ? 'BASELINE_CHANGED' : 'FAILED',
      sessionId,
      taskId: typeof fields.task_id === 'string' ? fields.task_id : '<unknown>',
      exitCode: null,
      reportPath: typeof fields.report_path === 'string' ? fields.report_path : '',
      stdoutSummary: '',
      stderrSummary: '',
      events: [],
      config: {
        model: typeof input.model === 'string' && input.model.trim() !== '' ? input.model : this.defaultModel,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
      diagnostics: [redact(error instanceof Error ? error.message : String(error))],
      error: { code, message: redact(error instanceof Error ? error.message : String(error)) },
    };
  }

  private sessionFailureResult(
    sessionId: string,
    error: unknown,
    stdoutLogPath?: string,
    stderrLogPath?: string,
  ): CodexSessionResult {
    const code = error instanceof CodexRunnerError ? error.code : 'RUNNER_FAILED';
    return {
      sessionId,
      status: 'FAILED',
      exitCode: null,
      stdoutSummary: '',
      stderrSummary: '',
      events: [],
      diagnostics: [redact(error instanceof Error ? error.message : String(error))],
      ...(stdoutLogPath === undefined ? {} : { stdoutLogPath }),
      ...(stderrLogPath === undefined ? {} : { stderrLogPath }),
      error: { code, message: redact(error instanceof Error ? error.message : String(error)) },
    };
  }

  private async finishTask(
    process: CodexProcess,
    input: {
      sessionId: string;
      task: LunaTaskBlock;
      repositoryPath: string;
      expectedSnapshot: ReturnType<typeof normalizeSnapshot>;
      lastMessagePath: string;
      outputDirectory: string;
      execution: CodexExecutionConfig;
      timeoutMs: number;
      stdoutLogPath: string;
      stderrLogPath: string;
    },
  ): Promise<CodexRunResult> {
    try {
      const sessionResult = await this.finishSession(
        process,
        input.sessionId,
        input.lastMessagePath,
        input.timeoutMs,
        input.stdoutLogPath,
        input.stderrLogPath,
      );
      let lastMessage = '';
      try {
        lastMessage = await readFile(input.lastMessagePath, 'utf8');
      } catch (error) {
        this.logger('codex-last-message-missing', { path: '<temporary>', error: redact(String(error)) });
      }
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
        stdoutLogPath: input.stdoutLogPath,
        stderrLogPath: input.stderrLogPath,
      };
      if (sessionResult.status === 'TIMEOUT')
        return { ...base, status: 'TIMEOUT', diagnostics: [...base.diagnostics, 'Codex process exceeded the timeout'] };
      if (sessionResult.status === 'FAILED' || sessionResult.exitCode !== 0)
        return {
          ...base,
          status: 'FAILED',
          diagnostics: [...base.diagnostics, 'Codex process or output stream failed'],
          ...(sessionResult.error === undefined ? {} : { error: sessionResult.error }),
        };
      if (protocolResult === null)
        return { ...base, diagnostics: [...base.diagnostics, 'LUNA_RESULT is missing, duplicated, or invalid'] };
      if (protocolResult.status !== 'COMPLETED')
        return {
          ...base,
          status: 'FAILED',
          diagnostics: [...base.diagnostics, 'Luna reported a blocked or failed result'],
        };
      if (normalizePath(protocolResult.reportPath) !== normalizePath(input.task.fields.report_path))
        return { ...base, diagnostics: [...base.diagnostics, 'Luna report path does not match the task report path'] };
      if (protocolResult.tests.some((test) => test.status !== 'PASSED'))
        return {
          ...base,
          status: 'FAILED',
          diagnostics: [...base.diagnostics, 'Luna validation results are not all PASSED'],
        };
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
      const changedPaths = gitStatus.changedPaths ?? [];
      if (!changedPaths.includes(normalizePath(input.task.fields.report_path)))
        return {
          ...base,
          status: 'INVALID_RESULT',
          diagnostics: [...base.diagnostics, 'Report is not present in this run worktree diff'],
        };
      const finalSnapshot = normalizeSnapshot(await this.captureSnapshot(input.repositoryPath));
      if (
        finalSnapshot.baseCommit !== input.expectedSnapshot.baseCommit ||
        finalSnapshot.branch !== input.expectedSnapshot.branch ||
        snapshotRemote(finalSnapshot.remote) !== snapshotRemote(input.expectedSnapshot.remote)
      )
        return {
          ...base,
          status: 'BASELINE_CHANGED',
          diagnostics: [...base.diagnostics, 'Repository baseline changed during the run'],
        };
      return { ...base, status: 'COMPLETED' };
    } catch (error) {
      return {
        ...this.taskFailureResult(input as unknown as CodexTaskInput, input.sessionId, error),
        taskId: input.task.fields.task_id,
        reportPath: input.task.fields.report_path,
        config: input.execution,
        stdoutLogPath: input.stdoutLogPath,
        stderrLogPath: input.stderrLogPath,
      };
    } finally {
      await rm(input.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      await this.endSession(input.sessionId);
    }
  }

  private async finishSession(
    process: CodexProcess,
    sessionId: string,
    lastMessagePath: string,
    timeoutMs: number,
    stdoutLogPath: string,
    stderrLogPath: string,
  ): Promise<CodexSessionResult> {
    const stdoutPromise = captureOutput(process.stdout, stdoutLogPath, sessionId, 'stdout', this.maxStreamLogBytes);
    const stderrPromise = captureOutput(process.stderr, stderrLogPath, sessionId, 'stderr', this.maxStreamLogBytes);
    const waitPromise = Promise.resolve()
      .then(() => process.wait())
      .then(
        (exitCode) => ({ exitCode, error: null as unknown | null }),
        (error: unknown) => ({ exitCode: null, error }),
      );
    const execution = Promise.all([waitPromise, stdoutPromise, stderrPromise]);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout(null), timeoutMs);
    });
    const completed = await Promise.race([execution, timeout]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (completed === null) {
      const diagnostics = [`Timed out after ${timeoutMs}ms; last message path: ${lastMessagePath}`];
      try {
        process.kill?.();
      } catch (error) {
        diagnostics.push(`Process kill failed: ${redact(String(error))}`);
      }
      const [stdout, stderr] = await Promise.all([
        Promise.race([stdoutPromise, Promise.resolve(null)]),
        Promise.race([stderrPromise, Promise.resolve(null)]),
      ]);
      return {
        sessionId,
        status: 'TIMEOUT',
        exitCode: null,
        stdoutSummary: redact(stdout?.value ?? ''),
        stderrSummary: redact(stderr?.value ?? ''),
        events: parseJsonLines(stdout?.value ?? ''),
        diagnostics,
        stdoutLogPath,
        stderrLogPath,
      };
    }
    const [waitResult, stdout, stderr] = completed;
    const diagnostics: string[] = [];
    if (stdout.error !== null) diagnostics.push(`stdout stream failed: ${redact(String(stdout.error))}`);
    if (stderr.error !== null) diagnostics.push(`stderr stream failed: ${redact(String(stderr.error))}`);
    if (stdout.truncated || stderr.truncated)
      diagnostics.push('Process output exceeded the configured capture or log limit');
    if (waitResult.error !== null) diagnostics.push(`process wait failed: ${redact(String(waitResult.error))}`);
    const status: CodexSessionResult['status'] =
      waitResult.error !== null || stdout.error !== null || stderr.error !== null ? 'FAILED' : 'COMPLETED';
    return {
      sessionId,
      status,
      exitCode: waitResult.error === null ? waitResult.exitCode : null,
      stdoutSummary: redact(stdout.value),
      stderrSummary: redact(stderr.value),
      events: parseJsonLines(stdout.value),
      diagnostics,
      stdoutLogPath,
      stderrLogPath,
      ...(waitResult.error === null
        ? {}
        : { error: { code: 'PROCESS_WAIT_FAILED', message: redact(String(waitResult.error)) } }),
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
      const rootText = result.stdout.trim();
      if (rootText === '') throw new Error('git returned no root');
      return await realProjectRoot(rootText);
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
        { args, stderr: redact(String(error instanceof Error ? error.message : error)) },
        { cause: error },
      );
    }
  }

  private isAuthenticated(probe: CodexExecFileResult): boolean {
    const text = `${probe.stdout}\n${probe.stderr}`.trim();
    if (text === '') return false;
    try {
      const parsed: unknown = JSON.parse(probe.stdout);
      if (isRecord(parsed)) {
        if (
          parsed.authenticated === true ||
          parsed.loggedIn === true ||
          parsed.status === 'authenticated' ||
          parsed.status === 'logged_in'
        )
          return true;
        if (parsed.authenticated === false || parsed.loggedIn === false) return false;
      }
    } catch {
      // The installed CLI currently emits a human-readable login status.
    }
    if (/not\s+logged|logged\s*out|unauthenticated|no\s+active\s+login/i.test(text)) return false;
    return /logged\s+in|authenticated|active\s+login/i.test(text);
  }

  private modelsInclude(stdout: string, requestedModel: string): boolean {
    try {
      const parsed: unknown = JSON.parse(stdout);
      const models =
        isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed) ? parsed : null;
      if (models === null) return false;
      return models.some((item) =>
        typeof item === 'string' ? item === requestedModel : isRecord(item) && item.id === requestedModel,
      );
    } catch {
      return false;
    }
  }

  private assertParsedTask(task: LunaTaskBlock): void {
    if (task.type !== 'LUNA_TASK' || task.fields.task_id.trim() === '' || task.fields.base_commit.trim() === '')
      throw new CodexRunnerError(
        'INVALID_TARGET_REPOSITORY',
        'Codex runner requires a parsed LUNA_TASK with a base commit',
      );
  }

  private async verifyTaskBaseline(input: CodexTaskInput): Promise<ReturnType<typeof normalizeSnapshot>> {
    const expectedRaw = input.repositorySnapshot ?? input.baselineSnapshot ?? input.snapshot ?? input.snapshots.git;
    if (expectedRaw === undefined)
      throw new CodexRunnerError('BASELINE_CHANGED', 'Codex task is missing its repository baseline snapshot');
    const expected = normalizeSnapshot(expectedRaw);
    const actual = normalizeSnapshot(await this.captureSnapshot(input.repositoryPath));
    if (input.task.fields.base_commit.trim() !== expected.baseCommit)
      throw new CodexRunnerError('BASELINE_CHANGED', 'Task base_commit differs from the input repository snapshot', {
        taskBaseCommit: input.task.fields.base_commit,
        snapshotBaseCommit: expected.baseCommit,
      });
    const mismatch = snapshotMismatch(expected, actual);
    if (mismatch !== null) throw new CodexRunnerError('BASELINE_CHANGED', mismatch);
    this.logger('codex-baseline-verified', { baseCommit: '<redacted>', branch: actual.branch, remote: '<redacted>' });
    return expected;
  }

  private async captureSnapshot(repositoryPath: string): Promise<CodexRepositorySnapshot> {
    if (this.captureRepositorySnapshot !== undefined) return this.captureRepositorySnapshot(repositoryPath);
    const requested = resolve(repositoryPath);
    const rootText = (
      await this.execFile('git', ['-C', requested, 'rev-parse', '--show-toplevel'], { shell: false, windowsHide: true })
    ).stdout.trim();
    if (rootText === '') throw new Error('Git returned no repository root');
    const root = await realProjectRoot(rootText);
    const [head, branch, remote, status] = await Promise.all([
      this.execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { shell: false, windowsHide: true }),
      this.execFile('git', ['-C', root, 'branch', '--show-current'], { shell: false, windowsHide: true }),
      this.execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { shell: false, windowsHide: true }),
      this.execFile('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '-z'], {
        shell: false,
        windowsHide: true,
      }),
    ]);
    const worktree = status.stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizePath(entry.slice(3)))
      .filter((path) => path !== '');
    return {
      repositoryRoot: root,
      baseCommit: head.stdout.trim(),
      branch: branch.stdout.trim(),
      remote: remote.stdout.trim(),
      cleanWorktree: worktree.length === 0,
      worktree,
    };
  }

  private async checkReport(repositoryPath: string, reportPath: string): Promise<{ exists: boolean; reason: string }> {
    const normalized = normalizePath(reportPath);
    if (!isSafeRelativePath(normalized) || isProtectedPath(normalized))
      return { exists: false, reason: 'Report path is unsafe or protected' };
    try {
      const absolute = await assertSafeProjectPath(repositoryPath, normalized);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink() || !stats.isFile())
        return { exists: false, reason: 'Report path is not a regular file' };
      const [rootReal, reportReal] = await Promise.all([realpath(repositoryPath), realpath(absolute)]);
      if (!isPathWithin(rootReal, reportReal))
        return { exists: false, reason: 'Report path resolves outside the repository' };
      await access(absolute);
      return { exists: true, reason: '' };
    } catch {
      return { exists: false, reason: 'Required report file is missing or unsafe' };
    }
  }

  private async checkGitState(repositoryPath: string, task: LunaTaskBlock): Promise<GitStateCheckResult> {
    if (this.gitStateCheck !== undefined) return this.gitStateCheck(repositoryPath, task);
    try {
      const [root, branch, head, remote, status] = await Promise.all([
        this.execFile('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
          shell: false,
          windowsHide: true,
        }),
        this.execFile('git', ['-C', repositoryPath, 'branch', '--show-current'], { shell: false, windowsHide: true }),
        this.execFile('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { shell: false, windowsHide: true }),
        this.execFile('git', ['-C', repositoryPath, 'remote', 'get-url', 'origin'], {
          shell: false,
          windowsHide: true,
        }),
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
      if (remote.stdout.trim() === '') return { valid: false, reason: 'Git remote is missing' };
      const paths = status.stdout
        .split('\0')
        .filter((entry) => entry.length > 0)
        .map((entry) => normalizePath(entry.slice(3)))
        .filter((path) => path !== '');
      if (paths.some(isProtectedPath))
        return { valid: false, reason: 'Luna modified a protected path', changedPaths: paths };
      return { valid: true, changedPaths: paths };
    } catch (error) {
      return { valid: false, reason: `Git state check failed: ${redact(String(error))}` };
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  const separator = process.platform === 'win32' ? '\\' : '/';
  return (
    difference === '' || (difference !== '..' && !difference.startsWith(`..${separator}`) && !isAbsolute(difference))
  );
}

export { findProtocol, normalizePath, parseJsonLines, promptForHandoff, promptForTask, redact, redactUnknown };
