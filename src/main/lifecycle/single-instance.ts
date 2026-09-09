export interface SingleInstanceHost {
  requestSingleInstanceLock(): boolean;
  onSecondInstance(handler: () => void): void;
}

export function acquireSingleInstanceLock(host: SingleInstanceHost, onSecondInstance: () => void): boolean {
  const acquired = host.requestSingleInstanceLock();
  if (!acquired) {
    return false;
  }

  host.onSecondInstance(onSecondInstance);
  return true;
}
