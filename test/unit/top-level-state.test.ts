import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  InvalidStateTransitionError,
  transitionState,
  type TopLevelStatus,
} from '../../src/shared/contracts/top-level-state.js';

describe('top-level state model', () => {
  it.each([
    ['IDLE', 'ARMED'],
    ['ARMED', 'RUNNING'],
    ['RUNNING', 'PAUSED'],
    ['PAUSED', 'RUNNING'],
    ['RUNNING', 'NEEDS_USER_ACTION'],
    ['NEEDS_USER_ACTION', 'ARMED'],
    ['RUNNING', 'FAILED'],
    ['FAILED', 'IDLE'],
  ] as const)('allows %s -> %s', (from, to) => {
    const state = { ...createInitialState(), status: from as TopLevelStatus };
    expect(() => transitionState(state, to)).not.toThrow();
  });

  it('rejects an illegal transition without mutating the current state', () => {
    const state = createInitialState(new Date('2026-09-09T00:00:00.000Z'));

    expect(() => transitionState(state, 'RUNNING')).toThrow(InvalidStateTransitionError);
    expect(state).toEqual({
      status: 'IDLE',
      revision: 0,
      updatedAt: '2026-09-09T00:00:00.000Z',
      activeTaskId: null,
      lastError: null,
    });
  });

  it('increments revision and carries explicit transition metadata', () => {
    const state = transitionState(createInitialState(), 'ARMED', {
      now: new Date('2026-09-09T01:00:00.000Z'),
      activeTaskId: 'task-1',
    });
    const next = transitionState(state, 'RUNNING', {
      now: new Date('2026-09-09T01:01:00.000Z'),
    });

    expect(next).toMatchObject({
      status: 'RUNNING',
      revision: 2,
      updatedAt: '2026-09-09T01:01:00.000Z',
      activeTaskId: 'task-1',
    });
  });
});
