import type { LunaTaskBlock } from '../../shared/protocol/writing-block.js';
import type { StateSnapshotStore } from '../state/persistence.js';

export const CODEX_RUN_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'REPORT_MISSING',
  'INVALID_RESULT',
  'BASELINE_CHANGED',
] as const;
export type CodexRunStatus = (typeof CODEX_RUN_STATUSES)[number];

export type CodexRunnerErrorCode =
  | 'CLI_NOT_FOUND'
  | 'CLI_VERSION_UNAVAILABLE'
  | 'CLI_AUTH_UNAVAILABLE'
  | 'CLI_MODEL_UNAVAILABLE'
  | 'INVALID_TARGET_REPOSITORY'
  | 'BASELINE_CHANGED'
  | 'SESSION_ACTIVE'
  | 'SESSION_PERSISTENCE_UNAVAILABLE'
  | 'PROCESS_SPAWN_FAILED'
  | 'PROCESS_OUTPUT_FAILED'
  | 'PROCESS_WAIT_FAILED'
  | 'PROCESS_KILL_FAILED';

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
  git?: CodexRepositorySnapshot;
}

export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface CodexExecutionConfig {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  sandbox: 'danger-full-access' | string;
  approvalPolicy: 'never' | string;
}

export interface CodexCapabilities {
  executablePath: string;
  version: string;
  authenticated: true;
  authStatus: 'AUTHENTICATED';
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
  identifier: 'LUNA_RESULT';
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
  error?: { code: string; message: string };
  stdoutLogPath?: string;
  stderrLogPath?: string;
}

export interface CodexTaskHandle {
  sessionId: string;
  status: 'RUNNING' | 'FAILED';
  result: Promise<CodexRunResult>;
}

export interface CodexTaskInput {
  task: LunaTaskBlock;
  snapshots: CodexSnapshots;
  repositoryPath: string;
  model?: string;
  executablePath?: string;
  timeoutMs?: number;
  repositorySnapshot?: CodexRepositorySnapshot;
  baselineSnapshot?: CodexRepositorySnapshot;
  snapshot?: CodexRepositorySnapshot;
}

export interface CodexRepositorySnapshot {
  repositoryRoot?: string;
  baseCommit?: string;
  base_commit?: string;
  head?: string;
  branch?: string;
  remote?: string;
  remoteUrl?: string;
  remote_url?: string;
  cleanWorktree?: boolean;
  clean_worktree?: boolean;
  worktree?: string[];
}

export interface GitStateCheckResult {
  valid: boolean;
  reason?: string;
  changedPaths?: string[];
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
  status: 'RUNNING' | 'FAILED';
  result: Promise<CodexSessionResult>;
}

export interface CodexSessionResult {
  sessionId: string;
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  events: Record<string, unknown>[];
  diagnostics: string[];
  error?: { code: string; message: string };
  stdoutLogPath?: string;
  stderrLogPath?: string;
}

export interface CodexSessionState {
  chain: CodexSessionRecord[];
  activeSessionId: string | null;
  lastEvent: 'STARTUP' | 'CREATE_STARTED' | 'CREATE_COMPLETED' | 'TERMINAL';
  updatedAt: string;
}

export interface CodexRunnerOptions {
  execFile?: CodexExecFile;
  processRunner?: CodexProcessRunner;
  repositoryValidator?: ((repositoryPath: string) => Promise<boolean>) | undefined;
  gitStateCheck?: ((repositoryPath: string, task: LunaTaskBlock) => Promise<GitStateCheckResult>) | undefined;
  persistSessionChain?: ((chain: CodexSessionRecord[]) => Promise<void>) | undefined;
  sessionStore?: StateSnapshotStore<CodexSessionState> | undefined;
  sessionStorePath?: string | undefined;
  streamLogDirectory?: string | undefined;
  maxStreamLogBytes?: number | undefined;
  captureRepositorySnapshot?: ((repositoryPath: string) => Promise<CodexRepositorySnapshot>) | undefined;
  logger?: (event: string, details: Record<string, unknown>) => void;
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  defaultTimeoutMs?: number;
}
