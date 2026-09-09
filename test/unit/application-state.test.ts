import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApplicationState } from '../../src/main/lifecycle/application-state.js';
import { createInitialState, type TopLevelState } from '../../src/shared/contracts/top-level-state.js';
import type { EventLog, StateSnapshotStore } from '../../src/main/state/persistence.js';
import type { TopLevelStateTransitionEvent } from '../../src/main/state/coordinator.js';

class MemorySnapshotStore implements StateSnapshotStore<TopLevelState> {
  constructor(private state: TopLevelState | null) {}

  async load(): Promise<TopLevelState | null> {
    return this.state;
  }

  async save(state: TopLevelState): Promise<void> {
    this.state = state;
  }
}

class MemoryEventLog implements EventLog<TopLevelStateTransitionEvent> {
  async append(): Promise<void> {}

  async readAll(): Promise<TopLevelStateTransitionEvent[]> {
    return [];
  }
}

describe('application state initialization', () => {
  it('injects startup recovery into the queryable state coordinator', async () => {
    const persistedState: TopLevelState = {
      ...createInitialState(new Date('2026-09-10T01:00:00.000Z')),
      status: 'PAUSED',
      revision: 4,
      activeTaskId: 'task-4',
    };
    const applicationState = await initializeApplicationState(new MemorySnapshotStore(persistedState), {
      eventLog: new MemoryEventLog(),
      transactionLockPath: join(tmpdir(), `web-chat2codex-application-${randomUUID()}`),
    });

    expect(applicationState.recovery.state).toEqual(persistedState);
    expect(applicationState.coordinator.getState()).toEqual(persistedState);
    expect(applicationState.recovery.requiresUserConfirmation).toBe(true);
    expect(applicationState.recovery.canAutoResume).toBe(false);
  });

  it('keeps a safe IDLE recovery state queryable when the snapshot is missing', async () => {
    const snapshotStore = new MemorySnapshotStore(null);
    const applicationState = await initializeApplicationState(
      snapshotStore,
      {
        eventLog: new MemoryEventLog(),
        transactionLockPath: join(tmpdir(), `web-chat2codex-application-${randomUUID()}`),
      },
      { now: new Date('2026-09-10T01:00:00.000Z') },
    );

    expect(applicationState.coordinator.getState()).toMatchObject({
      status: 'IDLE',
      lastError: { code: 'STATE_SNAPSHOT_MISSING' },
    });
    await expect(applicationState.coordinator.transition('ARMED')).resolves.toMatchObject({
      status: 'ARMED',
      revision: 1,
    });
    await expect(snapshotStore.load()).resolves.toMatchObject({ status: 'ARMED', revision: 1 });
  });
});
