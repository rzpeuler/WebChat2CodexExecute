import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron';
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

const appDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let applicationState: ApplicationState | null = null;
let automationRuntime: AutomationRuntime | null = null;
let activeRuntimeConfig: ProjectConfig | null = null;
let runtimeWindowGeneration = 0;
let runtimeWindowClosed = true;

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
      const projectConfigService = new ProjectConfigService(projectConfigStore);
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
        const nextRuntime = await createAutomationRuntime(config, app.getPath('userData'), notificationService);
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
    await mainWindow.loadFile(rendererPath);
    mainWindow.on('closed', () => {
      mainWindow = null;
      runtimeWindowClosed = true;
      runtimeWindowGeneration += 1;
      activeRuntimeConfig = null;
      const closingRuntime = automationRuntime;
      if (closingRuntime !== null) {
        void closingRuntime.stop().then(
          () => {
            if (automationRuntime === closingRuntime) automationRuntime = null;
          },
          (error) => {
            notificationService.notify({
              project: 'Web Chat 2 Codex',
              taskId: null,
              phase: 'SHUTDOWN',
              suggestion: '运行时未能安全停止，请保持应用关闭并检查状态后重试。',
              error,
              level: 'FATAL',
            });
          },
        );
      }
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

function configsEqual(left: ProjectConfig, right: ProjectConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
