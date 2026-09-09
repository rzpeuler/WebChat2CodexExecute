import {
  assertTopLevelState,
  transitionState,
  type StateTransitionMetadata,
  type TopLevelState,
  type TopLevelStatus,
} from '../../shared/contracts/top-level-state.js';
import { randomUUID } from 'node:crypto';
import {
  withSharedStateTransactionLock,
  type EventLog,
  type StateSnapshotStore,
  type TransactionJournal,
} from './persistence.js';
import { isDeepStrictEqual } from 'node:util';

export interface TopLevelStateTransitionEvent {
  type: 'top-level-state-transition';
  transactionId: string;
  from: TopLevelState;
  to: TopLevelState;
}

export interface PendingTopLevelStateTransaction {
  version: 1;
  status: 'pending';
  transactionId: string;
  event: TopLevelStateTransitionEvent;
}

export interface PendingTopLevelStateTransactionDiagnostic {
  code: 'PENDING_TOP_LEVEL_STATE_TRANSACTION_UNSAFE';
  message: string;
}

export class PendingTopLevelStateTransactionRecoveryError extends Error {
  readonly diagnostic: PendingTopLevelStateTransactionDiagnostic;

  constructor(diagnostic: PendingTopLevelStateTransactionDiagnostic, cause?: unknown) {
    super(diagnostic.message, { cause });
    this.name = 'PendingTopLevelStateTransactionRecoveryError';
    this.diagnostic = diagnostic;
  }
}

export interface TopLevelStateCoordinatorDependencies {
  eventLog: EventLog<TopLevelStateTransitionEvent>;
  snapshotStore: StateSnapshotStore<TopLevelState>;
  transactionLockPath: string;
  transactionJournal?: TransactionJournal<PendingTopLevelStateTransaction>;
}

export interface PendingTopLevelStateTransactionRecoveryResult {
  status: 'none' | 'recovered' | 'cleared';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTransitionEvent(value: unknown): TopLevelStateTransitionEvent {
  if (!isRecord(value) || value.type !== 'top-level-state-transition' || typeof value.transactionId !== 'string') {
    throw new TypeError('Pending top-level state event is invalid');
  }
  assertTopLevelState(value.from);
  assertTopLevelState(value.to);
  if (value.transactionId.length === 0 || value.to.revision !== value.from.revision + 1) {
    throw new TypeError('Pending top-level state event revision or transaction id is invalid');
  }
  const expected = transitionState(value.from, value.to.status, {
    now: new Date(value.to.updatedAt),
    activeTaskId: value.to.activeTaskId,
    lastError: value.to.lastError,
  });
  if (!isDeepStrictEqual(expected, value.to)) {
    throw new TypeError('Pending top-level state event does not describe its state transition');
  }
  return value as unknown as TopLevelStateTransitionEvent;
}

export function parsePendingTopLevelStateTransaction(value: unknown): PendingTopLevelStateTransaction {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.status !== 'pending' ||
    typeof value.transactionId !== 'string'
  ) {
    throw new TypeError('Pending top-level state transaction journal entry is invalid');
  }
  const event = parseTransitionEvent(value.event);
  if (value.transactionId.length === 0 || event.transactionId !== value.transactionId) {
    throw new TypeError('Pending top-level state transaction ids do not match');
  }
  return value as unknown as PendingTopLevelStateTransaction;
}

function unsafeRecovery(message: string, cause?: unknown): never {
  throw new PendingTopLevelStateTransactionRecoveryError(
    { code: 'PENDING_TOP_LEVEL_STATE_TRANSACTION_UNSAFE', message },
    cause,
  );
}

