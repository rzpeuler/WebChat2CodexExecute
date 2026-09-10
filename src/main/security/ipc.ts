import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RuntimeInfo, RendererApi } from '../../shared/contracts/renderer-api.js';
import type { ProjectConfigInput, ProjectConfig } from '../../shared/contracts/project-config.js';
import {
  sanitizeDashboardSnapshot,
  validateDashboardCommand,
  type DashboardCommand,
  type DashboardCommandResult,
  type DashboardSnapshot,
  type DashboardSnapshotSource,
} from '../../shared/contracts/dashboard.js';
import { sanitizeSafeText } from '../../shared/contracts/safe-text.js';
import type { ProjectConfigService } from '../project/config.js';
import type {
  ProjectInitializationInput,
  ProjectInitializationResult,
  ProjectRemoteAccessCheckInput,
  ProjectRemoteAccessCheckResult,
} from '../../shared/contracts/project-initialization.js';

export const RUNTIME_INFO_CHANNEL = 'app:get-runtime-info';
export const PROJECT_DIRECTORY_SELECT_CHANNEL = 'project:directory-select';
export const PROJECT_REMOTE_ACCESS_CHECK_CHANNEL = 'project:remote-access-check';
export const PROJECT_INITIALIZE_CHANNEL = 'project:initialize';
export const PROJECT_SCAN_CHANNEL = 'project:scan';
export const PROJECT_CONFIG_SAVE_CHANNEL = 'project-config:save';
export const PROJECT_CONFIG_LIST_CHANNEL = 'project-config:list';
export const SOL_PROMPT_PREVIEW_CHANNEL = 'sol:prompt-preview';
export const DASHBOARD_SNAPSHOT_CHANNEL = 'dashboard:get-snapshot';
export const DASHBOARD_COMMAND_CHANNEL = 'dashboard:command';

export interface DashboardIpcOptions {
  getSnapshot?: () =>
    DashboardSnapshotSource | DashboardSnapshot | Promise<DashboardSnapshotSource | DashboardSnapshot>;
  executeCommand?: (command: DashboardCommand) => DashboardCommandResult | Promise<DashboardCommandResult>;
}

export interface ProjectInitializationIpcOptions {
  selectDirectory?: () => Promise<string | null>;
  checkRemoteAccess?: (
    input: ProjectRemoteAccessCheckInput,
  ) => ProjectRemoteAccessCheckResult | Promise<ProjectRemoteAccessCheckResult>;
  initialize?: (
    input: ProjectInitializationInput,
  ) => ProjectInitializationResult | Promise<ProjectInitializationResult>;
}

export interface IpcHandlerOptions {
  trustedRendererUrl: string;
  getTrustedWindow?: () => BrowserWindow | null;
  onProjectConfigSaved?: (config: ProjectConfig) => void | Promise<void>;
  dashboard?: DashboardIpcOptions;
  projectInitialization?: ProjectInitializationIpcOptions;
}

export class IpcSecurityError extends Error {
  readonly code: 'IPC_UNAUTHORIZED' | 'IPC_INVALID_ARGUMENT';

  constructor(code: 'IPC_UNAUTHORIZED' | 'IPC_INVALID_ARGUMENT', message: string) {
    super(message);
    this.name = 'IpcSecurityError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTrustedSender(event: IpcMainInvokeEvent, options: IpcHandlerOptions): void {
  const senderFrame = event.senderFrame;
  if (senderFrame === null || senderFrame !== event.sender.mainFrame) {
    throw new IpcSecurityError('IPC_UNAUTHORIZED', 'IPC requests must come from the main frame');
  }
  const trustedWindow = options.getTrustedWindow?.();
  if (trustedWindow !== undefined && (trustedWindow === null || trustedWindow.webContents !== event.sender)) {
    throw new IpcSecurityError('IPC_UNAUTHORIZED', 'IPC sender is not the trusted main window');
  }
  if (senderFrame.url !== options.trustedRendererUrl) {
    throw new IpcSecurityError('IPC_UNAUTHORIZED', 'IPC sender is not the trusted renderer document');
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', `${field} must be a non-empty string`);
  }
}

function assertProjectConfigInput(value: unknown): asserts value is ProjectConfigInput {
  if (!isRecord(value)) {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'Project config must be an object');
  }
  assertNonEmptyString(value.localPath, 'localPath');
  assertNonEmptyString(value.reportDirectory, 'reportDirectory');
  for (const field of ['projectId', 'targetBranch', 'currentBranch', 'headCommit', 'governanceManifestPath']) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], field);
  }
  if (value.remoteUrl !== undefined && value.remoteUrl !== null && typeof value.remoteUrl !== 'string') {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'remoteUrl must be a string or null');
  }
}

