import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acquireSingleInstanceLock, type SingleInstanceHost } from './lifecycle/single-instance.js';
import { registerIpcHandlers } from './security/ipc.js';
import { SECURE_WINDOW_WEB_PREFERENCES } from './security/window-security.js';
import { AtomicJsonFileStore } from './state/persistence.js';
import { recoverTopLevelState, type StartupRecoveryResult } from './state/startup-recovery.js';
import { parseTopLevelState, type TopLevelState } from '../shared/contracts/top-level-state.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;

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
  const createWindow = async (recovery: StartupRecoveryResult): Promise<void> => {
    if (recovery.restored) {
      console.info(`[state-recovery] restored ${recovery.state.status} state at revision ${recovery.state.revision}`);
    }
    if (recovery.requiresUserConfirmation) {
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
    });
  };

  const initializeApplication = async (): Promise<void> => {
    const stateStore = new AtomicJsonFileStore<TopLevelState>(
      join(app.getPath('userData'), 'state', 'top-level.json'),
      { validate: parseTopLevelState },
    );
    const recovery = await recoverTopLevelState(stateStore, {
      onDiagnostic: (diagnostic, cause) => {
        console.warn(`[state-recovery] ${diagnostic.code}: ${diagnostic.message}`, cause);
      },
    });
    await createWindow(recovery);
  };

  void app.whenReady().then(initializeApplication);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void initializeApplication();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
