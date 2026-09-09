import { createInitialState, parseTopLevelState, type TopLevelState } from '../../shared/contracts/top-level-state.js';
import { SnapshotFormatError, type StateSnapshotStore } from './persistence.js';

export interface StartupDiagnostic {
  code: 'STATE_SNAPSHOT_MISSING' | 'STATE_SNAPSHOT_INVALID' | 'STATE_SNAPSHOT_LOAD_FAILED';
  message: string;
}

export interface StartupRecoveryResult {
  state: TopLevelState;
  restored: boolean;
  requiresUserConfirmation: boolean;
  canAutoResume: false;
  diagnostic: StartupDiagnostic | null;
}

export interface StartupRecoveryOptions {
  now?: Date;
  onDiagnostic?: (diagnostic: StartupDiagnostic, cause?: unknown) => void;
}

type SnapshotLoader = Pick<StateSnapshotStore<unknown>, 'load'>;

function stateWithDiagnostic(now: Date, diagnostic: StartupDiagnostic): TopLevelState {
  return {
    ...createInitialState(now),
    lastError: diagnostic,
  };
}

function emitDiagnostic(diagnostic: StartupDiagnostic, cause: unknown, options: StartupRecoveryOptions): void {
  options.onDiagnostic?.(diagnostic, cause);
}

function failedRecovery(
  code: StartupDiagnostic['code'],
  message: string,
  cause: unknown,
  options: StartupRecoveryOptions,
): StartupRecoveryResult {
  const diagnostic = { code, message } satisfies StartupDiagnostic;
  emitDiagnostic(diagnostic, cause, options);
  return {
    state: stateWithDiagnostic(options.now ?? new Date(), diagnostic),
    restored: false,
    requiresUserConfirmation: false,
    canAutoResume: false,
    diagnostic,
  };
}

export async function recoverTopLevelState(
  store: SnapshotLoader,
  options: StartupRecoveryOptions = {},
): Promise<StartupRecoveryResult> {
  let snapshot: unknown | null;
  try {
    snapshot = await store.load();
  } catch (error) {
    const code =
      error instanceof SnapshotFormatError || error instanceof TypeError || error instanceof SyntaxError
        ? 'STATE_SNAPSHOT_INVALID'
        : 'STATE_SNAPSHOT_LOAD_FAILED';
    return failedRecovery(
      code,
      code === 'STATE_SNAPSHOT_INVALID'
        ? 'The persisted top-level state snapshot is invalid.'
        : 'The persisted top-level state snapshot could not be loaded.',
      error,
      options,
    );
  }

  if (snapshot === null) {
    return failedRecovery(
      'STATE_SNAPSHOT_MISSING',
      'No persisted top-level state snapshot was found; starting safely in IDLE.',
      undefined,
      options,
    );
  }

  try {
    const state = parseTopLevelState(snapshot);
    return {
      state,
      restored: true,
      requiresUserConfirmation: state.status !== 'IDLE' || state.activeTaskId !== null,
      canAutoResume: false,
      diagnostic: null,
    };
  } catch (error) {
    return failedRecovery(
      'STATE_SNAPSHOT_INVALID',
      'The persisted top-level state snapshot is invalid; starting safely in IDLE.',
      error,
      options,
    );
  }
}
