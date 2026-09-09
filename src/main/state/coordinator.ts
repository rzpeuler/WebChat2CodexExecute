import {
  assertTopLevelState,
  transitionState,
  type StateTransitionMetadata,
  type TopLevelState,
  type TopLevelStatus,
} from '../../shared/contracts/top-level-state.js';
import { withSharedStateTransactionLock, type EventLog, type StateSnapshotStore } from './persistence.js';

export interface TopLevelStateTransitionEvent {
  type: 'top-level-state-transition';
  from: TopLevelState;
  to: TopLevelState;
}

export interface TopLevelStateCoordinatorDependencies {
  eventLog: EventLog<TopLevelStateTransitionEvent>;
  snapshotStore: StateSnapshotStore<TopLevelState>;
  transactionLockPath: string;
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
      return withSharedStateTransactionLock(this.dependencies.transactionLockPath, async () => {
        const latestSnapshot = await this.dependencies.snapshotStore.load();
        const currentState = latestSnapshot === null ? this.state : latestSnapshot;
        assertTopLevelState(currentState);
        const nextState = transitionState(currentState, nextStatus, metadata);
        await this.dependencies.eventLog.append({
          type: 'top-level-state-transition',
          from: currentState,
          to: nextState,
        });
        await this.dependencies.snapshotStore.save(nextState);
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
