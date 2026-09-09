export interface ApplicationInitializationDiagnostic {
  code: 'APPLICATION_INITIALIZATION_FAILED';
  message: string;
}

export interface InitializationGate {
  initialize(): Promise<void>;
  reset(): void;
}

export function createInitializationGate(
  initialize: () => Promise<void>,
  onFailure: (diagnostic: ApplicationInitializationDiagnostic, cause: unknown) => void,
): InitializationGate {
  let initializationPromise: Promise<void> | null = null;
  let initializationSettled = false;
  let resetRequested = false;

  const settleInitialization = (promise: Promise<void>, failed: boolean): void => {
    if (initializationPromise !== promise) {
      return;
    }
    initializationSettled = true;
    if (resetRequested || failed) {
      initializationPromise = null;
      initializationSettled = false;
      resetRequested = false;
    }
  };

  return {
    initialize: (): Promise<void> => {
      if (initializationPromise === null) {
        let failed = false;
        const promise = Promise.resolve()
          .then(initialize)
          .catch((error: unknown) => {
            failed = true;
            const diagnostic: ApplicationInitializationDiagnostic = {
              code: 'APPLICATION_INITIALIZATION_FAILED',
              message: 'The Electron application could not be initialized.',
            };
            try {
              onFailure(diagnostic, error);
            } catch {
              // Diagnostic reporting must not turn a handled initialization failure
              // back into an unhandled rejection.
            }
          });
        initializationPromise = promise;
        void promise.then(
          () => settleInitialization(promise, failed),
          () => settleInitialization(promise, failed),
        );
      }
      return initializationPromise;
    },
    reset: (): void => {
      if (initializationPromise === null) {
        return;
      }
      if (!initializationSettled) {
        resetRequested = true;
        return;
      }
      initializationPromise = null;
      initializationSettled = false;
      resetRequested = false;
    },
  };
}
