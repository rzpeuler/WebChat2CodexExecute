export const TOP_LEVEL_STATUSES = [
  'IDLE',
  'ARMED',
  'RUNNING',
  'PAUSED',
  'NEEDS_USER_ACTION',
  'FAILED',
] as const;

export type TopLevelStatus = (typeof TOP_LEVEL_STATUSES)[number];

export interface StateError {
  code: string;
  message: string;
}

export interface TopLevelState {
  status: TopLevelStatus;
  revision: number;
  updatedAt: string;
  activeTaskId: string | null;
  lastError: StateError | null;
}

export interface StateTransitionMetadata {
  now?: Date;
  activeTaskId?: string | null;
  lastError?: StateError | null;
}

export class InvalidStateTransitionError extends Error {
  readonly from: TopLevelStatus;
  readonly to: TopLevelStatus;

  constructor(from: TopLevelStatus, to: TopLevelStatus) {
    super(`Invalid top-level state transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<TopLevelStatus, readonly TopLevelStatus[]>> = {
  IDLE: ['ARMED', 'NEEDS_USER_ACTION', 'FAILED'],
  ARMED: ['IDLE', 'RUNNING', 'PAUSED', 'NEEDS_USER_ACTION', 'FAILED'],
  RUNNING: ['IDLE', 'PAUSED', 'NEEDS_USER_ACTION', 'FAILED'],
  PAUSED: ['IDLE', 'ARMED', 'RUNNING', 'NEEDS_USER_ACTION', 'FAILED'],
  NEEDS_USER_ACTION: ['IDLE', 'ARMED', 'FAILED'],
  FAILED: ['IDLE', 'ARMED'],
};

export function createInitialState(now: Date = new Date()): TopLevelState {
  return {
    status: 'IDLE',
    revision: 0,
    updatedAt: now.toISOString(),
    activeTaskId: null,
    lastError: null,
  };
}

export function isTopLevelStatus(value: string): value is TopLevelStatus {
  return (TOP_LEVEL_STATUSES as readonly string[]).includes(value);
}

export function assertTopLevelState(state: TopLevelState): void {
  if (!isTopLevelStatus(state.status)) {
    throw new TypeError(`Unknown top-level status: ${String(state.status)}`);
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new TypeError('State revision must be a non-negative safe integer');
  }
  if (Number.isNaN(Date.parse(state.updatedAt))) {
    throw new TypeError('State updatedAt must be an ISO-compatible date');
  }
  if (state.activeTaskId !== null && typeof state.activeTaskId !== 'string') {
    throw new TypeError('State activeTaskId must be a string or null');
  }
  if (state.lastError !== null && (
    typeof state.lastError !== 'object'
    || typeof state.lastError.code !== 'string'
    || typeof state.lastError.message !== 'string'
  )) {
    throw new TypeError('State lastError must be an error object or null');
  }
}

export function transitionState(
  state: TopLevelState,
  nextStatus: TopLevelStatus,
  metadata: StateTransitionMetadata = {},
): TopLevelState {
  assertTopLevelState(state);
  if (!ALLOWED_TRANSITIONS[state.status].includes(nextStatus)) {
    throw new InvalidStateTransitionError(state.status, nextStatus);
  }

  const now = metadata.now ?? new Date();
  return {
    ...state,
    status: nextStatus,
    revision: state.revision + 1,
    updatedAt: now.toISOString(),
    activeTaskId: metadata.activeTaskId === undefined ? state.activeTaskId : metadata.activeTaskId,
    lastError: metadata.lastError === undefined ? state.lastError : metadata.lastError,
  };
}
