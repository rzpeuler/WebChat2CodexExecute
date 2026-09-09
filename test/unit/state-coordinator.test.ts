import { describe, expect, it } from 'vitest';
import { createInitialState, type TopLevelState } from '../../src/shared/contracts/top-level-state.js';
import { TopLevelStateCoordinator, type TopLevelStateTransitionEvent } from '../../src/main/state/coordinator.js';
import type { EventLog, StateSnapshotStore } from '../../src/main/state/persistence.js';

class RecordingSnapshotStore implements StateSnapshotStore<TopLevelState> {
  saved: TopLevelState | null = null;

  async load(): Promise<TopLevelState | null> {
    return this.saved;
  }

  async save(value: TopLevelState): Promise<void> {
    this.saved = value;
  }
}

class RecordingEventLog implements EventLog<TopLevelStateTransitionEvent> {
  events: TopLevelStateTransitionEvent[] = [];

  async append(event: TopLevelStateTransitionEvent): Promise<void> {
    this.events.push(event);
  }

  async readAll(): Promise<TopLevelStateTransitionEvent[]> {
    return this.events;
  }
}

describe('top-level state coordinator', () => {
  it('runs transition, event append, and snapshot save in that order', async () => {
    const calls: string[] = [];
    const snapshotStore = new RecordingSnapshotStore();
    const eventLog = new RecordingEventLog();
    const orderedEventLog: EventLog<TopLevelStateTransitionEvent> = {
      append: async (event) => {
        calls.push('event');
        await eventLog.append(event);
      },
      readAll: () => eventLog.readAll(),
    };
    const orderedSnapshotStore: StateSnapshotStore<TopLevelState> = {
      load: () => snapshotStore.load(),
      save: async (state) => {
        calls.push('snapshot');
        await snapshotStore.save(state);
      },
    };
    const coordinator = new TopLevelStateCoordinator(createInitialState(), {
      eventLog: orderedEventLog,
      snapshotStore: orderedSnapshotStore,
    });

    const nextState = await coordinator.transition('ARMED', {
      now: new Date('2026-09-10T00:00:00.000Z'),
      activeTaskId: 'task-1',
    });

    expect(calls).toEqual(['event', 'snapshot']);
    expect(eventLog.events).toHaveLength(1);
    expect(eventLog.events[0]).toMatchObject({
      type: 'top-level-state-transition',
      from: { status: 'IDLE', revision: 0 },
      to: nextState,
    });
    expect(snapshotStore.saved).toEqual(nextState);
    expect(coordinator.getState()).toEqual(nextState);
  });
});
