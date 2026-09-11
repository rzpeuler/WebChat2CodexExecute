import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeLifecycleController,
  createSingleFlightEnsure,
  waitForReconciliationOutput,
} from '../../src/main/automation-runtime.js';
import type { EdgeSolObservation } from '../../src/main/edge/types.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observation(overrides: Partial<EdgeSolObservation> = {}): EdgeSolObservation {
  return {
    targetId: 'target-1',
    title: 'Sol',
    url: 'https://chatgpt.com/g/project/c/conversation',
    projectFingerprint: 'project',
    accountFingerprint: 'account',
    latestAssistantText: 'old',
    latestAssistantHash: 'old-hash',
    statusText: '',
    errorText: '',
    loginWall: false,
    sessionMissing: false,
    contextLimit: false,
    networkError: false,
    isThinking: false,
    writingBlockIncomplete: false,
    sampledAt: new Date(0).toISOString(),
    status: 'COMPLETED_CANDIDATE',
    adapterVersion: 'test',
    consecutiveStableSamples: 2,
    ...overrides,
  };
}

describe('automation runtime lifecycle', () => {
  it('keeps polling while Sol is thinking beyond the old two-minute cutoff', async () => {
    const outputs = [
      observation({
        latestAssistantText: 'partial',
        latestAssistantHash: 'partial-hash',
        status: 'THINKING',
        isThinking: true,
      }),
      observation({
        latestAssistantText: 'partial',
        latestAssistantHash: 'partial-hash',
        status: 'THINKING',
        isThinking: true,
      }),
      observation({ latestAssistantText: 'complete', latestAssistantHash: 'complete-hash' }),
    ];
    const delays: number[] = [];
    let now = 0;
    const result = await waitForReconciliationOutput({
      before: observation(),
      observe: async () => {
        now += 121_000;
        return outputs.shift()!;
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      now: () => now,
    });

    expect(result.latestAssistantText).toBe('complete');
    expect(delays).toEqual([2_000, 2_000, 2_000]);
  });

  it('stops reconciliation polling promptly after the orchestrator is paused', async () => {
    let shouldContinue = true;
    const sleep = vi.fn(async () => {
      shouldContinue = false;
    });

    await expect(
      waitForReconciliationOutput({
        before: observation(),
        observe: vi.fn(async () => observation({ latestAssistantText: 'ignored' })),
        shouldContinue: () => shouldContinue,
        sleep,
      }),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_CANCELLED' });

    expect(sleep).toHaveBeenCalledOnce();
  });

  it('shares concurrent Edge startup and rejects new startup after stop begins', async () => {
    const startup = deferred<void>();
    let starts = 0;
    let blocked = false;
    const ensure = createSingleFlightEnsure(
      async () => {
        starts += 1;
        await startup.promise;
      },
      () => blocked,
    );

    const first = ensure();
    const second = ensure();
    expect(starts).toBe(1);
    startup.resolve();
    await Promise.all([first, second]);

    blocked = true;
    await expect(ensure()).rejects.toMatchObject({ code: 'RUNTIME_STOPPING' });
  });

  it('serializes polling and waits for an in-flight round before closing Edge', async () => {
    const round = deferred<void>();
    let runCount = 0;
    let active = true;
    let busy = true;
    let closed = false;
    const lifecycle = createRuntimeLifecycleController({
      runRound: async () => {
        runCount += 1;
        await round.promise;
        busy = false;
      },
      isActive: () => active,
      isBusy: () => busy,
      pause: async () => {
        active = false;
      },
      close: () => {
        closed = true;
      },
      intervalMs: 1,
    });

    lifecycle.startPolling();
    lifecycle.startPolling();
    await Promise.resolve();
    expect(runCount).toBe(1);

    const stopping = lifecycle.stop();
    expect(closed).toBe(false);
    expect(active).toBe(true);
    round.resolve();
    await stopping;

    expect(closed).toBe(true);
    expect(runCount).toBe(1);
    await lifecycle.stop();
  });

  it('waits for an existing round before entering a mutually exclusive operation', async () => {
    const round = deferred<void>();
    let entered = false;
    const lifecycle = createRuntimeLifecycleController({
      runRound: async () => round.promise,
      isActive: () => true,
      isBusy: () => false,
      pause: async () => undefined,
      close: () => undefined,
      intervalMs: 1,
    });
    lifecycle.startPolling();
    await Promise.resolve();
    const exclusive = lifecycle.withRoundExclusion(async () => {
      entered = true;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    round.resolve();
    await exclusive;
    expect(entered).toBe(true);
    await lifecycle.stop();
  });

  it('drains a tracked dashboard operation even when the command returns before its work is done', async () => {
    const operation = deferred<void>();
    let busy = true;
    let closed = false;
    const lifecycle = createRuntimeLifecycleController({
      runRound: async () => undefined,
      isActive: () => false,
      isBusy: () => busy,
      pause: async () => undefined,
      close: () => {
        closed = true;
      },
    });

    void lifecycle.track(async () => {
      await operation.promise;
      busy = false;
    });
    const stopping = lifecycle.stop();
    expect(closed).toBe(false);
    operation.resolve();
    await stopping;
    expect(closed).toBe(true);
  });

  it('always closes Edge when pause fails and reports the failed stop', async () => {
    let closed = false;
    const pauseError = new Error('pause failed');
    const lifecycle = createRuntimeLifecycleController({
      runRound: async () => undefined,
      isActive: () => true,
      isBusy: () => false,
      pause: async () => {
        throw pauseError;
      },
      close: () => {
        closed = true;
      },
    });

    await expect(lifecycle.stop()).rejects.toBe(pauseError);
    expect(closed).toBe(true);
  });
});
