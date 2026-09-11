import { isTopLevelStatus, type TopLevelStatus } from './top-level-state.js';
import { sanitizeErrorMessage, sanitizeSafeText, stableErrorCode } from './safe-text.js';

export const DASHBOARD_COMMANDS = [
  'start',
  'pause',
  'retry-current-stage',
  'continue-interrupted',
  'rebind',
  'governance-consistency-check',
  'open-edge',
  'open-project',
  'view-report',
] as const;

export type DashboardCommandName = (typeof DASHBOARD_COMMANDS)[number];
export type DangerousDashboardCommandName = 'start' | 'pause' | 'retry-current-stage' | 'rebind';

export interface DashboardActionState {
  enabled: boolean;
  busy: boolean;
  reason: string | null;
}

export type DashboardActions = Record<DashboardCommandName, DashboardActionState>;

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
  | DangerousDashboardCommand
  | { command: 'continue-interrupted' }
  | { command: 'governance-consistency-check' }
  | { command: 'open-edge' }
  | { command: 'open-project' }
  | ViewReportDashboardCommand;

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

export interface DashboardRecoverySnapshot {
  outputKey: string;
  outputType: string;
  taskId: string | null;
  roundId: string | null;
  startedAt: string;
  updatedAt: string;
  interruptedPhase: string;
  interruptedNodeId: LoopGraphNodeId | null;
  completedNodeIds: LoopGraphNodeId[];
  error: DashboardErrorSnapshot | null;
}

export const LOOP_GRAPH_NODE_DEFINITIONS = [
  { id: 'read-sol', label: '读取 Sol' },
  { id: 'parse-task', label: '解析任务书' },
  { id: 'repair-sol', label: 'Sol 自动修复' },
  { id: 'apply-updates', label: '应用治理/架构更新' },
  { id: 'sync-governance', label: '同步治理' },
  { id: 'run-luna', label: 'Luna 执行' },
  { id: 'sync-code', label: '同步代码' },
  { id: 'notify-sol', label: '通知 Sol' },
  { id: 'wait-sol', label: '等待 Sol' },
] as const;
export const LOOP_GRAPH_MAX_SOURCE_NODES = 64;
export const LOOP_GRAPH_MAX_DETAILS = 16;

export type LoopGraphNodeId = (typeof LOOP_GRAPH_NODE_DEFINITIONS)[number]['id'];
export type LoopGraphNodeState =
  'PENDING' | 'ACTIVE' | 'COMPLETED' | 'RECOVERABLE_BLOCKED' | 'NEEDS_USER_ACTION' | 'PAUSED' | 'NOT_APPLICABLE';

export interface LoopGraphNodeSnapshot {
  id: LoopGraphNodeId;
  label: string;
  state: LoopGraphNodeState;
  summary: string;
  details: string[];
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface LoopGraphSnapshot {
  roundId: string | null;
  currentNodeId: LoopGraphNodeId | null;
  nodes: LoopGraphNodeSnapshot[];
}

interface LoopGraphNodeSnapshotSource {
  id?: unknown;
  label?: unknown;
  state?: unknown;
  summary?: unknown;
  details?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  updatedAt?: unknown;
}

interface LoopGraphSnapshotSource {
  roundId?: unknown;
  currentNodeId?: unknown;
  nodes?: unknown;
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
  recovery: DashboardRecoverySnapshot | null;
  loopGraph: LoopGraphSnapshot;
  actions: DashboardActions;
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
  recovery?: unknown;
  loopGraph?: LoopGraphSnapshotSource | null;
  actions?: Partial<Record<DashboardCommandName, Partial<DashboardActionState>>>;
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
  if (command === 'continue-interrupted') {
    if (Object.keys(value).length !== 1) {
      throw new DashboardCommandValidationError(`${command} does not accept parameters`);
    }
    return { command };
  }
  if (command === 'governance-consistency-check') return { command };
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
    recovery: sanitizeDashboardRecovery(source.recovery),
    loopGraph: sanitizeLoopGraph(source.loopGraph),
    actions: sanitizeDashboardActions(source.actions),
  };
}

