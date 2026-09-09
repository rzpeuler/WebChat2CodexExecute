import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialState, type TopLevelState } from '../../src/shared/contracts/top-level-state.js';
import { TopLevelStateCoordinator, type TopLevelStateTransitionEvent } from '../../src/main/state/coordinator.js';
import {
  AtomicJsonFileStore,
  JsonlFileEventLog,
  type EventLog,
  type StateSnapshotStore,
} from '../../src/main/state/persistence.js';
import { parseTopLevelState } from '../../src/shared/contracts/top-level-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function transactionLockPath(): string {
  return join(tmpdir(), `web-chat2codex-coordinator-${randomUUID()}`);
}

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
      transactionLockPath: transactionLockPath(),
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

  it('serializes concurrent transitions and preserves every revision and event', async () => {
    const snapshotStore = new RecordingSnapshotStore();
    const eventLog = new RecordingEventLog();
    const coordinator = new TopLevelStateCoordinator(createInitialState(), {
      eventLog,
      snapshotStore,
      transactionLockPath: transactionLockPath(),
    });

    const [armedState, runningState] = await Promise.all([
      coordinator.transition('ARMED', {
        now: new Date('2026-09-10T00:01:00.000Z'),
        activeTaskId: 'task-1',
      }),
      coordinator.transition('RUNNING', {
        now: new Date('2026-09-10T00:02:00.000Z'),
      }),
    ]);

    expect(armedState).toMatchObject({ status: 'ARMED', revision: 1, activeTaskId: 'task-1' });
    expect(runningState).toMatchObject({ status: 'RUNNING', revision: 2, activeTaskId: 'task-1' });
    expect(coordinator.getState()).toEqual(runningState);
    expect(snapshotStore.saved).toEqual(runningState);
    expect(eventLog.events).toHaveLength(2);
    expect(eventLog.events.map((event) => [event.from.status, event.to.status, event.to.revision])).toEqual([
      ['IDLE', 'ARMED', 1],
      ['ARMED', 'RUNNING', 2],
    ]);
  });

  it('serializes transitions from two independent coordinators without losing an update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-chat2codex-coordinator-'));
    temporaryDirectories.push(directory);
    const snapshotPath = join(directory, 'state', 'top-level.json');
    const eventPath = join(directory, 'state', 'events.jsonl');
    const sharedTransactionLockPath = join(directory, 'state', 'transaction');
    const initialState = createInitialState(new Date('2026-09-10T00:00:00.000Z'));
    const firstStore = new AtomicJsonFileStore(snapshotPath, { validate: parseTopLevelState });
    const secondStore = new AtomicJsonFileStore(snapshotPath, { validate: parseTopLevelState });
    const firstLog = new JsonlFileEventLog<TopLevelStateTransitionEvent>(eventPath);
    const secondLog = new JsonlFileEventLog<TopLevelStateTransitionEvent>(eventPath);
    const firstCoordinator = new TopLevelStateCoordinator(initialState, {
      eventLog: firstLog,
      snapshotStore: firstStore,
      transactionLockPath: sharedTransactionLockPath,
    });
    const secondCoordinator = new TopLevelStateCoordinator(initialState, {
      eventLog: secondLog,
      snapshotStore: secondStore,
      transactionLockPath: sharedTransactionLockPath,
    });
    await firstStore.save(initialState);

    const [firstResult, secondResult] = await Promise.all([
      firstCoordinator.transition('ARMED', { activeTaskId: 'task-1' }),
      secondCoordinator.transition('NEEDS_USER_ACTION'),
    ]);
    const finalSnapshot = await firstStore.load();
    const events = await firstLog.readAll();

    expect([firstResult.revision, secondResult.revision].sort()).toEqual([1, 2]);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.to.revision)).toEqual([1, 2]);
    expect(events[1]?.from).toEqual(events[0]?.to);
    expect(finalSnapshot).toEqual(events[1]?.to);
    expect(finalSnapshot?.revision).toBe(2);
    expect(['ARMED', 'NEEDS_USER_ACTION']).toContain(finalSnapshot?.status);
  });
});
