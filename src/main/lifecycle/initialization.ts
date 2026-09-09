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

  return {
    initialize: (): Promise<void> => {
      if (initializationPromise === null) {
        initializationPromise = Promise.resolve()
          .then(initialize)
          .catch((error: unknown) => {
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
      }
      return initializationPromise;
    },
    reset: (): void => {
      initializationPromise = null;
    },
  };
}
