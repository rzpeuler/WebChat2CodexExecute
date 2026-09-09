import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acquireSingleInstanceLock, type SingleInstanceHost } from './lifecycle/single-instance.js';
import { initializeApplicationState, type ApplicationState } from './lifecycle/application-state.js';
import { createInitializationGate } from './lifecycle/initialization.js';
import { registerIpcHandlers } from './security/ipc.js';
import { SECURE_WINDOW_WEB_PREFERENCES } from './security/window-security.js';
import { AtomicJsonFileStore, JsonlFileEventLog } from './state/persistence.js';
import {
  parsePendingTopLevelStateTransaction,
  type PendingTopLevelStateTransaction,
  type TopLevelStateTransitionEvent,
} from './state/coordinator.js';
import { parseTopLevelState, type TopLevelState } from '../shared/contracts/top-level-state.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let applicationState: ApplicationState | null = null;

function focusMainWindow(): void {
  if (mainWindow === null) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

const singleInstanceHost: SingleInstanceHost = {
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  onSecondInstance: (handler) => {
    app.on('second-instance', handler);
  },
};

if (!acquireSingleInstanceLock(singleInstanceHost, focusMainWindow)) {
  app.quit();
} else {
  const createWindow = async (state: ApplicationState): Promise<void> => {
    const currentState = state.coordinator.getState();
    if (state.recovery.restored) {
      console.info(`[state-recovery] restored ${currentState.status} state at revision ${currentState.revision}`);
    }
    if (state.recovery.requiresUserConfirmation) {
      console.info(
        '[state-recovery] restored state requires explicit user confirmation; automatic execution is disabled',
      );
    }
    if (!ipcRegistered) {
      registerIpcHandlers(ipcMain, app.getVersion());
      ipcRegistered = true;
    }
    mainWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 720,
      minHeight: 480,
      webPreferences: {
        ...SECURE_WINDOW_WEB_PREFERENCES,
        preload: join(appDirectory, 'preload.cjs'),
      },
    });
    await mainWindow.loadFile(join(appDirectory, '../renderer/index.html'));
    mainWindow.on('closed', () => {
      mainWindow = null;
      initializationGate.reset();
    });
  };

  const initializationGate = createInitializationGate(
    async () => {
      if (applicationState === null) {
        const onPersistenceDiagnostic = (diagnostic: unknown): void => {
          console.warn('[persistence] diagnostic', diagnostic);
        };
        const stateStore = new AtomicJsonFileStore<TopLevelState>(
          join(app.getPath('userData'), 'state', 'top-level.json'),
          { validate: parseTopLevelState, onDiagnostic: onPersistenceDiagnostic },
        );
        const eventLog = new JsonlFileEventLog<TopLevelStateTransitionEvent>(
          join(app.getPath('userData'), 'state', 'events.jsonl'),
          { onDiagnostic: onPersistenceDiagnostic },
        );
        const transactionJournal = new AtomicJsonFileStore<PendingTopLevelStateTransaction>(
          join(app.getPath('userData'), 'state', 'top-level-transaction.json'),
          { validate: parsePendingTopLevelStateTransaction, onDiagnostic: onPersistenceDiagnostic },
        );
        applicationState = await initializeApplicationState(
          stateStore,
          {
            eventLog,
            transactionJournal,
            transactionLockPath: join(app.getPath('userData'), 'state', 'top-level-transaction'),
          },
          {
            onDiagnostic: (diagnostic, cause) => {
              console.warn(`[state-recovery] ${diagnostic.code}: ${diagnostic.message}`, cause);
            },
          },
        );
      }
      await createWindow(applicationState);
    },
    (diagnostic, cause) => {
      console.error('[application] initialization failed', { diagnostic, cause });
    },
  );

  void app.whenReady().then(() => initializationGate.initialize());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void initializationGate.initialize();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
