import { isTopLevelStatus, type TopLevelStatus } from './top-level-state.js';
import { sanitizeErrorMessage, sanitizeSafeText, stableErrorCode } from './safe-text.js';

export const DASHBOARD_COMMANDS = [
  'start',
  'pause',
  'retry-current-stage',
  'rebind',
  'open-edge',
  'open-project',
  'view-report',
] as const;

export type DashboardCommandName = (typeof DASHBOARD_COMMANDS)[number];
export type DangerousDashboardCommandName = 'start' | 'pause' | 'retry-current-stage' | 'rebind';

export interface DashboardCommandBase {
  command: DashboardCommandName;
}

export interface DangerousDashboardCommand extends DashboardCommandBase {
  command: DangerousDashboardCommandName;
  confirm: true;
}

export interface ViewReportDashboardCommand extends DashboardCommandBase {
  command: 'view-report';
  reportPath?: string;
}

export type DashboardCommand =
  DangerousDashboardCommand | { command: 'open-edge' } | { command: 'open-project' } | ViewReportDashboardCommand;

export interface DashboardCommandResult {
  accepted: boolean;
  code: string;
  message: string;
}

export class DashboardCommandValidationError extends Error {
  readonly code = 'DASHBOARD_INVALID_COMMAND';

  constructor(message: string) {
    super(message);
    this.name = 'DashboardCommandValidationError';
  }
}

export interface DashboardProjectSnapshot {
  projectId: string;
  name: string;
  localPath: string | null;
  remoteUrl: string | null;
}

export interface DashboardSolSessionSnapshot {
  sessionId: string;
  conversationId: string | null;
  status: string;
}

export interface DashboardLunaSnapshot {
  status: string;
  sessionId: string | null;
}

export interface DashboardErrorSnapshot {
  code: string;
  message: string;
}

export interface DashboardSnapshot {
  revision: number;
  updatedAt: string;
  project: DashboardProjectSnapshot | null;
  activeSolSession: DashboardSolSessionSnapshot | null;
  stage: string;
  status: TopLevelStatus;
  taskId: string | null;
  governanceRevision: string | number | null;
  architectureRevisions: Array<string | number>;
  luna: DashboardLunaSnapshot;
  commits: {
    local: string | null;
    remote: string | null;
  };
  recentError: DashboardErrorSnapshot | null;
}

export interface DashboardSnapshotSource {
  revision?: number;
  updatedAt?: string;
  project?: Partial<DashboardProjectSnapshot> | null;
  activeSolSession?: Partial<DashboardSolSessionSnapshot> | null;
  stage?: string;
  status?: TopLevelStatus;
  taskId?: string | null;
  governanceRevision?: string | number | null;
  architectureRevisions?: Array<string | number>;
  luna?: Partial<DashboardLunaSnapshot>;
  commits?: Partial<DashboardSnapshot['commits']>;
  recentError?: unknown;
}

const DANGEROUS_COMMANDS = new Set<DangerousDashboardCommandName>(['start', 'pause', 'retry-current-stage', 'rebind']);

export function validateDashboardCommand(value: unknown): DashboardCommand {
  if (!isRecord(value) || typeof value.command !== 'string' || !isDashboardCommandName(value.command)) {
    throw new DashboardCommandValidationError('command must be a supported dashboard command');
  }
  const command = value.command;
  if (DANGEROUS_COMMANDS.has(command as DangerousDashboardCommandName)) {
    if (value.confirm !== true) {
      throw new DashboardCommandValidationError(`${command} requires confirm: true`);
    }
    if (Object.keys(value).some((key) => key !== 'command' && key !== 'confirm')) {
      throw new DashboardCommandValidationError(`${command} does not accept additional parameters`);
    }
    return { command: command as DangerousDashboardCommandName, confirm: true };
  }
  if (command === 'view-report') {
    if (Object.keys(value).some((key) => key !== 'command' && key !== 'reportPath')) {
      throw new DashboardCommandValidationError('view-report received an unsupported parameter');
    }
    if (value.reportPath !== undefined) assertSafeReportPath(value.reportPath);
    return value.reportPath === undefined ? { command } : { command, reportPath: value.reportPath };
  }
  if (Object.keys(value).length !== 1) {
    throw new DashboardCommandValidationError(`${command} does not accept parameters`);
  }
  if (command === 'open-edge') return { command };
  return { command: 'open-project' };
}

export function sanitizeDashboardSnapshot(source: DashboardSnapshotSource): DashboardSnapshot {
  const project =
    source.project === null || source.project === undefined
      ? null
      : {
          projectId: sanitizeIdentifier(source.project.projectId, 'unknown-project'),
          name: sanitizeSafeText(source.project.name, 96) || '未选择项目',
          localPath: sanitizeSafeText(source.project.localPath, 260) || null,
          remoteUrl: sanitizeSafeText(source.project.remoteUrl, 260) || null,
        };
  const activeSolSession =
    source.activeSolSession === null || source.activeSolSession === undefined
      ? null
      : {
          sessionId: sanitizeIdentifier(source.activeSolSession.sessionId, 'unknown-session'),
          conversationId: sanitizeSafeText(source.activeSolSession.conversationId, 128) || null,
          status: sanitizeSafeText(source.activeSolSession.status, 64) || 'UNKNOWN',
        };
  const recentError = sanitizeDashboardError(source.recentError);
  return {
    revision: safeRevision(source.revision),
    updatedAt: sanitizeSafeText(source.updatedAt, 64) || new Date(0).toISOString(),
    project,
    activeSolSession,
    stage: sanitizeSafeText(source.stage, 96) || 'INITIALIZATION',
    status: source.status !== undefined && isTopLevelStatus(source.status) ? source.status : 'IDLE',
    taskId: sanitizeSafeText(source.taskId, 128) || null,
    governanceRevision: sanitizeRevision(source.governanceRevision),
    architectureRevisions: (source.architectureRevisions ?? [])
      .map((revision) => sanitizeRevision(revision))
      .filter((revision): revision is string | number => revision !== null),
    luna: {
      status: sanitizeSafeText(source.luna?.status, 64) || 'NOT_STARTED',
      sessionId: sanitizeSafeText(source.luna?.sessionId, 128) || null,
    },
    commits: {
      local: sanitizeCommit(source.commits?.local),
      remote: sanitizeCommit(source.commits?.remote),
    },
    recentError,
  };
}

export function createEmptyDashboardSnapshot(status: TopLevelStatus = 'IDLE'): DashboardSnapshot {
  return sanitizeDashboardSnapshot({ status });
}

function sanitizeDashboardError(error: unknown): DashboardErrorSnapshot | null {
  if (error === null || error === undefined) return null;
  return {
    code: stableErrorCode(error),
    message: sanitizeErrorMessage(error),
  };
}

function sanitizeIdentifier(value: unknown, fallback: string): string {
  const sanitized = sanitizeSafeText(value, 128).replace(/[^a-zA-Z0-9._:@/-]/g, '_');
  return sanitized || fallback;
}

function sanitizeCommit(value: unknown): string | null {
  const sanitized = sanitizeSafeText(value, 128);
  return /^[a-f0-9]{7,128}$/i.test(sanitized) ? sanitized : null;
}

function sanitizeRevision(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value.trim())) return value.trim();
  return null;
}

function safeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function assertSafeReportPath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 260 ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new DashboardCommandValidationError('reportPath must be a non-empty project-relative path');
  }
}

function isDashboardCommandName(value: string): value is DashboardCommandName {
  return (DASHBOARD_COMMANDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
