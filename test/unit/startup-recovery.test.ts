import { describe, expect, it } from 'vitest';
import { createInitialState, type TopLevelState } from '../../src/shared/contracts/top-level-state.js';
import { recoverTopLevelState } from '../../src/main/state/startup-recovery.js';

function loader(value: unknown | null): {
  load: () => Promise<unknown | null>;
  save: (next: TopLevelState) => Promise<void>;
} {
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

describe('startup state recovery', () => {
  const now = new Date('2026-09-09T02:00:00.000Z');

  it('starts safely in IDLE and records a diagnostic when no snapshot exists', async () => {
    const diagnostics: string[] = [];
    const snapshotStore = loader(null);
    const result = await recoverTopLevelState(snapshotStore, {
      now,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(result).toMatchObject({
      restored: false,
      requiresUserConfirmation: false,
      canAutoResume: false,
      diagnostic: {
        code: 'STATE_SNAPSHOT_MISSING',
      },
      state: {
        status: 'IDLE',
        revision: 0,
        updatedAt: now.toISOString(),
        lastError: {
          code: 'STATE_SNAPSHOT_MISSING',
        },
      },
    });
    expect(diagnostics).toEqual(['STATE_SNAPSHOT_MISSING']);
    await expect(snapshotStore.load()).resolves.toEqual(result.state);
  });

  it('falls back to IDLE and records a diagnostic for an invalid snapshot', async () => {
    const snapshotStore = loader({ status: 'BROKEN' });
    const result = await recoverTopLevelState(snapshotStore, { now });

    expect(result.state).toMatchObject({
      status: 'IDLE',
      revision: 0,
      updatedAt: now.toISOString(),
      lastError: { code: 'STATE_SNAPSHOT_INVALID' },
    });
    expect(result.restored).toBe(false);
    expect(result.diagnostic?.code).toBe('STATE_SNAPSHOT_INVALID');
    await expect(snapshotStore.load()).resolves.toEqual(result.state);
  });

  it('restores state but never permits automatic resume of an unconfirmed task', async () => {
    const persistedState: TopLevelState = {
      ...createInitialState(now),
      status: 'RUNNING',
      revision: 3,
      activeTaskId: 'task-1',
    };

    const result = await recoverTopLevelState(loader(persistedState));

    expect(result.state).toEqual(persistedState);
    expect(result.restored).toBe(true);
    expect(result.requiresUserConfirmation).toBe(true);
    expect(result.canAutoResume).toBe(false);
    expect(result.diagnostic).toBeNull();
  });

  it('requires confirmation when an active task is present even if the status is IDLE', async () => {
    const persistedState: TopLevelState = {
      ...createInitialState(now),
      activeTaskId: 'task-1',
    };

    const result = await recoverTopLevelState(loader(persistedState));

    expect(result.requiresUserConfirmation).toBe(true);
    expect(result.canAutoResume).toBe(false);
  });
});
