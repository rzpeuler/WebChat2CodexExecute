import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, Tray } from 'electron';
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
import {
  assertProjectConfigMatchesScan,
  createProjectConfigStore,
  defaultProjectConfigPath,
  ProjectConfigError,
  ProjectConfigService,
} from './project/config.js';
import { NotificationService } from './notify/index.js';
import { createAutomationRuntime, type AutomationRuntime } from './automation-runtime.js';
import type { ProjectConfig } from '../shared/contracts/project-config.js';
import { ProjectInitializer } from './project/initializer.js';
import type {
  ProjectInitializationInput,
  ProjectInitializationResult,
  ProjectRemoteAccessCheckInput,
} from '../shared/contracts/project-initialization.js';
import { GitController } from './git/index.js';
import { migrateMissingUserData, stableUserDataDirectory } from './lifecycle/user-data.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));
app.setName('web-chat2codex-exe');
const legacyUserDataDirectory = app.getPath('userData');
const stableUserDataPath = stableUserDataDirectory(app.getPath('appData'));
app.setPath('userData', stableUserDataPath);
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let applicationState: ApplicationState | null = null;
let automationRuntime: AutomationRuntime | null = null;
let activeRuntimeConfig: ProjectConfig | null = null;
let runtimeWindowGeneration = 0;
let runtimeWindowClosed = true;
let tray: Tray | null = null;
let isQuitting = false;
let quitPromise: Promise<void> | null = null;

const notificationService = new NotificationService(({ title, body }) => new Notification({ title, body }), {
  logger: (event, details) => console.warn(`[notification] ${event}`, details),
});

interface LastProjectSelection {
  schemaVersion: 1;
  projectId: string;
}

function parseLastProjectSelection(value: unknown): LastProjectSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid last project selection.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.projectId !== 'string' || record.projectId.trim() === '') {
    throw new TypeError('Invalid last project selection.');
  }
  return { schemaVersion: 1, projectId: record.projectId };
}

function focusMainWindow(): void {
  if (mainWindow === null) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  void automationRuntime?.showEdge().catch((error) => console.warn('[tray] Edge restore failed', error));
}

function hideToTray(): void {
  mainWindow?.hide();
  void automationRuntime?.hideEdge().catch((error) => console.warn('[tray] Edge hide failed', error));
}

