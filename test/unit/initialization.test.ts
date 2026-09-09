import { describe, expect, it, vi } from 'vitest';
import { createInitializationGate } from '../../src/main/lifecycle/initialization.js';

describe('application initialization gate', () => {
  it('shares one in-flight initialization promise across concurrent callers', async () => {
    let release: (() => void) | undefined;
    const initialize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onFailure = vi.fn();
    const gate = createInitializationGate(initialize, onFailure);

    const first = gate.initialize();
    const second = gate.initialize();

    expect(first).toBe(second);
    await Promise.resolve();
    expect(initialize).toHaveBeenCalledTimes(1);
    release?.();
    await expect(first).resolves.toBeUndefined();
  });

  it('defers reset until in-flight initialization settles', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const initialize = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve();
    });
    const gate = createInitializationGate(initialize, vi.fn());

    const first = gate.initialize();
    gate.reset();
    const second = gate.initialize();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(initialize).toHaveBeenCalledTimes(1);
    release?.();
    await expect(first).resolves.toBeUndefined();

    const third = gate.initialize();
    expect(third).not.toBe(first);
    await expect(third).resolves.toBeUndefined();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('catches initialization failures, reports a structured diagnostic, and resolves safely', async () => {
    const failure = new Error('state initialization failed');
    const onFailure = vi.fn();
    const gate = createInitializationGate(async () => {
      throw failure;
    }, onFailure);

    await expect(gate.initialize()).resolves.toBeUndefined();
    await expect(gate.initialize()).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      {
        code: 'APPLICATION_INITIALIZATION_FAILED',
        message: 'The Electron application could not be initialized.',
      },
      failure,
    );
  });

  it('allows a new window initialization after the previous window closes', async () => {
    const initialize = vi.fn(async () => undefined);
    const gate = createInitializationGate(initialize, vi.fn());

    await gate.initialize();
    gate.reset();
    await gate.initialize();

    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('allows a new initialization after a failed initialization settles', async () => {
    const failure = new Error('state initialization failed');
    const initialize = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const gate = createInitializationGate(initialize, vi.fn());

    await gate.initialize();
    gate.reset();
    await gate.initialize();

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
