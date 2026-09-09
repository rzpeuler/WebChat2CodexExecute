import type { TopLevelState } from '../../shared/contracts/top-level-state.js';
import { TopLevelStateCoordinator, type TopLevelStateCoordinatorDependencies } from '../state/coordinator.js';
import {
  recoverTopLevelState,
  type SnapshotLoader,
  type StartupRecoveryOptions,
  type StartupRecoveryResult,
} from '../state/startup-recovery.js';
import type { StateSnapshotStore } from '../state/persistence.js';

export interface ApplicationState {
  readonly recovery: StartupRecoveryResult;
  readonly coordinator: TopLevelStateCoordinator;
}

export async function initializeApplicationState(
  snapshotStore: StateSnapshotStore<TopLevelState> & SnapshotLoader,
  dependencies: Omit<TopLevelStateCoordinatorDependencies, 'snapshotStore'>,
  options: StartupRecoveryOptions = {},
): Promise<ApplicationState> {
  const recovery = await recoverTopLevelState(snapshotStore, options);
  const coordinator = new TopLevelStateCoordinator(recovery.state, {
    ...dependencies,
    snapshotStore,
  });
  return { recovery, coordinator };
}
