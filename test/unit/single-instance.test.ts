import { describe, expect, it } from 'vitest';
import { acquireSingleInstanceLock, type SingleInstanceHost } from '../../src/main/lifecycle/single-instance.js';

class FakeSingleInstanceHost implements SingleInstanceHost {
  secondInstanceHandler: (() => void) | undefined;

  constructor(private readonly lockAvailable: boolean) {}

  requestSingleInstanceLock(): boolean {
    return this.lockAvailable;
  }

  onSecondInstance(handler: () => void): void {
    this.secondInstanceHandler = handler;
  }
}

describe('single-instance lifecycle', () => {
  it('acquires the lock and registers a second-instance handler', () => {
    const host = new FakeSingleInstanceHost(true);
    const onSecondInstance = () => undefined;

    expect(acquireSingleInstanceLock(host, onSecondInstance)).toBe(true);
    expect(host.secondInstanceHandler).toBe(onSecondInstance);
  });

  it('does not register handlers when another instance owns the lock', () => {
    const host = new FakeSingleInstanceHost(false);

    expect(acquireSingleInstanceLock(host, () => undefined)).toBe(false);
    expect(host.secondInstanceHandler).toBeUndefined();
  });
});
