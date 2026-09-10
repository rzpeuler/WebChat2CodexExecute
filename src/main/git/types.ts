export type GitErrorCode =
  | 'INVALID_REPOSITORY'
  | 'NO_HEAD'
  | 'REMOTE_MISSING'
  | 'BRANCH_MISMATCH'
  | 'REMOTE_MISMATCH'
  | 'WORKTREE_DIRTY'
  | 'BASELINE_CHANGED'
  | 'UNAUTHORIZED_CHANGE'
  | 'PROTECTED_PATH'
  | 'REPORT_MISSING'
  | 'TESTS_NOT_PASSED'
  | 'NO_CHANGES'
  | 'COMMIT_FAILED'
  | 'PUSH_FAILED'
  | 'COMMAND_FAILED';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitExecFileOptions {
  cwd: string;
  shell: false;
  windowsHide: boolean;
}

export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: GitExecFileOptions,
) => Promise<GitCommandResult>;

export interface GitBaseline {
  repositoryRoot: string;
  remoteName: string;
  remoteUrl: string;
  branch: string;
  head: string;
  worktree: string[];
}

export interface GitControllerErrorDetails {
  args?: string[];
  branch?: string;
  expected?: string | null;
  head?: string;
  localCommit?: string;
  paths?: string[];
  remoteCommit?: string | null;
  remoteName?: string;
  remoteUrl?: string;
  stderr?: string;
  uncertain?: boolean;
  [key: string]: unknown;
}

export class GitControllerError extends Error {
  readonly code: GitErrorCode;
  readonly details: GitControllerErrorDetails;

  constructor(
    code: GitErrorCode,
    message: string,
    details: GitControllerErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GitControllerError';
    this.code = code;
    this.details = details;
  }
}

export interface GitControllerOptions {
  execFile?: GitExecFile;
  logger?: (event: string, details: Record<string, unknown>) => void;
}

export interface CaptureBaselineOptions {
  expectedBranch?: string;
  expectedRemoteUrl?: string | null;
  requireClean?: boolean;
}

export interface VerifyBaselineOptions {
  allowWorktreeChanges?: boolean;
}

export interface GovernanceSyncInput {
  baseline: GitBaseline;
  changeId: string;
  changedPaths: string[];
}

export interface CodeSyncInput {
  baseline: GitBaseline;
  taskId: string;
  reportPath: string;
  testsPassed: boolean;
  allowedPaths: string[];
  protectedPaths?: string[];
}

export interface GitSyncResult {
  kind: 'governance' | 'code';
  commit: string;
  pushed: boolean;
  remoteCommit: string | null;
  pushRetried: boolean;
}