function sanitizeDashboardRecovery(value: unknown): DashboardRecoverySnapshot | null {
  if (!isRecord(value)) return null;
  const outputKey = sanitizeSafeText(value.outputKey, 128);
  const outputType = sanitizeSafeText(value.outputType, 64);
  const taskId = sanitizeSafeText(value.taskId, 128) || null;
  const roundId = sanitizeOptionalIdentifier(value.roundId);
  const startedAt = sanitizeTimestamp(value.startedAt);
  const updatedAt = sanitizeTimestamp(value.updatedAt);
  const interruptedPhase = sanitizeSafeText(value.interruptedPhase, 64);
  const interruptedNodeId = isLoopGraphNodeId(value.interruptedNodeId) ? value.interruptedNodeId : null;
  const completedNodeIds = Array.isArray(value.completedNodeIds)
    ? value.completedNodeIds.filter(isLoopGraphNodeId).slice(0, LOOP_GRAPH_NODE_DEFINITIONS.length)
    : [];
  const error = sanitizeDashboardError(value.error);
  if (outputKey === '' || outputType === '' || startedAt === null || updatedAt === null || interruptedPhase === '')
    return null;
  return {
    outputKey,
    outputType,
    taskId,
    roundId,
    startedAt,
    updatedAt,
    interruptedPhase,
    interruptedNodeId,
    completedNodeIds,
    error,
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

function sanitizeDashboardActions(actions: DashboardSnapshotSource['actions']): DashboardActions {
  return Object.fromEntries(
    DASHBOARD_COMMANDS.map((command) => {
      const action = actions?.[command];
      return [
        command,
        {
          enabled: action?.enabled === true,
          busy: action?.busy === true,
          reason: sanitizeSafeText(action?.reason, 240) || null,
        },
      ];
    }),
  ) as DashboardActions;
}

function sanitizeLoopGraph(source: LoopGraphSnapshotSource | null | undefined): LoopGraphSnapshot {
  const sourceNodes = Array.isArray(source?.nodes) ? source.nodes : [];
  const nodesById = new Map<LoopGraphNodeId, LoopGraphNodeSnapshotSource>();
  const nodeLimit = Math.min(sourceNodes.length, LOOP_GRAPH_MAX_SOURCE_NODES);
  for (let index = 0; index < nodeLimit; index += 1) {
    const value = sourceNodes[index];
    if (!isRecord(value) || !isLoopGraphNodeId(value.id) || nodesById.has(value.id)) continue;
    nodesById.set(value.id, value);
  }

  let activeNodeId: LoopGraphNodeId | null = null;
  const nodes = LOOP_GRAPH_NODE_DEFINITIONS.map((definition) => {
    const node = nodesById.get(definition.id);
    const requestedState = isLoopGraphNodeState(node?.state) ? node.state : 'PENDING';
    const state =
      requestedState === 'ACTIVE'
        ? activeNodeId === null
          ? ((activeNodeId = definition.id), 'ACTIVE' as const)
          : 'PENDING'
        : requestedState;
    return {
      id: definition.id,
      label: definition.label,
      state,
      summary: sanitizeSafeText(node?.summary, 240),
      details: sanitizeLoopGraphDetails(node?.details),
      startedAt: sanitizeTimestamp(node?.startedAt),
      completedAt: sanitizeTimestamp(node?.completedAt),
      updatedAt: sanitizeTimestamp(node?.updatedAt) ?? new Date(0).toISOString(),
    };
  });
  const requestedCurrentNodeId = isLoopGraphNodeId(source?.currentNodeId) ? source.currentNodeId : null;
  const requestedCurrentNode =
    requestedCurrentNodeId === null ? undefined : nodes.find((node) => node.id === requestedCurrentNodeId);
  const currentNodeId =
    requestedCurrentNode !== undefined &&
    requestedCurrentNode.state !== 'PENDING' &&
    requestedCurrentNode.state !== 'COMPLETED' &&
    requestedCurrentNode.state !== 'NOT_APPLICABLE'
      ? requestedCurrentNode.id
      : activeNodeId;
  if (
    requestedCurrentNode !== undefined &&
    (requestedCurrentNode.state === 'PAUSED' ||
      requestedCurrentNode.state === 'RECOVERABLE_BLOCKED' ||
      requestedCurrentNode.state === 'NEEDS_USER_ACTION')
  ) {
    for (const node of nodes) {
      if (node.id !== requestedCurrentNode.id && node.state === 'ACTIVE') node.state = 'PENDING';
    }
  }
  return {
    roundId: sanitizeOptionalIdentifier(source?.roundId),
    currentNodeId,
    nodes,
  };
}

function sanitizeLoopGraphDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const details: string[] = [];
  const detailLimit = Math.min(value.length, LOOP_GRAPH_MAX_DETAILS);
  for (let index = 0; index < detailLimit; index += 1) {
    const detail = value[index];
    if (typeof detail !== 'string') continue;
    const sanitized = sanitizeSafeText(detail, 240);
    if (sanitized !== '') details.push(sanitized);
  }
  return details;
}

function sanitizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeSafeText(value, 64);
  const match = ISO_TIMESTAMP_PATTERN.exec(sanitized);
  if (match === null) return null;
  const parsed = new Date(sanitized);
  if (Number.isNaN(parsed.getTime())) return null;
  const milliseconds = Number(match[7] ?? '0');
  return parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6]) &&
    parsed.getUTCMilliseconds() === milliseconds
    ? sanitized
    : null;
}

function sanitizeOptionalIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeIdentifier(value, '');
  return sanitized || null;
}

function isLoopGraphNodeId(value: unknown): value is LoopGraphNodeId {
  return LOOP_GRAPH_NODE_DEFINITIONS.some((definition) => definition.id === value);
}

function isLoopGraphNodeState(value: unknown): value is LoopGraphNodeState {
  return (
    value === 'PENDING' ||
    value === 'ACTIVE' ||
    value === 'COMPLETED' ||
    value === 'RECOVERABLE_BLOCKED' ||
    value === 'NEEDS_USER_ACTION' ||
    value === 'PAUSED' ||
    value === 'NOT_APPLICABLE'
  );
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

const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
