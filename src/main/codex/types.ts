import type { LunaTaskBlock } from '../../shared/protocol/writing-block.js';

export const CODEX_RUN_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'REPORT_MISSING',
  'INVALID_RESULT',
] as const;
export type CodexRunStatus = (typeof CODEX_RUN_STATUSES)[number];

export type CodexRunnerErrorCode =
  | 'CLI_NOT_FOUND'
  | 'CLI_VERSION_UNAVAILABLE'
  | 'CLI_AUTH_UNAVAILABLE'
  | 'CLI_MODEL_UNAVAILABLE'
  | 'INVALID_TARGET_REPOSITORY';

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: CodexRunnerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CodexRunnerError';
    this.code = code;
    this.details = details;
  }
}

export interface CodexExecFileOptions {
  cwd?: string;
  shell: false;
  windowsHide: boolean;
}

export interface CodexExecFileResult {
  stdout: string;
  stderr: string;
}

export type CodexExecFile = (
  file: string,
  args: readonly string[],
  options: CodexExecFileOptions,
) => Promise<CodexExecFileResult>;

export type CodexOutput = string | AsyncIterable<string | Uint8Array>;

export interface CodexProcess {
  stdout: CodexOutput;
  stderr: CodexOutput;
  wait: () => Promise<number>;
  kill?: () => void;
}

export type CodexProcessRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; shell: false; windowsHide: boolean },
) => CodexProcess | Promise<CodexProcess>;

export interface CodexSnapshots {
  governance: unknown;
  architecture: unknown;
}

export interface CodexExecutionConfig {
  model: string;
  sandbox: 'danger-full-access' | string;
  approvalPolicy: 'never' | string;
}

export interface CodexCapabilities {
  executablePath: string;
  version: string;
  authenticated: true;
  model: string;
  modelAvailable: true;
  targetRepository: string;
  execution: CodexExecutionConfig;
}

export interface LunaTestResult {
  command?: string;
  status: 'PASSED' | 'FAILED' | 'NOT_RUN';
  [key: string]: unknown;
}

export interface LunaProtocolResult {
  status: 'COMPLETED' | 'BLOCKED_EXTERNAL_SETUP' | 'FAILED';
  summary: string;
  reportPath: string;
  tests: LunaTestResult[];
  assumptions?: unknown[];
  changes?: unknown[];
  governanceGaps?: unknown[];
}

export interface CodexRunResult {
  status: Exclude<CodexRunStatus, 'RUNNING'>;
  sessionId: string;
  taskId: string;
  exitCode: number | null;
  protocolResult?: LunaProtocolResult;
  reportPath: string;
  stdoutSummary: string;
  stderrSummary: string;
  events: Record<string, unknown>[];
  config: CodexExecutionConfig;
  diagnostics: string[];
}

export interface CodexTaskHandle {
  sessionId: string;
  status: 'RUNNING';
  result: Promise<CodexRunResult>;
}

export interface CodexTaskInput {
  task: LunaTaskBlock;
  snapshots: CodexSnapshots;
  repositoryPath: string;
  model?: string;
  executablePath?: string;
  timeoutMs?: number;
}

export interface GitStateCheckResult {
  valid: boolean;
  reason?: string;
}

export interface SessionHandoff {
  productGoal: string;
  phase: string;
  completedTasks: string[];
  commit: string;
  governanceRevision: string | number;
  architectureRevisionSet: unknown[];
  unresolvedIssues: string[];
  nextStep: string;
}

export interface CodexSessionRecord {
  sessionId: string;
  parentSessionId: string | null;
  handoff: SessionHandoff;
  createdAt: string;
}

export interface CodexSessionHandle {
  sessionId: string;
  status: 'RUNNING';
  result: Promise<CodexSessionResult>;
}

export interface CodexSessionResult {
  sessionId: string;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  events: Record<string, unknown>[];
  diagnostics: string[];
}

export interface CodexRunnerOptions {
  execFile?: CodexExecFile;
  processRunner?: CodexProcessRunner;
  repositoryValidator?: ((repositoryPath: string) => Promise<boolean>) | undefined;
  gitStateCheck?: ((repositoryPath: string, task: LunaTaskBlock) => Promise<GitStateCheckResult>) | undefined;
  persistSessionChain?: ((chain: CodexSessionRecord[]) => Promise<void>) | undefined;
  logger?: (event: string, details: Record<string, unknown>) => void;
  defaultModel?: string;
  defaultTimeoutMs?: number;
}