function assertProjectInitializationInput(value: unknown): asserts value is ProjectInitializationInput {
  if (!isRecord(value) || (value.mode !== 'clone' && value.mode !== 'adopt')) {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'Project initialization input is invalid');
  }
  if (value.mode === 'clone') {
    assertNonEmptyString(value.parentDirectory, 'parentDirectory');
    assertNonEmptyString(value.directoryName, 'directoryName');
    assertNonEmptyString(value.remoteUrl, 'remoteUrl');
    if (value.targetBranch !== undefined) assertNonEmptyString(value.targetBranch, 'targetBranch');
  } else {
    assertNonEmptyString(value.targetDirectory, 'targetDirectory');
  }
}

function assertProjectRemoteAccessCheckInput(value: unknown): asserts value is ProjectRemoteAccessCheckInput {
  if (!isRecord(value)) throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'Remote access check input is invalid');
  assertNonEmptyString(value.directory, 'directory');
  assertNonEmptyString(value.remoteUrl, 'remoteUrl');
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  version: string,
  projectConfigService: ProjectConfigService | undefined,
  options: IpcHandlerOptions,
): void {
  ipcMain.handle(RUNTIME_INFO_CHANNEL, (event): RuntimeInfo => {
    assertTrustedSender(event, options);
    return {
      appName: 'Web Chat 2 Codex',
      version,
    };
  });
  ipcMain.handle(DASHBOARD_SNAPSHOT_CHANNEL, async (event): Promise<DashboardSnapshot> => {
    assertTrustedSender(event, options);
    const source = await options.dashboard?.getSnapshot?.();
    return sanitizeDashboardSnapshot(source ?? {});
  });
  ipcMain.handle(DASHBOARD_COMMAND_CHANNEL, async (event, value: unknown): Promise<DashboardCommandResult> => {
    assertTrustedSender(event, options);
    let command: DashboardCommand;
    try {
      command = validateDashboardCommand(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid dashboard command';
      throw new IpcSecurityError('IPC_INVALID_ARGUMENT', message);
    }
    if (options.dashboard?.executeCommand === undefined) {
      return {
        accepted: false,
        code: 'DASHBOARD_COMMAND_UNAVAILABLE',
        message: '当前应用未连接自动化命令执行器',
      };
    }
    try {
      const result = await options.dashboard.executeCommand(command);
      return {
        accepted: result.accepted === true,
        code: sanitizeSafeText(result.code, 64) || 'DASHBOARD_COMMAND_RESULT',
        message: sanitizeSafeText(result.message, 240) || '命令已处理',
      };
    } catch (error) {
      return {
        accepted: false,
        code: 'DASHBOARD_COMMAND_FAILED',
        message: sanitizeSafeText(error instanceof Error ? error.message : '命令执行失败', 240) || '命令执行失败',
      };
    }
  });
  ipcMain.handle(PROJECT_DIRECTORY_SELECT_CHANNEL, async (event): Promise<string | null> => {
    assertTrustedSender(event, options);
    if (options.projectInitialization?.selectDirectory === undefined) return null;
    return options.projectInitialization.selectDirectory();
  });
  ipcMain.handle(
    PROJECT_REMOTE_ACCESS_CHECK_CHANNEL,
    async (event, value: unknown): Promise<ProjectRemoteAccessCheckResult> => {
      assertTrustedSender(event, options);
      assertProjectRemoteAccessCheckInput(value);
      if (options.projectInitialization?.checkRemoteAccess === undefined) {
        throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'Remote access check is unavailable');
      }
      return options.projectInitialization.checkRemoteAccess(value);
    },
  );
  ipcMain.handle(PROJECT_INITIALIZE_CHANNEL, async (event, value: unknown): Promise<ProjectInitializationResult> => {
    assertTrustedSender(event, options);
    assertProjectInitializationInput(value);
    if (options.projectInitialization?.initialize === undefined) {
      throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'Project initialization is unavailable');
    }
    return options.projectInitialization.initialize(value);
  });
  if (projectConfigService === undefined) {
    return;
  }
  ipcMain.handle(PROJECT_SCAN_CHANNEL, (event, localPath: unknown) => {
    assertTrustedSender(event, options);
    assertNonEmptyString(localPath, 'localPath');
    return projectConfigService.scan(localPath);
  });
  ipcMain.handle(PROJECT_CONFIG_SAVE_CHANNEL, async (event, config: unknown) => {
    assertTrustedSender(event, options);
    assertProjectConfigInput(config);
    const saved = await projectConfigService.save(config);
    void options.onProjectConfigSaved?.(saved);
    return saved;
  });
  ipcMain.handle(PROJECT_CONFIG_LIST_CHANNEL, (event) => {
    assertTrustedSender(event, options);
    return projectConfigService.loadAll();
  });
  ipcMain.handle(SOL_PROMPT_PREVIEW_CHANNEL, (event, config: unknown) => {
    assertTrustedSender(event, options);
    assertProjectConfigInput(config);
    return projectConfigService.previewSolPrompt(config);
  });
}

export type ControlledProjectApi = Pick<
  RendererApi,
  'scanProject' | 'saveProjectConfig' | 'loadProjectConfigs' | 'previewSolPrompt'
>;