function trayIcon(): Electron.NativeImage {
  const svg = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#2563eb"/><path d="M4 5h8M4 8h8M4 11h5" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>',
  );
  return nativeImage.createFromDataURL(`data:image/svg+xml,${svg}`);
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
    runtimeWindowGeneration += 1;
    runtimeWindowClosed = false;
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
      const lastProjectSelectionStore = new AtomicJsonFileStore<LastProjectSelection>(
        join(app.getPath('userData'), 'last-project.json'),
        { validate: parseLastProjectSelection },
      );
      const projectConfigService = new ProjectConfigService(projectConfigStore, {
        load: async () => (await lastProjectSelectionStore.load())?.projectId ?? null,
        save: async (projectId) => lastProjectSelectionStore.save({ schemaVersion: 1, projectId }),
      });
      const projectInitializer = new ProjectInitializer();
      const initializationGit = new GitController({
        pendingPushStatePath: join(app.getPath('userData'), 'state', 'initialization-git-pending-push.json'),
      });
      let repositoryOperationTail: Promise<void> = Promise.resolve();

      const stopRuntime = async (): Promise<void> => {
        const previousRuntime = automationRuntime;
        if (previousRuntime === null) return;
        await previousRuntime.stop();
        if (automationRuntime === previousRuntime) {
          automationRuntime = null;
          activeRuntimeConfig = null;
        }
      };

      const requestQuit = (): Promise<void> => {
        if (quitPromise !== null) return quitPromise;
        quitPromise = (async () => {
          const snapshot = automationRuntime?.orchestrator.getDashboardSnapshot();
          const running = snapshot?.status === 'RUNNING' || snapshot?.stage === 'RUNNING_LUNA';
          if (running) {
            const lunaRunning = snapshot?.stage === 'RUNNING_LUNA';
            const confirmationOptions: Electron.MessageBoxOptions = {
              type: 'warning',
              title: '确认退出 Web Chat 2 Codex',
              buttons: ['取消退出', '确认退出'],
              defaultId: 0,
              cancelId: 0,
              message: lunaRunning ? 'Luna 正在执行任务，确认完全退出吗？' : '自动循环正在运行，确认完全退出吗？',
              detail: lunaRunning
                ? '退出会停止当前 Luna 执行并保存中断状态；下次启动后可按恢复状态继续。'
                : '退出会停止自动循环、保存当前状态并关闭专用 Edge。',
            };
            const confirmation =
              mainWindow === null
                ? await dialog.showMessageBox(confirmationOptions)
                : await dialog.showMessageBox(mainWindow, confirmationOptions);
            if (confirmation.response !== 1) return;
          }

          isQuitting = true;
          try {
            await stopRuntime();
            tray?.destroy();
            tray = null;
            app.quit();
          } catch (error) {
            isQuitting = false;
            const errorOptions = {
              type: 'error',
              title: '退出未完成',
              message: '后台进程未能安全停止，软件保持运行。',
              detail: error instanceof Error ? error.message : String(error),
            } as const;
            if (mainWindow === null) await dialog.showMessageBox(errorOptions);
            else await dialog.showMessageBox(mainWindow, errorOptions);
          }
        })().finally(() => {
          if (!isQuitting) quitPromise = null;
        });
        return quitPromise;
      };

      app.on('before-quit', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        void requestQuit();
      });

      tray = new Tray(trayIcon());
      tray.setToolTip('Web Chat 2 Codex');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 W2C', click: focusMainWindow },
          {
            label: '显示专用 Edge',
            click: () =>
              void automationRuntime?.showEdge().catch((error) => console.warn('[tray] Edge restore failed', error)),
          },
          { type: 'separator' },
          { label: '退出 W2C', click: () => void requestQuit() },
        ]),
      );
      tray.on('double-click', focusMainWindow);

      const installRuntime = async (config: ProjectConfig, generation: number): Promise<void> => {
        if (runtimeWindowClosed || generation !== runtimeWindowGeneration) return;
        let scan;
        try {
          scan = await projectConfigService.scan(config.localPath);
        } catch (error) {
          const code = error instanceof ProjectConfigError ? error.code : 'INVALID_PROJECT_CONFIG';
          throw new ProjectConfigError(code, `持久化项目配置启动前扫描失败，未启动自动循环。错误码=${code}。`, {
            cause: error,
          });
        }
        assertProjectConfigMatchesScan(config, scan);
        if (automationRuntime !== null && activeRuntimeConfig !== null && configsEqual(activeRuntimeConfig, config)) {
          return;
        }
        await stopRuntime();
        if (runtimeWindowClosed || generation !== runtimeWindowGeneration) return;
        const nextRuntime = await createAutomationRuntime(config, app.getPath('userData'), notificationService, {
          baselineRefreshed: async (baseline) => {
            const refreshed = await projectConfigService.save({
              ...config,
              currentBranch: baseline.branch,
              headCommit: baseline.head,
            });
            Object.assign(config, refreshed);
          },
        });
        if (runtimeWindowClosed || generation !== runtimeWindowGeneration) {
          await nextRuntime.stop();
          return;
        }
        automationRuntime = nextRuntime;
        activeRuntimeConfig = config;
        nextRuntime.startPolling();
      };
      const enqueueRuntimeInstall = (config: ProjectConfig): Promise<void> => {
        const generation = runtimeWindowGeneration;
        const operation = repositoryOperationTail.then(() => installRuntime(config, generation));
        repositoryOperationTail = operation.catch(() => undefined);
        return operation;
      };
      const initializeProject = (input: ProjectInitializationInput): Promise<ProjectInitializationResult> => {
        const operation = repositoryOperationTail.then(() => initializeProjectOnce(input));
        repositoryOperationTail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      };
      const initializeProjectOnce = async (input: ProjectInitializationInput): Promise<ProjectInitializationResult> => {
        // Git initialization must not overlap a runtime round for any project;
        // the runtime is restarted only after a later config-save install.
        await stopRuntime();
        if (input.mode === 'adopt') {
          // Refuse before touching the project when an existing repository
          // has unapproved work or cannot be verified against its remote.
          await initializationGit.captureBaseline(input.targetDirectory, { requireClean: true });
        }
        const initialized = await projectInitializer.initialize(input);
        if (initialized.changedPaths.length === 0 && initialized.idempotent) {
          const sync = await initializationGit.syncInitialization({
            repositoryPath: initialized.projectRoot,
            changedPaths: [],
            ...(input.mode === 'clone' && input.targetBranch === undefined
              ? {}
              : input.mode === 'clone'
                ? { targetBranch: input.targetBranch }
                : {}),
            ...(input.mode === 'clone' ? { expectedRemoteUrl: input.remoteUrl } : {}),
          });
          return {
            ...initialized,
            commit: sync.commit,
            remoteCommit: sync.remoteCommit,
          };
        }
        if (initialized.changedPaths.length === 0) return initialized;
        let sync;
        try {
          const baseline = await initializationGit.captureBaseline(initialized.projectRoot, {
            requireClean: false,
          });
          sync = await initializationGit.syncGovernance({
            baseline,
            changeId: 'initialize',
            changedPaths: initialized.changedPaths,
          });
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'NO_HEAD') throw error;
          sync = await initializationGit.syncInitialization({
            repositoryPath: initialized.projectRoot,
            changedPaths: initialized.changedPaths,
            ...(input.mode === 'clone' && input.targetBranch === undefined
              ? {}
              : input.mode === 'clone'
                ? { targetBranch: input.targetBranch }
                : {}),
            ...(input.mode === 'clone' ? { expectedRemoteUrl: input.remoteUrl } : {}),
          });
        }
        return {
          ...initialized,
          commit: sync.commit,
          remoteCommit: sync.remoteCommit,
        };
      };
      const savedConfigs = await projectConfigService.loadAll();
      if (savedConfigs[0] !== undefined) {
        void enqueueRuntimeInstall(savedConfigs[0]).catch((error) => {
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
        projectInitialization: {
          selectDirectory: async () => {
            const dialogOptions = {
              properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
              title: '选择项目目录',
            };
            const selected =
              mainWindow === null
                ? await dialog.showOpenDialog(dialogOptions)
                : await dialog.showOpenDialog(mainWindow, dialogOptions);
            return selected.canceled ? null : (selected.filePaths[0] ?? null);
          },
          checkRemoteAccess: (input: ProjectRemoteAccessCheckInput) => projectInitializer.checkRemoteAccess(input),
          initialize: (input: ProjectInitializationInput) => initializeProject(input),
        },
        onProjectConfigSaved: (config) =>
          enqueueRuntimeInstall(config).catch((error) => {
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
              : automationRuntime.executeCommand(command),
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
    mainWindow.on('close', (event) => {
      if (isQuitting) return;
      event.preventDefault();
      hideToTray();
    });
    await mainWindow.loadFile(rendererPath);
    mainWindow.on('closed', () => {
      mainWindow = null;
      runtimeWindowClosed = true;
      runtimeWindowGeneration += 1;
      activeRuntimeConfig = null;
      initializationGate.reset();
    });
  };

  const initializationGate = createInitializationGate(
    async () => {
      await migrateMissingUserData(stableUserDataPath, [
        legacyUserDataDirectory,
        join(app.getPath('appData'), 'Web Chat 2 Codex'),
        join(app.getPath('appData'), 'Web-Chat-2-Codex'),
        join(app.getPath('appData'), 'Electron'),
      ]);
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

  app.on('window-all-closed', () => undefined);
}

function configsEqual(left: ProjectConfig, right: ProjectConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
