import {
  transitionState,
  type StateTransitionMetadata,
  type TopLevelState,
  type TopLevelStatus,
} from '../../shared/contracts/top-level-state.js';
import type { EventLog, StateSnapshotStore } from './persistence.js';

export interface TopLevelStateTransitionEvent {
  type: 'top-level-state-transition';
  from: TopLevelState;
  to: TopLevelState;
}

export interface TopLevelStateCoordinatorDependencies {
  eventLog: EventLog<TopLevelStateTransitionEvent>;
  snapshotStore: StateSnapshotStore<TopLevelState>;
}

export class TopLevelStateCoordinator {
  private state: TopLevelState;

  constructor(initialState: TopLevelState, dependencies: TopLevelStateCoordinatorDependencies) {
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

  async transition(nextStatus: TopLevelStatus, metadata: StateTransitionMetadata = {}): Promise<TopLevelState> {
    const nextState = transitionState(this.state, nextStatus, metadata);
    await this.dependencies.eventLog.append({
      type: 'top-level-state-transition',
      from: this.state,
      to: nextState,
    });
    await this.dependencies.snapshotStore.save(nextState);
    this.state = nextState;
    return this.getState();
  }
}
