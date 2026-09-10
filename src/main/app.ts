import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { acquireSingleInstanceLock, type SingleInstanceHost } from './lifecycle/single-instance.js';
import { initializeApplicationState, type ApplicationState } from './lifecycle/application-state.js';
import { createInitializationGate } from './lifecycle/initialization.js';
import { registerIpcHandlers } from './security/ipc.js';
import { attachWindowSecurityHandlers, SECURE_WINDOW_WEB_PREFERENCES } from './security/window-security.js';
import { AtomicJsonFileStore, JsonlFileEventLog } from './state/persistence.js';
import {
  parsePendingTopLevelStateTransaction,
  type PendingTopLevelStateTransaction,
  type TopLevelStateTransitionEvent,
} from './state/coordinator.js';
import { parseTopLevelState, type TopLevelState } from '../shared/contracts/top-level-state.js';
import { createProjectConfigStore, defaultProjectConfigPath, ProjectConfigService } from './project/config.js';
import { NotificationService } from './notify/index.js';
import { createAutomationRuntime, type AutomationRuntime } from './automation-runtime.js';
import type { ProjectConfig } from '../shared/contracts/project-config.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let applicationState: ApplicationState | null = null;
let automationRuntime: AutomationRuntime | null = null;

const notificationService = new NotificationService(({ title, body }) => new Notification({ title, body }), {
  logger: (event, details) => console.warn(`[notification] ${event}`, details),
});

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
    const rendererPath = join(appDirectory, '../renderer/index.html');
    const trustedRendererUrl = pathToFileURL(rendererPath).toString();
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
      const projectConfigStore = createProjectConfigStore(defaultProjectConfigPath(app.getPath('userData')));
      const projectConfigService = new ProjectConfigService(projectConfigStore);
      const installRuntime = async (config: ProjectConfig): Promise<void> => {
        automationRuntime?.stop();
        automationRuntime = await createAutomationRuntime(config, app.getPath('userData'), notificationService);
        automationRuntime.startPolling();
      };
      const savedConfigs = await projectConfigService.loadAll();
      if (savedConfigs[0] !== undefined) {
        void installRuntime(savedConfigs[0]).catch((error) => {
          notificationService.notify({
            project: savedConfigs[0]?.projectId ?? 'Web Chat 2 Codex',
            taskId: null,
            phase: 'INITIALIZATION',
            suggestion: '请检查项目配置后重试。',
            error,
            level: 'NEEDS_USER',
          });
        });
      }
      registerIpcHandlers(ipcMain, app.getVersion(), projectConfigService, {
        trustedRendererUrl,
        getTrustedWindow: () => mainWindow,
        onProjectConfigSaved: (config) =>
          installRuntime(config).catch((error) => {
            notificationService.notify({
              project: config.projectId,
              taskId: null,
              phase: 'INITIALIZATION',
              suggestion: '请检查项目配置后重试。',
              error,
              level: 'NEEDS_USER',
            });
          }),
        dashboard: {
          getSnapshot: () => {
            if (automationRuntime !== null) return automationRuntime.orchestrator.getDashboardSnapshot();
            const current = state.coordinator.getState();
            return {
              revision: current.revision,
              updatedAt: current.updatedAt,
              status: current.status,
              taskId: current.activeTaskId,
              recentError: current.lastError,
            };
          },
          executeCommand: async (command) =>
            automationRuntime === null
              ? {
                  accepted: false,
                  code: 'DASHBOARD_COMMAND_UNAVAILABLE',
                  message: '请先保存项目配置并完成 Sol 会话绑定。',
                }
              : automationRuntime.orchestrator.executeCommand(command),
        },
      });
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
    attachWindowSecurityHandlers(mainWindow, trustedRendererUrl);
    await mainWindow.loadFile(rendererPath);
    mainWindow.on('closed', () => {
      mainWindow = null;
      automationRuntime?.stop();
      automationRuntime = null;
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
      notificationService.notify({
        project: 'Web Chat 2 Codex',
        taskId: null,
        phase: 'initialization',
        suggestion: '检查应用状态后重试。',
        error: cause,
        level: 'FATAL',
      });
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
