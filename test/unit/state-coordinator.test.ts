import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialState, type TopLevelState } from '../../src/shared/contracts/top-level-state.js';
import {
  parsePendingTopLevelStateTransaction,
  PendingTopLevelStateTransactionRecoveryError,
  recoverPendingTopLevelStateTransaction,
  TopLevelStateCoordinator,
  type PendingTopLevelStateTransaction,
  type TopLevelStateTransitionEvent,
} from '../../src/main/state/coordinator.js';
import {
  AtomicJsonFileStore,
  JsonlFileEventLog,
  type EventLog,
  type StateSnapshotStore,
  type TransactionJournal,
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

class MemoryTransactionJournal implements TransactionJournal<PendingTopLevelStateTransaction> {
  pending: PendingTopLevelStateTransaction | null = null;

  async load(): Promise<PendingTopLevelStateTransaction | null> {
    return this.pending;
  }

  async save(value: PendingTopLevelStateTransaction): Promise<void> {
    this.pending = value;
  }

  async clear(): Promise<void> {
    this.pending = null;
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
    const transactionJournalPath = join(directory, 'state', 'top-level-transaction.json');
    const sharedTransactionLockPath = join(directory, 'state', 'transaction');
    const initialState = createInitialState(new Date('2026-09-10T00:00:00.000Z'));
    const firstStore = new AtomicJsonFileStore(snapshotPath, { validate: parseTopLevelState });
    const secondStore = new AtomicJsonFileStore(snapshotPath, { validate: parseTopLevelState });
    const firstLog = new JsonlFileEventLog<TopLevelStateTransitionEvent>(eventPath);
    const secondLog = new JsonlFileEventLog<TopLevelStateTransitionEvent>(eventPath);
    const firstJournal = new AtomicJsonFileStore<PendingTopLevelStateTransaction>(transactionJournalPath, {
      validate: parsePendingTopLevelStateTransaction,
    });
    const secondJournal = new AtomicJsonFileStore<PendingTopLevelStateTransaction>(transactionJournalPath, {
      validate: parsePendingTopLevelStateTransaction,
    });
    const firstCoordinator = new TopLevelStateCoordinator(initialState, {
      eventLog: firstLog,
      snapshotStore: firstStore,
      transactionJournal: firstJournal,
      transactionLockPath: sharedTransactionLockPath,
    });
    const secondCoordinator = new TopLevelStateCoordinator(initialState, {
      eventLog: secondLog,
      snapshotStore: secondStore,
      transactionJournal: secondJournal,
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

  it('journals the event before append and leaves it pending when append fails', async () => {
    const snapshotStore = new RecordingSnapshotStore();
    const journal = new MemoryTransactionJournal();
    const coordinator = new TopLevelStateCoordinator(createInitialState(), {
      eventLog: {
        append: async () => {
          throw new Error('append failed');
        },
        readAll: async () => [],
      },
      snapshotStore,
      transactionJournal: journal,
      transactionLockPath: transactionLockPath(),
    });

    await expect(coordinator.transition('ARMED')).rejects.toThrow('append failed');
    expect(journal.pending).toMatchObject({ version: 1, status: 'pending', event: { to: { revision: 1 } } });
    expect(snapshotStore.saved).toBeNull();
  });

  it('recovers an appended event when snapshot save fails and then resumes safely', async () => {
    const initialState = createInitialState();
    const snapshotStore = new RecordingSnapshotStore();
    snapshotStore.saved = initialState;
    const originalSave = snapshotStore.save.bind(snapshotStore);
    let failSave = true;
    snapshotStore.save = async (state) => {
      if (failSave) {
        failSave = false;
        throw new Error('snapshot save failed');
      }
      await originalSave(state);
    };
    const eventLog = new RecordingEventLog();
    const journal = new MemoryTransactionJournal();
    const dependencies = {
      eventLog,
      snapshotStore,
      transactionJournal: journal,
      transactionLockPath: transactionLockPath(),
    };
    const coordinator = new TopLevelStateCoordinator(initialState, dependencies);

    await expect(coordinator.transition('ARMED')).rejects.toThrow('snapshot save failed');
    expect(journal.pending).not.toBeNull();
    expect(eventLog.events).toHaveLength(1);

    await expect(coordinator.transition('RUNNING')).resolves.toMatchObject({ status: 'RUNNING', revision: 2 });
    expect(journal.pending).toBeNull();
    expect(snapshotStore.saved).toMatchObject({ status: 'RUNNING', revision: 2 });
    expect(eventLog.events.map((event) => event.to.revision)).toEqual([1, 2]);
  });

  it('clears a pending journal when its event was never appended', async () => {
    const initialState = createInitialState();
    const event: TopLevelStateTransitionEvent = {
      type: 'top-level-state-transition',
      transactionId: 'missing-event-transaction',
      from: initialState,
      to: { ...initialState, status: 'ARMED', revision: 1 },
    };
    const journal = new MemoryTransactionJournal();
    await journal.save({ version: 1, status: 'pending', transactionId: event.transactionId, event });
    const result = await recoverPendingTopLevelStateTransaction({
      eventLog: new RecordingEventLog(),
      snapshotStore: new RecordingSnapshotStore(),
      transactionJournal: journal,
      transactionLockPath: transactionLockPath(),
    });

    expect(result).toEqual({ status: 'cleared' });
    expect(journal.pending).toBeNull();
  });

  it('pauses on an ambiguous pending transaction instead of continuing', async () => {
    const initialState = createInitialState();
    const event: TopLevelStateTransitionEvent = {
      type: 'top-level-state-transition',
      transactionId: 'ambiguous-transaction',
      from: initialState,
      to: { ...initialState, status: 'ARMED', revision: 1 },
    };
    const journal = new MemoryTransactionJournal();
    await journal.save({ version: 1, status: 'pending', transactionId: event.transactionId, event });
    const snapshotStore = new RecordingSnapshotStore();
    snapshotStore.saved = { ...initialState, status: 'NEEDS_USER_ACTION', revision: 1 };
    const eventLog = new RecordingEventLog();
    eventLog.events.push(event);

    await expect(
      recoverPendingTopLevelStateTransaction({
        eventLog,
        snapshotStore,
        transactionJournal: journal,
        transactionLockPath: transactionLockPath(),
      }),
    ).rejects.toBeInstanceOf(PendingTopLevelStateTransactionRecoveryError);
    expect(journal.pending).not.toBeNull();
  });

  it('does not skip the pending transition when the snapshot has the wrong state fields', async () => {
    const initialState = createInitialState(new Date('2026-09-10T00:00:00.000Z'));
    const event: TopLevelStateTransitionEvent = {
      type: 'top-level-state-transition',
      transactionId: 'mismatched-from-transaction',
      from: initialState,
      to: { ...initialState, status: 'ARMED', revision: 1 },
    };
    const journal = new MemoryTransactionJournal();
    await journal.save({ version: 1, status: 'pending', transactionId: event.transactionId, event });
    const snapshotStore = new RecordingSnapshotStore();
    snapshotStore.saved = { ...initialState, updatedAt: '2026-09-10T00:00:01.000Z' };
    const eventLog = new RecordingEventLog();
    eventLog.events.push(event);

    await expect(
      recoverPendingTopLevelStateTransaction({
        eventLog,
        snapshotStore,
        transactionJournal: journal,
        transactionLockPath: transactionLockPath(),
      }),
    ).rejects.toMatchObject({
      name: 'PendingTopLevelStateTransactionRecoveryError',
      diagnostic: { code: 'PENDING_TOP_LEVEL_STATE_TRANSACTION_UNSAFE' },
    });
    expect(snapshotStore.saved).toEqual({ ...initialState, updatedAt: '2026-09-10T00:00:01.000Z' });
    expect(journal.pending).not.toBeNull();
  });

  it('refuses to recover a pending event when the current snapshot is missing', async () => {
    const initialState = createInitialState();
    const event: TopLevelStateTransitionEvent = {
      type: 'top-level-state-transition',
      transactionId: 'missing-snapshot-transaction',
      from: initialState,
      to: { ...initialState, status: 'ARMED', revision: 1 },
    };
    const journal = new MemoryTransactionJournal();
    await journal.save({ version: 1, status: 'pending', transactionId: event.transactionId, event });
    const snapshotStore = new RecordingSnapshotStore();
    const eventLog = new RecordingEventLog();
    eventLog.events.push(event);

    await expect(
      recoverPendingTopLevelStateTransaction({
        eventLog,
        snapshotStore,
        transactionJournal: journal,
        transactionLockPath: transactionLockPath(),
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: 'PENDING_TOP_LEVEL_STATE_TRANSACTION_UNSAFE' },
    });
    expect(snapshotStore.saved).toBeNull();
    expect(journal.pending).not.toBeNull();
  });
});