export async function recoverPendingTopLevelStateTransaction(
  dependencies: TopLevelStateCoordinatorDependencies,
): Promise<PendingTopLevelStateTransactionRecoveryResult> {
  const journal = dependencies.transactionJournal;
  if (journal === undefined) {
    return { status: 'none' };
  }

  return withSharedStateTransactionLock(dependencies.transactionLockPath, async () => {
    let journalValue: unknown | null;
    try {
      journalValue = await journal.load();
    } catch (error) {
      return unsafeRecovery('The pending top-level state transaction journal could not be loaded.', error);
    }
    if (journalValue === null) {
      return { status: 'none' };
    }

    let pending: PendingTopLevelStateTransaction;
    try {
      pending = parsePendingTopLevelStateTransaction(journalValue);
    } catch (error) {
      return unsafeRecovery('The pending top-level state transaction journal is invalid.', error);
    }

    let snapshot: TopLevelState | null;
    try {
      snapshot = await dependencies.snapshotStore.load();
      if (snapshot !== null) {
        assertTopLevelState(snapshot);
      }
    } catch (error) {
      return unsafeRecovery('The current top-level state snapshot could not be safely inspected.', error);
    }

    let events: TopLevelStateTransitionEvent[];
    try {
      events = await dependencies.eventLog.readAll();
    } catch (error) {
      return unsafeRecovery('The top-level state event log could not be safely inspected.', error);
    }

    const matchingEvents = events.filter((event) => isRecord(event) && event.transactionId === pending.transactionId);
    if (matchingEvents.length === 0) {
      await journal.clear();
      return { status: 'cleared' };
    }
    if (matchingEvents.length !== 1) {
      return unsafeRecovery('The pending transaction has multiple matching events in the event log.');
    }

    let event: TopLevelStateTransitionEvent;
    try {
      event = parseTransitionEvent(matchingEvents[0]);
    } catch (error) {
      return unsafeRecovery('The matching top-level state event is invalid.', error);
    }
    if (!isDeepStrictEqual(event, pending.event)) {
      return unsafeRecovery('The journal event and event-log event do not match.');
    }

    if (snapshot === null) {
      return unsafeRecovery('The pending transaction cannot be reconciled because the current snapshot is missing.');
    }
    if (isDeepStrictEqual(snapshot, event.to)) {
      await journal.clear();
      return { status: 'cleared' };
    }
    if (!isDeepStrictEqual(snapshot, event.from)) {
      return unsafeRecovery(
        'The pending transaction cannot be reconciled because the current snapshot does not match the event.from state.',
      );
    }

    await dependencies.snapshotStore.save(event.to);
    await journal.clear();
    return { status: 'recovered' };
  });
}

export class TopLevelStateCoordinator {
  private state: TopLevelState;
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(initialState: TopLevelState, dependencies: TopLevelStateCoordinatorDependencies) {
    assertTopLevelState(initialState);
    this.state = initialState;
    this.dependencies = dependencies;
  }

  private readonly dependencies: TopLevelStateCoordinatorDependencies;

  getState(): TopLevelState {
    return {
      ...this.state,
      lastError: this.state.lastError === null ? null : { ...this.state.lastError },
    };
  }

  transition(nextStatus: TopLevelStatus, metadata: StateTransitionMetadata = {}): Promise<TopLevelState> {
    const operation = this.transitionQueue.then(async () => {
      await recoverPendingTopLevelStateTransaction(this.dependencies);
      return withSharedStateTransactionLock(this.dependencies.transactionLockPath, async () => {
        const latestSnapshot = await this.dependencies.snapshotStore.load();
        const currentState = latestSnapshot === null ? this.state : latestSnapshot;
        assertTopLevelState(currentState);
        const nextState = transitionState(currentState, nextStatus, metadata);
        const event: TopLevelStateTransitionEvent = {
          type: 'top-level-state-transition',
          transactionId: randomUUID(),
          from: currentState,
          to: nextState,
        };
        if (this.dependencies.transactionJournal !== undefined) {
          await this.dependencies.transactionJournal.save({
            version: 1,
            status: 'pending',
            transactionId: event.transactionId,
            event,
          });
        }
        await this.dependencies.eventLog.append(event);
        await this.dependencies.snapshotStore.save(nextState);
        if (this.dependencies.transactionJournal !== undefined) {
          await this.dependencies.transactionJournal.clear();
        }
        this.state = nextState;
        return this.getState();
      });
    });
    this.transitionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
